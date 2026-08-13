import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  costCodes,
  jobBudgetLines,
  journalEntries,
  journalLines,
  organizations,
  projects,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { CostType } from './cost-codes'

/**
 * Job costing, WIP, and profitability reports (spec §5, §13, §20 Phase 7).
 *
 * ## The one thing to understand about this file
 *
 * Every figure here is a `SUM` over `journal_lines`, filtered by
 * `project_id` and grouped by `cost_code_id`. There is no job cost table being
 * maintained in parallel, no roll-up job, and no cached total.
 *
 * That is what spec §20's "without forking the core ledger" buys: a job's cost
 * to date and the trial balance are literally the same rows added up two
 * different ways, so they cannot drift. The alternative — a `job_costs` table
 * written alongside every posting — is the standard way this feature is built
 * and the standard reason a contractor's job cost report disagrees with their
 * P&L by the end of the year.
 *
 * `tests/jobs.test.ts` asserts the identity directly: cost-to-date across all
 * jobs equals the cost of sales on the profit & loss.
 */

/** Account types that count as job cost. */
const COST_TYPES = ['cogs', 'expense'] as const
/** Account types that count as job revenue. */
const REVENUE_TYPES = ['revenue'] as const

export type CostByCode = {
  costCodeId: string | null
  code: string
  name: string
  costType: CostType | 'unassigned'
  actualCents: number
  originalBudgetCents: number
  changeBudgetCents: number
  revisedBudgetCents: number
  /** Revised budget minus actual. Negative means over budget. */
  varianceCents: number
  /** Actual ÷ revised budget, in basis points. Null when there is no budget. */
  spentBp: number | null
}

/**
 * Cost to date for one job, broken down by cost code, next to its budget.
 *
 * Costs posted to the job without a cost code are not dropped — they appear as
 * an "unassigned" row. Hiding them would make the report add up to less than
 * the ledger, which is the one thing it must never do.
 */
