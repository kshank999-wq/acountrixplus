import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { budgetLines, budgets, chartAccounts } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import { profitAndLoss } from '@/modules/ledger/reports'
import { BudgetError, MONTHS, monthRange, spreadFor, type Month, type SpreadMethod } from './plan'

/**
 * Budgets: creating them, filling them in, and agreeing them (spec §13).
 *
 * ## Nothing here posts
 *
 * Every other service in this codebase that holds money ends in a journal
 * entry. This one never does, and the absence is the design (see the schema's
 * own note). A budget that posted would appear in the actuals it is compared
 * against, which is not a subtle bug — it is a report that says every business
 * hit its plan exactly.
 */

export type BudgetRow = {
  id: string
  name: string
  fiscalYear: number
  status: 'draft' | 'approved' | 'archived'
  notes: string | null
  approvedAt: Date | null
  lineCount: number
  totalCents: number
}

/** Creates an empty budget for a year. */
export async function createBudget(
  ctx: ActorContext,
  input: { name: string; fiscalYear: number; notes?: string },
) {
  requirePermission(ctx, 'accounting:journal')

  const name = input.name.trim()
  if (!name) {
    throw new BudgetError('A budget needs a name. "2026 Approved" tells somebody which one it is.')
  }
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 9999) {
    throw new BudgetError(`${input.fiscalYear} is not a fiscal year.`)
  }

  const [existing] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      scoped(ctx, budgets, and(eq(budgets.fiscalYear, input.fiscalYear), eq(budgets.name, name))),
    )
    .limit(1)

  if (existing) {
    throw new BudgetError(
      `${input.fiscalYear} already has a budget called "${name}". Give this one a different ` +
        'name — a revision that overwrites the plan people agreed is not a revision.',
    )
  }

  const [row] = await db
    .insert(budgets)
    .values({
      companyId: ctx.companyId,
      name,
      fiscalYear: input.fiscalYear,
      notes: input.notes?.trim() || null,
      createdByUserId: ctx.userId,
    })
    .returning()

  await recordAudit(ctx, {
    action: 'budget.create',
    entityType: 'budget',
    entityId: row.id,
    after: { name, fiscalYear: input.fiscalYear },
  })

  return row
}

/** Budgets on file, newest year first. */
export async function listBudgets(ctx: ActorContext): Promise<BudgetRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      id: budgets.id,
      name: budgets.name,
      fiscalYear: budgets.fiscalYear,
      status: budgets.status,
      notes: budgets.notes,
      approvedAt: budgets.approvedAt,
      lineCount: sql<string>`count(${budgetLines.id})`,
      totalCents: sql<string>`coalesce(sum(${budgetLines.amountCents}), 0)`,
    })
    .from(budgets)
    .leftJoin(budgetLines, eq(budgetLines.budgetId, budgets.id))
    .where(scoped(ctx, budgets))
    .groupBy(budgets.id)
    .orderBy(desc(budgets.fiscalYear), asc(budgets.name))

  return rows.map((row) => ({
    ...row,
    lineCount: Number(row.lineCount),
    totalCents: Number(row.totalCents),
  }))
}

async function loadBudget(ctx: ActorContext, budgetId: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(budgets)
    .where(scoped(ctx, budgets, eq(budgets.id, budgetId)))
    .limit(1)

  if (!row) throw new BudgetError('Budget not found.')
  return row
}

export type SetAccountInput = {
  budgetId: string
  chartAccountId: string
  /** The whole year, spread across the months by `method`. */
  annualCents?: number
  method?: SpreadMethod
  weights?: number[]
  /** Or the twelve months directly, when somebody has typed them. */
  monthlyCents?: number[]
}

/**
 * Sets one account's twelve months.
 *
 * Either an annual figure to spread or the months themselves — never both,
 * because a caller supplying both has two different intentions and this
 * function cannot know which one is the mistake.
 *
 * Writes all twelve rows, including the zeros. A missing row and a row of zero
 * mean genuinely different things to the variance report (one is "not
 * budgeted", the other is "budgeted at nothing"), and an account somebody has
 * deliberately planned to zero for August should read as planned.
 */
