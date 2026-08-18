import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { budgetLines, budgets, chartAccounts } from '@/db/schema'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { profitAndLoss } from '@/modules/ledger/reports'
import type { AccountType } from '@/modules/coa/standard'
import type { ReportingBasis } from '@/modules/ledger/cash-basis'
import { BudgetError, MONTHS, monthRange, varianceFor, type Month, type Variance } from './plan'
import { budgetForYear } from './service'

/**
 * Plan against actual (spec §13).
 *
 * ## The actuals come from the Profit & Loss itself
 *
 * Not from a second query over `journal_lines` that happens to filter the same
 * way. This report calls `profitAndLoss` — the exact function the income
 * statement calls — so the two **cannot** disagree.
 *
 * That is a deliberate departure from the pattern Phase 26 and Phase 31
 * established, where two genuinely independent derivations are compared and any
 * difference is the alarm. The difference is what the numbers are *for*: a
 * control account is a reconciliation, and reconciliation requires
 * independence. This is a presentation of one figure beside another, and a
 * budget report that quietly disagreed with the income statement would send
 * somebody hunting for a variance that was really a `WHERE` clause.
 *
 * So: independence where the point is to catch drift, one source where the
 * point is to be believed.
 *
 * ## An unbudgeted account is not an account budgeted at zero
 *
 * $5,000 of legal fees nobody planned for is a real and interesting fact. A
 * report that shows it as *budget $0, actual $5,000, 100% over* has turned it
 * into a percentage of nothing and buried it among the rows that merely drifted.
 *
 * So the rows are partitioned. Accounts with a plan get a variance; accounts
 * with activity and no plan are listed separately as **unbudgeted**, with no
 * variance at all — because there is no plan to vary from. The reverse case
 * gets the same treatment: a budgeted account with no activity is not silently
 * dropped, it reports its full budget as unspent.
 */

export type VarianceRow = Variance & {
  chartAccountId: string
  number: string
  name: string
  type: AccountType
}

export type VarianceSection = {
  title: string
  rows: VarianceRow[]
  budgetCents: number
  actualCents: number
  varianceCents: number
  favourable: boolean
}

export type BudgetVsActual = {
  budget: { id: string; name: string; fiscalYear: number; status: string }
  basis: ReportingBasis
  startDate: string
  endDate: string
  /** Which months of the year the range covers, so the plan is comparable. */
  months: Month[]
  revenue: VarianceSection
  costOfSales: VarianceSection
  operatingExpenses: VarianceSection
  otherIncome: VarianceSection
  otherExpenses: VarianceSection
  /** Net income, planned against actual. Favourable means better than planned. */
  netIncome: Variance
  /**
   * Accounts with activity and no plan. Not a variance — there is nothing to
   * vary from — so this is a list of facts, deliberately not totalled into the
   * sections above.
   */
  unbudgeted: Array<{
    chartAccountId: string
    number: string
    name: string
    type: AccountType
    actualCents: number
  }>
  /**
   * Income and cost kept apart, and only the *net* offered as one number.
   *
   * A single total across both would add unbudgeted rental income to
   * unbudgeted wages and call the result a figure — which is the same mistake
   * `varianceFor` exists to prevent, one level up. Browser verification caught
   * this report making it: "$37,906.35 not budgeted at all" read as an
   * overspend and was really $6,558 of unplanned income against $44,464 of
   * unplanned cost.
   */
  unbudgetedIncomeCents: number
  unbudgetedCostCents: number
  /** What the unplanned accounts did to the result: income less cost. */
  unbudgetedNetCents: number
}

const SECTIONS = [
  { key: 'revenue', title: 'Revenue', types: ['revenue'] },
  { key: 'costOfSales', title: 'Cost of sales', types: ['cogs'] },
  { key: 'operatingExpenses', title: 'Operating expenses', types: ['expense'] },
  { key: 'otherIncome', title: 'Other income', types: ['other_income'] },
  { key: 'otherExpenses', title: 'Other expense', types: ['other_expense'] },
] as const

/**
 * Which whole months a date range covers.
 *
 * Whole months only: a budget is stored per month, and a range ending on the
 * 14th has no defensible share of February's plan. Reporting half a month's
 * budget against half a month's actuals would look precise and be arbitrary —
 * a business does not earn its February evenly.
 */
export function monthsCovered(
  fiscalYear: number,
  range: { startDate: string; endDate: string },
): Month[] {
  return MONTHS.filter((month) => {
    const bounds = monthRange(fiscalYear, month)
    return bounds.startDate >= range.startDate && bounds.endDate <= range.endDate
  })
}

/**
 * The plan against what happened, for a range of whole months.
 *
 * Defaults to the whole fiscal year and to the approved budget, because that is
 * what somebody means when they say "are we on budget".
 */
