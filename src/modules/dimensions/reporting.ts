import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, dimensionValues, dimensions, journalEntries, journalLines } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { AccountType } from '@/modules/coa/standard'
import { isDebitNormal, normalBalance } from '@/modules/ledger/balances'
import { Refusal } from '@/modules/errors'

/**
 * Reporting across a dimension (spec §13).
 *
 * ## The claim: the parts sum to the whole
 *
 * A dimensional profit and loss is a P&L with one column per value of a
 * dimension. The only property that makes it worth printing is that reading
 * across a row gives you the same number the ordinary P&L gives you for that
 * account. If the columns sum to something else, every figure on the page is
 * wrong by an amount nobody can determine, and the report is worse than not
 * having one — because it looks like an answer.
 *
 * Two things make it hold, and neither is arithmetic:
 *
 *  1. `unique(journal_line_id, dimension_id)` in the schema. A line cannot
 *     carry two Locations, so it cannot be counted in two columns.
 *  2. **Unassigned is a column.** Every line that carries no value for this
 *     dimension is gathered into it and shown. The tempting alternative —
 *     filtering to lines that *have* a value — produces a page that is
 *     internally consistent, adds up to less than the business earned, and
 *     gives no hint of by how much.
 *
 * `totalsAgree` is computed on every report and `tests/dimensions.test.ts`
 * asserts it against an independent P&L.
 */

export type DimensionColumn = {
  /** Null for the Unassigned column. */
  valueId: string | null
  code: string
  name: string
  parentId: string | null
}

export type DimensionalRow = {
  chartAccountId: string
  number: string
  name: string
  type: AccountType
  /** Signed in the account's normal direction, per column, in column order. */
  amountsCents: number[]
  /** The row's total — what an ordinary P&L shows for this account. */
  totalCents: number
}

export type DimensionalProfitAndLoss = {
  dimension: { id: string; name: string; code: string }
  startDate: string
  endDate: string
  /** Ends with the Unassigned column when anything is unassigned. */
  columns: DimensionColumn[]
  revenue: DimensionalRow[]
  costOfSales: DimensionalRow[]
  operatingExpenses: DimensionalRow[]
  otherIncome: DimensionalRow[]
  otherExpenses: DimensionalRow[]
  /** Net income per column, in column order. */
  netIncomeCents: number[]
  netIncomeTotalCents: number
  /**
   * True when every row's columns sum to its total. False can only mean a line
   * carried two values for one dimension, which the unique index forbids — so
   * a false here is a corrupted database rather than a reporting bug, and it
   * is surfaced rather than swallowed.
   */
  totalsAgree: boolean
  /** How much of the period's activity carries a value. See `coverage`. */
  coverage: DimensionCoverage
}

export type DimensionCoverage = {
  /** Absolute profit-and-loss movement carrying a value for this dimension. */
  assignedCents: number
  /** Absolute profit-and-loss movement carrying none. */
  unassignedCents: number
  /** Assigned over the total, in basis points. Null when there is no activity. */
  basisPointsAssigned: number | null
}

const PL_TYPES: AccountType[] = ['revenue', 'cogs', 'expense', 'other_income', 'other_expense']

/**
 * A profit and loss broken out by one dimension.
 *
 * Accrual basis only, and deliberately: the cash-basis engine restates entries
 * by walking payment applications back to the documents that produced them
 * (ADR 0012), and a restated figure has no single journal line to inherit a
 * dimension from. Offering a cash-basis dimensional report would mean
 * inventing the attribution. `basisNote` on the screen says so rather than
 * leaving somebody to assume the toggle applies here too.
 */