export async function setAccountBudget(ctx: ActorContext, input: SetAccountInput) {
  requirePermission(ctx, 'accounting:journal')

  const budget = await loadBudget(ctx, input.budgetId)

  if (budget.status === 'archived') {
    throw new BudgetError(`"${budget.name}" is archived. Copy it to a new budget to change it.`)
  }

  const hasAnnual = input.annualCents !== undefined
  const hasMonthly = input.monthlyCents !== undefined

  if (hasAnnual === hasMonthly) {
    throw new BudgetError(
      'Give either a yearly figure to spread or the twelve months, not both and not neither.',
    )
  }

  const [account] = await db
    .select({ id: chartAccounts.id, number: chartAccounts.number, name: chartAccounts.name })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, input.chartAccountId)))
    .limit(1)

  if (!account) throw new BudgetError('That account is not in this company’s chart.')

  const amounts = hasAnnual
    ? spreadFor({
        annualCents: input.annualCents as number,
        periods: MONTHS.length,
        method: input.method ?? 'even',
        weights: input.weights,
      })
    : (input.monthlyCents as number[])

  if (amounts.length !== MONTHS.length) {
    throw new BudgetError(`A year needs twelve months — ${amounts.length} given.`)
  }
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) {
      throw new BudgetError('Every month has to be a whole number of cents.')
    }
  }

  await db.transaction(async (tx) => {
    for (const month of MONTHS) {
      await tx
        .insert(budgetLines)
        .values({
          companyId: ctx.companyId,
          budgetId: budget.id,
          chartAccountId: account.id,
          month,
          amountCents: amounts[month - 1],
        })
        .onConflictDoUpdate({
          target: [budgetLines.budgetId, budgetLines.chartAccountId, budgetLines.month],
          set: { amountCents: amounts[month - 1], updatedAt: new Date() },
        })
    }

    await tx.update(budgets).set({ updatedAt: new Date() }).where(eq(budgets.id, budget.id))
  })

  const totalCents = amounts.reduce((sum, amount) => sum + amount, 0)

  await recordAudit(ctx, {
    action: 'budget.set_account',
    entityType: 'budget',
    entityId: budget.id,
    after: { account: `${account.number} ${account.name}`, totalCents },
  })

  return { chartAccountId: account.id, amounts, totalCents }
}

/** Removes an account from a budget entirely — not the same as budgeting zero. */
export async function clearAccountBudget(
  ctx: ActorContext,
  input: { budgetId: string; chartAccountId: string },
) {
  requirePermission(ctx, 'accounting:journal')

  const budget = await loadBudget(ctx, input.budgetId)

  await db
    .delete(budgetLines)
    .where(
      and(
        eq(budgetLines.companyId, ctx.companyId),
        eq(budgetLines.budgetId, budget.id),
        eq(budgetLines.chartAccountId, input.chartAccountId),
      ),
    )

  await recordAudit(ctx, {
    action: 'budget.clear_account',
    entityType: 'budget',
    entityId: budget.id,
    after: { chartAccountId: input.chartAccountId },
  })
}

/**
 * Marks a budget as the agreed one for its year.
 *
 * Any other approved budget for that year is archived in the same transaction,
 * so "the plan" is never ambiguous. Approval does not freeze the figures — see
 * the schema note on why.
 */
export async function approveBudget(ctx: ActorContext, budgetId: string) {
  requirePermission(ctx, 'accounting:journal')

  const budget = await loadBudget(ctx, budgetId)

  if (budget.status === 'approved') return budget

  return db.transaction(async (tx) => {
    await tx
      .update(budgets)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(
        and(
          eq(budgets.companyId, ctx.companyId),
          eq(budgets.fiscalYear, budget.fiscalYear),
          eq(budgets.status, 'approved'),
        ),
      )

    const [row] = await tx
      .update(budgets)
      .set({
        status: 'approved',
        approvedByUserId: ctx.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(budgets.id, budget.id))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'budget.approve',
        entityType: 'budget',
        entityId: budget.id,
        before: { status: budget.status },
        after: { status: 'approved', name: budget.name, fiscalYear: budget.fiscalYear },
      },
      tx,
    )

    return row
  })
}

/** The approved budget for a year, or the only one, or nothing. */
export async function budgetForYear(ctx: ActorContext, fiscalYear: number) {
  const rows = await db
    .select()
    .from(budgets)
    .where(scoped(ctx, budgets, eq(budgets.fiscalYear, fiscalYear)))
    .orderBy(asc(budgets.name))

  return rows.find((row) => row.status === 'approved') ?? rows.find((row) => row.status === 'draft') ?? null
}

export type BudgetGrid = {
  budget: { id: string; name: string; fiscalYear: number; status: string }
  rows: Array<{
    chartAccountId: string
    number: string
    name: string
    type: string
    monthlyCents: number[]
    totalCents: number
  }>
  /** Planned income per month — revenue and other income. */
  incomeMonthlyCents: number[]
  /** Planned cost per month — cost of sales, expenses, other expense. */
  costMonthlyCents: number[]
  /** What the plan says the result will be: income less cost. */
  netMonthlyCents: number[]
  incomeCents: number
  costCents: number
  netCents: number
}