export async function budgetVsActual(
  ctx: ActorContext,
  opts: {
    fiscalYear: number
    budgetId?: string
    startDate?: string
    endDate?: string
    basis?: ReportingBasis
  },
): Promise<BudgetVsActual> {
  requirePermission(ctx, 'reports:financial')

  const budget = opts.budgetId
    ? (await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.companyId, ctx.companyId), eq(budgets.id, opts.budgetId)))
        .limit(1))[0]
    : await budgetForYear(ctx, opts.fiscalYear)

  if (!budget) {
    throw new BudgetError(
      `There is no budget for ${opts.fiscalYear}. Create one before asking how the year is ` +
        'going against it.',
    )
  }

  const startDate = opts.startDate ?? `${budget.fiscalYear}-01-01`
  const endDate = opts.endDate ?? `${budget.fiscalYear}-12-31`
  const months = monthsCovered(budget.fiscalYear, { startDate, endDate })

  // The actuals, from the income statement itself.
  const actuals = await profitAndLoss(ctx, { startDate, endDate, basis: opts.basis })

  const actualByAccount = new Map<string, { balanceCents: number; type: AccountType }>()
  for (const section of [
    actuals.revenue,
    actuals.costOfSales,
    actuals.operatingExpenses,
    actuals.otherIncome,
    actuals.otherExpenses,
  ]) {
    for (const row of section.rows) {
      actualByAccount.set(row.chartAccountId, { balanceCents: row.balanceCents, type: row.type })
    }
  }

  // The plan, summed over exactly the months the range covers.
  const planRows = await db
    .select({
      chartAccountId: budgetLines.chartAccountId,
      month: budgetLines.month,
      amountCents: budgetLines.amountCents,
      number: chartAccounts.number,
      name: chartAccounts.name,
      type: chartAccounts.type,
    })
    .from(budgetLines)
    .innerJoin(chartAccounts, eq(chartAccounts.id, budgetLines.chartAccountId))
    .where(and(eq(budgetLines.companyId, ctx.companyId), eq(budgetLines.budgetId, budget.id)))

  const wanted = new Set<number>(months)
  const planned = new Map<
    string,
    { number: string; name: string; type: AccountType; budgetCents: number }
  >()

  for (const row of planRows) {
    if (!wanted.has(row.month)) continue
    const existing = planned.get(row.chartAccountId)
    if (existing) {
      existing.budgetCents += row.amountCents
    } else {
      planned.set(row.chartAccountId, {
        number: row.number,
        name: row.name,
        type: row.type as AccountType,
        budgetCents: row.amountCents,
      })
    }
  }

  const built: Record<string, VarianceSection> = {}

  for (const spec of SECTIONS) {
    const types = new Set<AccountType>(spec.types as readonly AccountType[])
    const rows: VarianceRow[] = []

    for (const [chartAccountId, plan] of planned) {
      if (!types.has(plan.type)) continue
      rows.push({
        chartAccountId,
        number: plan.number,
        name: plan.name,
        type: plan.type,
        ...varianceFor({
          budgetCents: plan.budgetCents,
          actualCents: actualByAccount.get(chartAccountId)?.balanceCents ?? 0,
          type: plan.type,
        }),
      })
    }

    rows.sort((a, b) => a.number.localeCompare(b.number))

    const budgetCents = rows.reduce((sum, row) => sum + row.budgetCents, 0)
    const actualCents = rows.reduce((sum, row) => sum + row.actualCents, 0)
    // The section's verdict comes from the same function as each row's, on the
    // section's own totals — not from counting how many rows were favourable.
    // Nine rows a dollar under and one row a million over is not a favourable
    // section, and a majority vote would say it was.
    const total = varianceFor({
      budgetCents,
      actualCents,
      type: spec.types[0] as AccountType,
    })

    built[spec.key] = {
      title: spec.title,
      rows,
      budgetCents,
      actualCents,
      varianceCents: total.varianceCents,
      favourable: total.favourable,
    }
  }

  const unbudgeted = [...actualByAccount.entries()]
    .filter(([chartAccountId, actual]) => !planned.has(chartAccountId) && actual.balanceCents !== 0)
    .map(([chartAccountId, actual]) => {
      const row = [
        ...actuals.revenue.rows,
        ...actuals.costOfSales.rows,
        ...actuals.operatingExpenses.rows,
        ...actuals.otherIncome.rows,
        ...actuals.otherExpenses.rows,
      ].find((candidate) => candidate.chartAccountId === chartAccountId)!

      return {
        chartAccountId,
        number: row.number,
        name: row.name,
        type: actual.type,
        actualCents: actual.balanceCents,
      }
    })
    .sort((a, b) => a.number.localeCompare(b.number))

  const unbudgetedIncome = unbudgeted
    .filter((row) => row.type === 'revenue' || row.type === 'other_income')
    .reduce((sum, row) => sum + row.actualCents, 0)
  const unbudgetedCost = unbudgeted
    .filter((row) => row.type !== 'revenue' && row.type !== 'other_income')
    .reduce((sum, row) => sum + row.actualCents, 0)

  // Net income, planned against actual. Treated as income — earning more than
  // planned is favourable — which is what the phrase "ahead of budget" means.
  const plannedNetCents =
    built.revenue.budgetCents -
    built.costOfSales.budgetCents -
    built.operatingExpenses.budgetCents +
    built.otherIncome.budgetCents -
    built.otherExpenses.budgetCents

  return {
    budget: {
      id: budget.id,
      name: budget.name,
      fiscalYear: budget.fiscalYear,
      status: budget.status,
    },
    basis: actuals.basis,
    startDate,
    endDate,
    months,
    revenue: built.revenue,
    costOfSales: built.costOfSales,
    operatingExpenses: built.operatingExpenses,
    otherIncome: built.otherIncome,
    otherExpenses: built.otherExpenses,
    netIncome: varianceFor({
      budgetCents: plannedNetCents,
      // The income statement's own net income, not a re-derivation from the
      // sections above — which would exclude every unbudgeted account and
      // report a profit the business did not make.
      actualCents: actuals.netIncomeCents,
      type: 'revenue',
    }),
    unbudgeted,
    unbudgetedIncomeCents: unbudgetedIncome,
    unbudgetedCostCents: unbudgetedCost,
    unbudgetedNetCents: unbudgetedIncome - unbudgetedCost,
  }
}