export async function dimensionalProfitAndLoss(
  ctx: ActorContext,
  input: { dimensionId: string; startDate: string; endDate: string },
): Promise<DimensionalProfitAndLoss> {
  requirePermission(ctx, 'reports:financial')

  const [dimension] = await db
    .select({ id: dimensions.id, name: dimensions.name, code: dimensions.code })
    .from(dimensions)
    .where(scoped(ctx, dimensions, eq(dimensions.id, input.dimensionId)))
    .limit(1)

  if (!dimension) throw new Refusal('That dimension does not exist on these books.')

  const [values, cells] = await Promise.all([
    db
      .select({
        id: dimensionValues.id,
        code: dimensionValues.code,
        name: dimensionValues.name,
        parentId: dimensionValues.parentId,
      })
      .from(dimensionValues)
      .where(scoped(ctx, dimensionValues, eq(dimensionValues.dimensionId, input.dimensionId)))
      .orderBy(asc(dimensionValues.sortOrder), asc(dimensionValues.code)),

    dimensionalCells(ctx, input),
  ])

  // A value with no activity in the period is dropped: a page of empty columns
  // for sites that opened last month is harder to read, not more complete.
  const active = new Set(cells.map((cell) => cell.valueId).filter(Boolean) as string[])
  const columns: DimensionColumn[] = values
    .filter((value) => active.has(value.id))
    .map((value) => ({
      valueId: value.id,
      code: value.code,
      name: value.name,
      parentId: value.parentId,
    }))

  const hasUnassigned = cells.some((cell) => cell.valueId === null)
  if (hasUnassigned) {
    columns.push({ valueId: null, code: '—', name: 'Unassigned', parentId: null })
  }

  const index = new Map(columns.map((column, i) => [column.valueId, i]))
  const byAccount = new Map<string, DimensionalRow>()

  for (const cell of cells) {
    let row = byAccount.get(cell.chartAccountId)
    if (!row) {
      row = {
        chartAccountId: cell.chartAccountId,
        number: cell.number,
        name: cell.name,
        type: cell.type,
        amountsCents: columns.map(() => 0),
        totalCents: 0,
      }
      byAccount.set(cell.chartAccountId, row)
    }

    const at = index.get(cell.valueId)
    if (at === undefined) continue

    const amount = normalBalance(cell.type, cell.debitCents, cell.creditCents)
    row.amountsCents[at] += amount
    row.totalCents += amount
  }

  const rows = [...byAccount.values()]
    .filter((row) => row.totalCents !== 0 || row.amountsCents.some((amount) => amount !== 0))
    .sort((a, b) => a.number.localeCompare(b.number))

  const ofType = (...types: AccountType[]) => rows.filter((row) => types.includes(row.type))

  const revenue = ofType('revenue')
  const costOfSales = ofType('cogs')
  const operatingExpenses = ofType('expense')
  const otherIncome = ofType('other_income')
  const otherExpenses = ofType('other_expense')

  // Net income per column: income less costs, computed column by column so a
  // location's bottom line is its own rather than a share of the company's.
  const netIncomeCents = columns.map((_, i) => {
    const sum = (set: DimensionalRow[]) => set.reduce((total, row) => total + row.amountsCents[i], 0)
    return (
      sum(revenue) - sum(costOfSales) - sum(operatingExpenses) + sum(otherIncome) - sum(otherExpenses)
    )
  })

  const totalsAgree = rows.every(
    (row) => row.amountsCents.reduce((sum, amount) => sum + amount, 0) === row.totalCents,
  )

  return {
    dimension,
    startDate: input.startDate,
    endDate: input.endDate,
    columns,
    revenue,
    costOfSales,
    operatingExpenses,
    otherIncome,
    otherExpenses,
    netIncomeCents,
    netIncomeTotalCents: netIncomeCents.reduce((sum, amount) => sum + amount, 0),
    totalsAgree,
    coverage: coverageFrom(cells),
  }
}

type Cell = {
  chartAccountId: string
  number: string
  name: string
  type: AccountType
  valueId: string | null
  debitCents: number
  creditCents: number
}

/**
 * Sums posted profit-and-loss lines by account and dimension value.
 *
 * A LEFT JOIN filtered to this dimension, so a line with no value produces one
 * row with `valueId` null rather than disappearing — which is the whole reason
 * the Unassigned column can exist. Filtering the dimension in the WHERE clause
 * instead would turn the outer join back into an inner one and drop exactly
 * the lines the report most needs to show.
 */
async function dimensionalCells(
  ctx: ActorContext,
  input: { dimensionId: string; startDate: string; endDate: string },
): Promise<Cell[]> {
  const rows = await db
    .select({
      chartAccountId: journalLines.chartAccountId,
      number: chartAccounts.number,
      name: chartAccounts.name,
      type: chartAccounts.type,
      valueId: sql<string | null>`d.dimension_value_id`,
      debitCents: sql<string>`sum(${journalLines.debitCents})`,
      creditCents: sql<string>`sum(${journalLines.creditCents})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .leftJoin(
      sql`journal_line_dimensions d`,
      sql`d.journal_line_id = ${journalLines.id} AND d.dimension_id = ${input.dimensionId}`,
    )
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.entryDate} >= ${input.startDate}`,
        sql`${journalEntries.entryDate} <= ${input.endDate}`,
        sql`${chartAccounts.type} IN ('revenue', 'cogs', 'expense', 'other_income', 'other_expense')`,
      ),
    )
    .groupBy(
      journalLines.chartAccountId,
      chartAccounts.number,
      chartAccounts.name,
      chartAccounts.type,
      sql`d.dimension_value_id`,
    )

  return rows.map((row) => ({
    chartAccountId: row.chartAccountId,
    number: row.number,
    name: row.name,
    type: row.type as AccountType,
    valueId: row.valueId,
    debitCents: Number(row.debitCents),
    creditCents: Number(row.creditCents),
  }))
}