/** A budget as a grid: an account per row, a month per column. */
export async function budgetGrid(ctx: ActorContext, budgetId: string): Promise<BudgetGrid> {
  requirePermission(ctx, 'accounting:view')

  const budget = await loadBudget(ctx, budgetId)

  const lines = await db
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
    .where(
      and(eq(budgetLines.companyId, ctx.companyId), eq(budgetLines.budgetId, budget.id)),
    )
    .orderBy(asc(chartAccounts.number), asc(budgetLines.month))

  const byAccount = new Map<string, BudgetGrid['rows'][number]>()

  for (const line of lines) {
    let row = byAccount.get(line.chartAccountId)
    if (!row) {
      row = {
        chartAccountId: line.chartAccountId,
        number: line.number,
        name: line.name,
        type: line.type,
        monthlyCents: MONTHS.map(() => 0),
        totalCents: 0,
      }
      byAccount.set(line.chartAccountId, row)
    }
    row.monthlyCents[line.month - 1] = line.amountCents
    row.totalCents += line.amountCents
  }

  const rows = [...byAccount.values()]

  // Income and cost kept apart. One "Total" row across both would add planned
  // revenue to planned rent and call the result a number — the same mistake
  // `varianceFor` exists to prevent, and one this grid shipped until somebody
  // read it on screen.
  const isIncome = (type: string) => type === 'revenue' || type === 'other_income'

  const sumOver = (predicate: (type: string) => boolean) =>
    MONTHS.map((_, index) =>
      rows
        .filter((row) => predicate(row.type))
        .reduce((sum, row) => sum + row.monthlyCents[index], 0),
    )

  const incomeMonthlyCents = sumOver(isIncome)
  const costMonthlyCents = sumOver((type) => !isIncome(type))
  const netMonthlyCents = incomeMonthlyCents.map((cents, index) => cents - costMonthlyCents[index])
  const total = (months: number[]) => months.reduce((sum, cents) => sum + cents, 0)

  return {
    budget: {
      id: budget.id,
      name: budget.name,
      fiscalYear: budget.fiscalYear,
      status: budget.status,
    },
    rows,
    incomeMonthlyCents,
    costMonthlyCents,
    netMonthlyCents,
    incomeCents: total(incomeMonthlyCents),
    costCents: total(costMonthlyCents),
    netCents: total(netMonthlyCents),
  }
}

/**
 * Fills a budget from what actually happened in an earlier year.
 *
 * The commonest way a budget gets built, and the reason it is here rather than
 * left to somebody with a spreadsheet: last year's actuals are already in this
 * system, and exporting them to be typed back in is where transcription errors
 * come from.
 *
 * `upliftBasisPoints` applies a flat increase — 500 for 5%. Deliberately flat
 * rather than per-account: a graduated uplift is a planning exercise somebody
 * should do deliberately in the grid, not a default this function guesses.
 *
 * Uses each month's **own** actual rather than the year spread evenly, because
 * the seasonality is the most useful thing last year knows.
 */
export async function copyFromActuals(
  ctx: ActorContext,
  input: { budgetId: string; sourceYear: number; upliftBasisPoints?: number },
) {
  requirePermission(ctx, 'accounting:journal')
  requirePermission(ctx, 'reports:financial')

  const budget = await loadBudget(ctx, input.budgetId)
  const uplift = input.upliftBasisPoints ?? 0

  if (!Number.isInteger(uplift)) {
    throw new BudgetError('An uplift is in basis points — 500 for 5%.')
  }

  // One P&L per month, so the shape of the year survives.
  const monthly = await Promise.all(
    MONTHS.map(async (month) => {
      const range = monthRange(input.sourceYear, month)
      const report = await profitAndLoss(ctx, range)
      return [
        ...report.revenue.rows,
        ...report.costOfSales.rows,
        ...report.operatingExpenses.rows,
        ...report.otherIncome.rows,
        ...report.otherExpenses.rows,
      ]
    }),
  )

  const byAccount = new Map<string, number[]>()

  monthly.forEach((rows, index) => {
    for (const row of rows) {
      let months = byAccount.get(row.chartAccountId)
      if (!months) {
        months = MONTHS.map(() => 0)
        byAccount.set(row.chartAccountId, months)
      }
      // Basis points on an integer, rounded once, so a 5% uplift on $1,000.01
      // is a whole number of cents rather than a fraction carried forward.
      months[index] = Math.round((row.balanceCents * (10_000 + uplift)) / 10_000)
    }
  })

  if (byAccount.size === 0) {
    throw new BudgetError(
      `${input.sourceYear} has nothing on the profit and loss to copy. Choose a year with ` +
        'trading in it, or enter the figures by hand.',
    )
  }

  await db.transaction(async (tx) => {
    for (const [chartAccountId, months] of byAccount) {
      for (const month of MONTHS) {
        await tx
          .insert(budgetLines)
          .values({
            companyId: ctx.companyId,
            budgetId: budget.id,
            chartAccountId,
            month,
            amountCents: months[month - 1],
          })
          .onConflictDoUpdate({
            target: [budgetLines.budgetId, budgetLines.chartAccountId, budgetLines.month],
            set: { amountCents: months[month - 1], updatedAt: new Date() },
          })
      }
    }

    await tx.update(budgets).set({ updatedAt: new Date() }).where(eq(budgets.id, budget.id))
  })

  await recordAudit(ctx, {
    action: 'budget.copy_actuals',
    entityType: 'budget',
    entityId: budget.id,
    after: { sourceYear: input.sourceYear, upliftBasisPoints: uplift, accounts: byAccount.size },
  })

  return { accounts: byAccount.size, sourceYear: input.sourceYear, upliftBasisPoints: uplift }
}

export { BudgetError, MONTHS, monthRange, spreadFor, varianceFor } from './plan'
export type { Month, SpreadMethod, Variance } from './plan'