export async function jobCostByCode(
  ctx: ActorContext,
  projectId: string,
  opts: { asOfDate?: string } = {},
): Promise<CostByCode[]> {
  requirePermission(ctx, 'jobs:view')

  const actuals = await db
    .select({
      costCodeId: journalLines.costCodeId,
      amountCents: sql<string>`sum(${journalLines.debitCents} - ${journalLines.creditCents})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      scoped(
        ctx,
        journalLines,
        eq(journalLines.projectId, projectId),
        eq(journalEntries.status, 'posted'),
        inArray(chartAccounts.type, [...COST_TYPES]),
        opts.asOfDate ? lte(journalEntries.entryDate, opts.asOfDate) : undefined,
      ),
    )
    .groupBy(journalLines.costCodeId)

  const budgets = await db
    .select({
      costCodeId: jobBudgetLines.costCodeId,
      originalAmountCents: jobBudgetLines.originalAmountCents,
      changeAmountCents: jobBudgetLines.changeAmountCents,
    })
    .from(jobBudgetLines)
    .where(scoped(ctx, jobBudgetLines, eq(jobBudgetLines.projectId, projectId)))

  const codeIds = [
    ...new Set([
      ...actuals.map((row) => row.costCodeId).filter(Boolean),
      ...budgets.map((row) => row.costCodeId),
    ]),
  ] as string[]

  const codes =
    codeIds.length > 0
      ? await db
          .select()
          .from(costCodes)
          .where(scoped(ctx, costCodes, inArray(costCodes.id, codeIds)))
          .orderBy(asc(costCodes.code))
      : []

  const actualByCode = new Map(actuals.map((row) => [row.costCodeId, Number(row.amountCents)]))
  const budgetByCode = new Map(budgets.map((row) => [row.costCodeId, row]))

  const rows: CostByCode[] = codes.map((code) => {
    const budget = budgetByCode.get(code.id)
    const originalBudgetCents = budget?.originalAmountCents ?? 0
    const changeBudgetCents = budget?.changeAmountCents ?? 0
    const revisedBudgetCents = originalBudgetCents + changeBudgetCents
    const actualCents = actualByCode.get(code.id) ?? 0

    return {
      costCodeId: code.id,
      code: code.code,
      name: code.name,
      costType: code.costType as CostType,
      actualCents,
      originalBudgetCents,
      changeBudgetCents,
      revisedBudgetCents,
      varianceCents: revisedBudgetCents - actualCents,
      spentBp:
        revisedBudgetCents > 0
          ? Math.round((actualCents / revisedBudgetCents) * 10_000)
          : null,
    }
  })

  const unassigned = actualByCode.get(null) ?? 0
  if (unassigned !== 0) {
    rows.push({
      costCodeId: null,
      code: '—',
      name: 'Not assigned to a cost code',
      costType: 'unassigned',
      actualCents: unassigned,
      originalBudgetCents: 0,
      changeBudgetCents: 0,
      revisedBudgetCents: 0,
      varianceCents: -unassigned,
      spentBp: null,
    })
  }

  return rows
}

export type JobFinancials = {
  projectId: string
  code: string
  name: string
  status: string
  clientName: string | null
  /** Contract value including approved change orders. */
  contractValueCents: number
  revisedBudgetCents: number
  originalBudgetCents: number
  costToDateCents: number
  billedToDateCents: number
  /** Contract minus revised budget: the margin the job is planned to make. */
  estimatedGrossProfitCents: number
  /** Billed minus cost: the margin the ledger has actually recorded so far. */
  actualGrossProfitCents: number
  /** Cost ÷ revised budget, in basis points. Null when there is no budget. */
  percentCompleteBp: number | null
  /** Contract × percent complete: revenue the job has earned. */
  earnedRevenueCents: number
  /**
   * Billed minus earned. Positive is *over*billed (a liability — you have been
   * paid for work not yet done), negative is *under*billed (an asset).
   */
  overUnderBillingCents: number
}

/**
 * Work in progress for every job, or one (spec §5 "WIP").
 *
 * Percent complete is cost-to-date over revised budget — the cost-to-cost
 * method, which is what a contractor's accountant will expect. A job with no
 * budget reports `null` rather than 0%: unknown and not-started are different
 * answers, and reporting 0% for the first would show a fully-cost-loaded job
 * as having earned nothing.
 */
export async function workInProgress(
  ctx: ActorContext,
  opts: { asOfDate?: string; projectId?: string; includeComplete?: boolean } = {},
): Promise<JobFinancials[]> {
  requirePermission(ctx, 'jobs:view')

  const jobs = await db
    .select({
      id: projects.id,
      code: projects.code,
      name: projects.name,
      status: projects.status,
      contractValueCents: projects.contractValueCents,
      clientName: organizations.name,
    })
    .from(projects)
    .leftJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(
      scoped(ctx, projects, opts.projectId ? eq(projects.id, opts.projectId) : undefined),
    )
    .orderBy(asc(projects.code))

  const visible = opts.includeComplete
    ? jobs
    : jobs.filter((job) => job.status === 'active' || job.status === 'on_hold')

  if (visible.length === 0) return []

  const ids = visible.map((job) => job.id)

  // Two grouped queries over the ledger, and one over the budget. Everything
  // else in this function is arithmetic on those three results.
  const [costs, billings, budgets] = await Promise.all([
    ledgerTotalsByProject(ctx, ids, [...COST_TYPES], opts.asOfDate),
    ledgerTotalsByProject(ctx, ids, [...REVENUE_TYPES], opts.asOfDate),
    db
      .select({
        projectId: jobBudgetLines.projectId,
        original: sql<string>`sum(${jobBudgetLines.originalAmountCents})`,
        change: sql<string>`sum(${jobBudgetLines.changeAmountCents})`,
      })
      .from(jobBudgetLines)
      .where(scoped(ctx, jobBudgetLines, inArray(jobBudgetLines.projectId, ids)))
      .groupBy(jobBudgetLines.projectId),
  ])

  const budgetByProject = new Map(
    budgets.map((row) => [
      row.projectId,
      { original: Number(row.original), change: Number(row.change) },
    ]),
  )

  return visible.map((job) => {
    const budget = budgetByProject.get(job.id) ?? { original: 0, change: 0 }
    const revisedBudgetCents = budget.original + budget.change
    const costToDateCents = costs.get(job.id) ?? 0
    // Revenue accounts are credit-normal, so the debit-minus-credit sum comes
    // back negative. Flip it once, here, rather than in three call sites.
    const billedToDateCents = -(billings.get(job.id) ?? 0)

    const percentCompleteBp =
      revisedBudgetCents > 0
        ? Math.min(10_000, Math.round((costToDateCents / revisedBudgetCents) * 10_000))
        : null

    const earnedRevenueCents =
      percentCompleteBp === null
        ? 0
        : Math.round((job.contractValueCents * percentCompleteBp) / 10_000)

    return {
      projectId: job.id,
      code: job.code,
      name: job.name,
      status: job.status,
      clientName: job.clientName,
      contractValueCents: job.contractValueCents,
      originalBudgetCents: budget.original,
      revisedBudgetCents,
      costToDateCents,
      billedToDateCents,
      estimatedGrossProfitCents: job.contractValueCents - revisedBudgetCents,
      actualGrossProfitCents: billedToDateCents - costToDateCents,
      percentCompleteBp,
      earnedRevenueCents,
      overUnderBillingCents: billedToDateCents - earnedRevenueCents,
    }
  })
}

export type WipSummary = {
  jobs: JobFinancials[]
  contractValueCents: number
  revisedBudgetCents: number
  costToDateCents: number
  billedToDateCents: number
  earnedRevenueCents: number
  /** Under-billings: an asset, Costs in Excess of Billings. */
  costsInExcessCents: number
  /** Over-billings: a liability, Billings in Excess of Costs. */
  billingsInExcessCents: number
}

/**
 * The WIP schedule with its two totals separated.
 *
 * Over- and under-billings are reported apart rather than netted, because they
 * are a liability and an asset. Netting them to one number would be the
 * balance sheet equivalent of offsetting a customer's debt against a
 * supplier's.
 */
export async function wipSummary(
  ctx: ActorContext,
  opts: { asOfDate?: string; includeComplete?: boolean } = {},
): Promise<WipSummary> {
  const jobs = await workInProgress(ctx, opts)

  const totals = jobs.reduce(
    (sum, job) => ({
      contractValueCents: sum.contractValueCents + job.contractValueCents,
      revisedBudgetCents: sum.revisedBudgetCents + job.revisedBudgetCents,
      costToDateCents: sum.costToDateCents + job.costToDateCents,
      billedToDateCents: sum.billedToDateCents + job.billedToDateCents,
      earnedRevenueCents: sum.earnedRevenueCents + job.earnedRevenueCents,
      costsInExcessCents:
        sum.costsInExcessCents + Math.max(0, -job.overUnderBillingCents),
      billingsInExcessCents:
        sum.billingsInExcessCents + Math.max(0, job.overUnderBillingCents),
    }),
    {
      contractValueCents: 0,
      revisedBudgetCents: 0,
      costToDateCents: 0,
      billedToDateCents: 0,
      earnedRevenueCents: 0,
      costsInExcessCents: 0,
      billingsInExcessCents: 0,
    },
  )

  return { jobs, ...totals }
}

/**
 * Cost or revenue per job, straight from the ledger.
 *
 * Returns debits minus credits, so cost accounts come back positive and
 * revenue accounts negative. The caller flips revenue rather than this
 * function guessing, so the sign convention stays visible where it matters.
 */
async function ledgerTotalsByProject(
  ctx: ActorContext,
  projectIds: string[],
  accountTypes: string[],
  asOfDate?: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      projectId: journalLines.projectId,
      amountCents: sql<string>`sum(${journalLines.debitCents} - ${journalLines.creditCents})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      scoped(
        ctx,
        journalLines,
        inArray(journalLines.projectId, projectIds),
        eq(journalEntries.status, 'posted'),
        inArray(chartAccounts.type, accountTypes as never[]),
        asOfDate ? lte(journalEntries.entryDate, asOfDate) : undefined,
      ),
    )
    .groupBy(journalLines.projectId)

  return new Map(
    rows.filter((row) => row.projectId).map((row) => [row.projectId!, Number(row.amountCents)]),
  )
}

/**
 * Every posted ledger line on a job, for the drill-down.
 *
 * The report is only trustworthy if you can get from a total to the entries
 * behind it, so this is the same filter the roll-up uses, without the
 * aggregation.
 */
export async function jobCostDetail(
  ctx: ActorContext,
  projectId: string,
  opts: { costCodeId?: string; limit?: number } = {},
) {
  requirePermission(ctx, 'jobs:view')

  return db
    .select({
      lineId: journalLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      source: journalEntries.source,
      accountNumber: chartAccounts.number,
      accountName: chartAccounts.name,
      accountType: chartAccounts.type,
      costCodeId: journalLines.costCodeId,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
      memo: journalLines.memo,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      scoped(
        ctx,
        journalLines,
        eq(journalLines.projectId, projectId),
        eq(journalEntries.status, 'posted'),
        opts.costCodeId ? eq(journalLines.costCodeId, opts.costCodeId) : undefined,
      ),
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNumber))
    .limit(opts.limit ?? 500)
}

/**
 * Total cost posted to *any* job, across the company.
 *
 * Exists for the reconciliation test: this figure, plus cost posted to no job,
 * must equal cost of sales plus expenses on the profit & loss. If it ever does
 * not, something has started keeping a second set of books.
 */
export async function totalJobCost(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<number> {
  requirePermission(ctx, 'jobs:view')

  const [row] = await db
    .select({
      amountCents: sql<string>`coalesce(sum(${journalLines.debitCents} - ${journalLines.creditCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalLines.projectId} IS NOT NULL`,
        inArray(chartAccounts.type, [...COST_TYPES]),
        sql`${journalEntries.entryDate} BETWEEN ${range.startDate} AND ${range.endDate}`,
      ),
    )

  return Number(row?.amountCents ?? 0)
}
