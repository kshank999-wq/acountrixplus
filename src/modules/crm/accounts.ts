/**
 * The attention list, measured (spec §11).
 *
 * The database half of `attention.ts`. Six queries, joined in memory by
 * organization id — the same trade `organizationTimeline` documents and for the
 * same reason: a single statement over six tables with six different shapes
 * needs a lowest-common-denominator row, and every source loses the column that
 * made it worth reading.
 *
 * Nothing here decides anything. It gathers facts and hands them to the pure
 * core, which is what makes "why is this account on the list?" answerable by
 * reading one file that has no database in it.
 */

import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  customers,
  invoices,
  opportunities,
  organizations,
  proposals,
  tasks,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { lastContactedAt } from '@/modules/engagement/communications'
import { TERMINAL_STAGES } from './pipeline'
import {
  rankAccounts,
  type AccountAttention,
  type AccountFacts,
  type LifecycleStage,
} from './attention'

/**
 * How far back invoiced revenue is counted.
 *
 * A year, because the figure is answering "how much is this relationship
 * worth", and a client who spent heavily three years ago and nothing since is
 * a *former* client whose stage already says so. Counting all history would
 * rank the list by who was once important.
 */
const REVENUE_WINDOW_DAYS = 365

/** Accounts to consider. A cap, not a page: the list is read top-down. */
const ACCOUNT_LIMIT = 500

function daysAgo(asOf: Date, days: number): Date {
  return new Date(asOf.getTime() - days * 86_400_000)
}

/** `YYYY-MM-DD`, for the date columns. */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * Measured facts for every account, for the pure core to judge.
 *
 * `asOf` is a parameter all the way down. The caller that wants "now" passes
 * it, which keeps every function below testable without waiting and makes
 * "what did this look like on Monday" expressible rather than impossible.
 */
export async function accountFacts(
  ctx: ActorContext,
  asOf: Date = new Date(),
): Promise<AccountFacts[]> {
  requirePermission(ctx, 'crm:view')

  const accounts = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      lifecycleStage: organizations.lifecycleStage,
      isStrategicAccount: organizations.isStrategicAccount,
      ownerId: organizations.ownerId,
    })
    .from(organizations)
    .where(scoped(ctx, organizations))
    .limit(ACCOUNT_LIMIT)

  if (accounts.length === 0) return []

  const ids = accounts.map((account) => account.id)
  const terminal = [...TERMINAL_STAGES]

  const [spoken, revenue, pipeline, outstanding, overdue] = await Promise.all([
    lastContactedAt(ctx, ids),

    db
      .select({
        organizationId: customers.organizationId,
        cents: sql<string>`coalesce(sum(${invoices.functionalTotalCents}), 0)`,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        scoped(
          ctx,
          invoices,
          inArray(customers.organizationId, ids),
          ne(invoices.status, 'void'),
          gte(invoices.issueDate, isoDate(daysAgo(asOf, REVENUE_WINDOW_DAYS))),
        ),
      )
      .groupBy(customers.organizationId),

    db
      .select({
        organizationId: opportunities.organizationId,
        /*
          Weighted, and rounded once at the end. `probability` is whole percent
          and `expected_value_cents` is money, so the multiplication is exact
          and only the division needs a decision — `round` rather than `floor`,
          so a 50% chance at an odd number of cents does not quietly lose one.
        */
        cents: sql<string>`coalesce(round(sum(${opportunities.expectedValueCents} * ${opportunities.probability}) / 100.0), 0)`,
        open: sql<string>`count(*)`,
      })
      .from(opportunities)
      .where(
        scoped(
          ctx,
          opportunities,
          inArray(opportunities.organizationId, ids),
          sql`${opportunities.stage} NOT IN ${terminal}`,
        ),
      )
      .groupBy(opportunities.organizationId),

    /*
      Sent and not decided. `sent` and `viewed` are the two live statuses: a
      proposal that reached `expired` or `no_decision` has already been given an
      answer, even if the answer was silence somebody recorded.
    */
    db
      .select({
        organizationId: opportunities.organizationId,
        sentAt: proposals.sentAt,
        firstViewedAt: proposals.firstViewedAt,
      })
      .from(proposals)
      .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
      .where(
        scoped(
          ctx,
          proposals,
          inArray(opportunities.organizationId, ids),
          inArray(proposals.status, ['sent', 'viewed']),
          sql`${proposals.sentAt} is not null`,
        ),
      ),

    db
      .select({
        organizationId: tasks.organizationId,
        count: sql<string>`count(*)`,
      })
      .from(tasks)
      .where(
        scoped(
          ctx,
          tasks,
          inArray(tasks.organizationId, ids),
          eq(tasks.status, 'open'),
          lt(tasks.dueOn, isoDate(asOf)),
        ),
      )
      .groupBy(tasks.organizationId),
  ])

  const revenueBy = new Map(revenue.map((row) => [row.organizationId, Number(row.cents)]))
  const pipelineBy = new Map(
    pipeline.map((row) => [
      row.organizationId,
      { cents: Number(row.cents), open: Number(row.open) },
    ]),
  )
  const overdueBy = new Map(overdue.map((row) => [row.organizationId, Number(row.count)]))

  /** The longest-waiting undecided proposal per account. */
  const waitingBy = new Map<string, { sentAt: Date; viewed: boolean }>()
  for (const row of outstanding) {
    if (!row.organizationId || !row.sentAt) continue

    const current = waitingBy.get(row.organizationId)
    if (current && current.sentAt <= row.sentAt) continue

    waitingBy.set(row.organizationId, {
      sentAt: row.sentAt,
      viewed: row.firstViewedAt !== null,
    })
  }

  return accounts.map((account) => {
    const deals = pipelineBy.get(account.id)

    return {
      organizationId: account.id,
      name: account.name,
      lifecycleStage: account.lifecycleStage as LifecycleStage,
      isStrategicAccount: account.isStrategicAccount,
      ownerId: account.ownerId,
      lastContactedAt: spoken.get(account.id) ?? null,
      invoicedCents: revenueBy.get(account.id) ?? 0,
      weightedPipelineCents: deals?.cents ?? 0,
      openOpportunities: deals?.open ?? 0,
      oldestUndecidedProposal: waitingBy.get(account.id) ?? null,
      overdueTasks: overdueBy.get(account.id) ?? 0,
    }
  })
}

/**
 * The ranked attention list (§11 "identify neglected high-value prospects").
 *
 * Works with the AI module switched off, which is the point. §11 says the core
 * product must remain fully functional without AI, and identifying a neglected
 * account is arithmetic — putting it behind the gateway would have made the one
 * checkable part of this capability the part that is not.
 */
export async function accountsNeedingAttention(
  ctx: ActorContext,
  opts: { asOf?: Date; limit?: number } = {},
): Promise<AccountAttention[]> {
  const asOf = opts.asOf ?? new Date()
  const ranked = rankAccounts(await accountFacts(ctx, asOf), asOf)

  return opts.limit === undefined ? ranked : ranked.slice(0, opts.limit)
}

/** One account's facts, for the assistant. */
export async function factsForAccount(
  ctx: ActorContext,
  organizationId: string,
  asOf: Date = new Date(),
): Promise<AccountFacts | null> {
  /*
    Measured through the same path as the list rather than a second query of
    its own. A per-account figure computed differently from the list's figure is
    two answers to one question, and the one a person would act on is whichever
    screen they happened to open.
  */
  const all = await accountFacts(ctx, asOf)
  return all.find((account) => account.organizationId === organizationId) ?? null
}