/**
 * How much of a period's activity carries a value.
 *
 * Measured on gross movement rather than net, because netting hides the
 * problem it is meant to expose: a site with $50,000 of unassigned revenue and
 * $50,000 of unassigned costs nets to zero, and "100% covered" would be a lie
 * about $100,000 nobody can attribute.
 */
function coverageFrom(cells: Cell[]): DimensionCoverage {
  let assignedCents = 0
  let unassignedCents = 0

  for (const cell of cells) {
    const gross = Math.abs(cell.debitCents - cell.creditCents)
    if (cell.valueId === null) unassignedCents += gross
    else assignedCents += gross
  }

  const total = assignedCents + unassignedCents
  return {
    assignedCents,
    unassignedCents,
    basisPointsAssigned: total === 0 ? null : Math.round((assignedCents / total) * 10_000),
  }
}

/**
 * Coverage for every dimension a company has marked `expected`.
 *
 * The number an owner checks before believing a dimensional report. 62%
 * coverage does not mean the report is wrong — it means more than a third of
 * the business is in one column called Unassigned, and any conclusion drawn
 * from the rest is a conclusion about the smaller part.
 */
export async function coverageReport(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<Array<{ dimension: { id: string; name: string; code: string } } & DimensionCoverage>> {
  requirePermission(ctx, 'reports:view')

  const expected = await db
    .select({ id: dimensions.id, name: dimensions.name, code: dimensions.code })
    .from(dimensions)
    .where(
      scoped(
        ctx,
        dimensions,
        eq(dimensions.isActive, true),
        eq(dimensions.requirement, 'expected'),
      ),
    )
    .orderBy(asc(dimensions.sortOrder), asc(dimensions.name))

  return Promise.all(
    expected.map(async (dimension) => ({
      dimension,
      ...coverageFrom(await dimensionalCells(ctx, { ...range, dimensionId: dimension.id })),
    })),
  )
}

export type DimensionBalanceRow = {
  chartAccountId: string
  number: string
  name: string
  type: AccountType
  balanceCents: number
}

/**
 * Balance-sheet account activity attributed to one dimension value.
 *
 * Deliberately **not** a balance sheet, and the difference is the point.
 *
 * A balance sheet per location cannot balance. Assets and liabilities can be
 * tagged — this truck belongs to the Airport site — but equity cannot: there
 * is no such thing as the Airport site's share capital, and its retained
 * earnings depend on inter-site transfers nobody records. Every product that
 * ships "balance sheet by location" balances it with a plug, usually called
 * "Due to/from divisions", and that plug is a number the business never
 * transacted.
 *
 * So what this returns is what can be said honestly: the movement on
 * balance-sheet accounts that carries this value, which answers "what did the
 * Airport site buy" without claiming to answer "what is the Airport site
 * worth". ADR 0016 records the reasoning.
 */
export async function balanceActivityByValue(
  ctx: ActorContext,
  input: { dimensionValueId: string; startDate?: string; endDate?: string },
): Promise<DimensionBalanceRow[]> {
  requirePermission(ctx, 'reports:financial')

  const conditions: SQL[] = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    sql`d.dimension_value_id = ${input.dimensionValueId}`,
    sql`${chartAccounts.type} IN ('asset', 'liability', 'equity')`,
  ]

  if (input.startDate) conditions.push(sql`${journalEntries.entryDate} >= ${input.startDate}`)
  if (input.endDate) conditions.push(sql`${journalEntries.entryDate} <= ${input.endDate}`)

  const rows = await db
    .select({
      chartAccountId: journalLines.chartAccountId,
      number: chartAccounts.number,
      name: chartAccounts.name,
      type: chartAccounts.type,
      debitCents: sql<string>`sum(${journalLines.debitCents})`,
      creditCents: sql<string>`sum(${journalLines.creditCents})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .innerJoin(
      sql`journal_line_dimensions d`,
      sql`d.journal_line_id = ${journalLines.id}`,
    )
    .where(and(...conditions))
    .groupBy(journalLines.chartAccountId, chartAccounts.number, chartAccounts.name, chartAccounts.type)
    .orderBy(asc(chartAccounts.number))

  return rows.map((row) => {
    const type = row.type as AccountType
    return {
      chartAccountId: row.chartAccountId,
      number: row.number,
      name: row.name,
      type,
      balanceCents: normalBalance(type, Number(row.debitCents), Number(row.creditCents)),
    }
  })
}

/** True when this account type grows with debits — re-exported for the screens. */
export { isDebitNormal }
