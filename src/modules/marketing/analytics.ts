import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  campaignEvents,
  campaignRecipients,
  campaigns,
  opportunities,
  organizations,
  sendingSnapshots,
  tasks,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { basisPoints } from '@/modules/crm/analytics'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { CampaignSending } from './attribution'
import { ACCEPTED_BY_PROVIDER, wasAccepted, type SendingCounts } from './reputation'
import type { Reading } from './trend'

/**
 * "Did a provider take this message", in SQL (Phase 85).
 *
 * The same list `wasAccepted` applies in TypeScript, so the three counts in
 * this file cannot drift apart again — which they had, in the one file where
 * the disagreement was hardest to see.
 */
const acceptedByProvider = inArray(campaignRecipients.status, [...ACCEPTED_BY_PROVIDER])

/**
 * Campaign analytics (spec §10).
 *
 * Rates are basis points, consistent with the sales analytics — an integer
 * percentage rather than a float that renders differently everywhere.
 *
 * Denominators are chosen to answer the question a marketer is actually
 * asking: open rate is over messages *sent*, not over everyone who matched the
 * segment, because people who were skipped for consent never had a chance to
 * open anything.
 */

export type CampaignStats = {
  campaignId: string
  matched: number
  sent: number
  skipped: number
  /** The provider would not take it. Ours, and usually transient (Phase 83). */
  failed: number
  /** The receiving server rejected it after the provider took it. */
  bounced: number
  complained: number
  opened: number
  clicked: number
  unsubscribed: number

  openRateBp: number
  clickRateBp: number
  /** Clicks as a share of opens — how compelling the message was. */
  clickThroughRateBp: number
  unsubscribeRateBp: number
  bounceRateBp: number
  complaintRateBp: number

  skipReasons: Record<string, number>
}

export async function campaignStats(
  ctx: ActorContext,
  campaignId: string,
): Promise<CampaignStats> {
  requirePermission(ctx, 'marketing:view')

  const rows = await db
    .select({
      status: campaignRecipients.status,
      skipReason: campaignRecipients.skipReason,
      openedAt: campaignRecipients.openedAt,
      clickedAt: campaignRecipients.clickedAt,
      unsubscribedAt: campaignRecipients.unsubscribedAt,
    })
    .from(campaignRecipients)
    .where(scoped(ctx, campaignRecipients, eq(campaignRecipients.campaignId, campaignId)))

  const skipped = rows.filter((row) => row.status === 'skipped')
  const failed = rows.filter((row) => row.status === 'failed')
  const bounced = rows.filter((row) => row.status === 'bounced')
  const complained = rows.filter((row) => row.status === 'complained')

  /*
    Anything a provider accepted.

    A `failed` row never reached one, so it is out — that used to be counted as
    `bounced` and excluded here for the same reason, which happened to give the
    right denominator for the wrong reason. A `bounced` row *was* accepted and
    then rejected downstream, so it stays in the denominator: a bounce rate
    computed against sends that excluded the bounces would flatter itself.

    Since Phase 85 the rule is `wasAccepted` rather than a status list written
    out here, because it had been written out three times in this file and one
    of the three disagreed.
  */
  const sent = rows.filter((row) => wasAccepted(row.status))

  const opened = rows.filter((row) => row.openedAt !== null)
  const clicked = rows.filter((row) => row.clickedAt !== null)
  const unsubscribed = rows.filter((row) => row.unsubscribedAt !== null)

  const skipReasons: Record<string, number> = {}
  for (const row of skipped) {
    const reason = row.skipReason ?? 'unknown'
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
  }

  return {
    campaignId,
    matched: rows.length,
    sent: sent.length,
    skipped: skipped.length,
    failed: failed.length,
    bounced: bounced.length,
    complained: complained.length,
    opened: opened.length,
    clicked: clicked.length,
    unsubscribed: unsubscribed.length,

    openRateBp: basisPoints(opened.length, sent.length),
    clickRateBp: basisPoints(clicked.length, sent.length),
    clickThroughRateBp: basisPoints(clicked.length, opened.length),
    unsubscribeRateBp: basisPoints(unsubscribed.length, sent.length),
    bounceRateBp: basisPoints(bounced.length, sent.length),
    complaintRateBp: basisPoints(complained.length, sent.length),

    skipReasons,
  }
}

export type MarketingOverview = {
  campaignCount: number
  sentCount: number
  totalSent: number
  totalOpened: number
  totalClicked: number
  totalUnsubscribed: number
  openRateBp: number
  clickRateBp: number
  /** Open follow-up tasks raised by engagement (spec §10 sales loop). */
  openTasks: number
  /** Organizations that engaged and have a lost deal worth reopening. */
  reEngagementCandidates: number
}

/** Headline figures across every campaign. */
export async function marketingOverview(ctx: ActorContext): Promise<MarketingOverview> {
  requirePermission(ctx, 'marketing:view')

  const [totals] = await db
    .select({
      total: sql<string>`count(*)`,
      /*
        Was `NOT IN ('skipped','bounced','pending')` until Phase 85, which is
        the same question answered a third way and answered wrongly: it dropped
        the bounces out of the denominator and — never revisited when Phase 83
        added the status — counted `failed` rows a provider never took as sent.
        Every rate on the marketing dashboard was computed against it.
      */
      sent: sql<string>`count(*) FILTER (WHERE ${acceptedByProvider})`,
      opened: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.openedAt} IS NOT NULL)`,
      clicked: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.clickedAt} IS NOT NULL)`,
      unsubscribed: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.unsubscribedAt} IS NOT NULL)`,
    })
    .from(campaignRecipients)
    .where(scoped(ctx, campaignRecipients))

  const [campaignCounts] = await db
    .select({
      total: sql<string>`count(*)`,
      sent: sql<string>`count(*) FILTER (WHERE ${campaigns.status} = 'sent')`,
    })
    .from(campaigns)
    .where(scoped(ctx, campaigns))

  const [taskCount] = await db
    .select({ total: sql<string>`count(*)` })
    .from(tasks)
    .where(scoped(ctx, tasks, eq(tasks.status, 'open')))

  const sent = Number(totals?.sent ?? 0)
  const opened = Number(totals?.opened ?? 0)
  const clicked = Number(totals?.clicked ?? 0)

  return {
    campaignCount: Number(campaignCounts?.total ?? 0),
    sentCount: Number(campaignCounts?.sent ?? 0),
    totalSent: sent,
    totalOpened: opened,
    totalClicked: clicked,
    totalUnsubscribed: Number(totals?.unsubscribed ?? 0),
    openRateBp: basisPoints(opened, sent),
    clickRateBp: basisPoints(clicked, sent),
    openTasks: Number(taskCount?.total ?? 0),
    reEngagementCandidates: await countReEngagementCandidates(ctx),
  }
}

/**
 * Organizations that clicked something *and* have a lost or dormant deal
 * marked eligible for nurture (spec §9, §10).
 *
 * The population worth a salesperson's attention: they showed interest, and
 * there is a deal on record to reopen.
 */
async function countReEngagementCandidates(ctx: ActorContext): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`count(DISTINCT ${opportunities.organizationId})` })
    .from(opportunities)
    .innerJoin(
      campaignRecipients,
      eq(campaignRecipients.organizationId, opportunities.organizationId),
    )
    .where(
      and(
        eq(opportunities.companyId, ctx.companyId),
        inArray(opportunities.stage, ['lost', 'dormant']),
        eq(opportunities.marketingEligible, true),
        sql`${campaignRecipients.clickedAt} IS NOT NULL`,
      ),
    )

  return Number(row?.total ?? 0)
}

export type ReEngagementRow = {
  organizationId: string
  organizationName: string
  opportunityId: string
  opportunityTitle: string
  lossReason: string | null
  lastClickedAt: Date | null
  campaignName: string | null
}

/** The lost-opportunity nurture dashboard (spec §9, §10). */
export async function reEngagementCandidates(ctx: ActorContext): Promise<ReEngagementRow[]> {
  requirePermission(ctx, 'marketing:view')

  const rows = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      opportunityId: opportunities.id,
      opportunityTitle: opportunities.title,
      lossReason: opportunities.lossReason,
      lastClickedAt: campaignRecipients.clickedAt,
      campaignName: campaigns.name,
    })
    .from(opportunities)
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .innerJoin(
      campaignRecipients,
      eq(campaignRecipients.organizationId, opportunities.organizationId),
    )
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(
      and(
        eq(opportunities.companyId, ctx.companyId),
        inArray(opportunities.stage, ['lost', 'dormant']),
        eq(opportunities.marketingEligible, true),
        sql`${campaignRecipients.clickedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(campaignRecipients.clickedAt))
    .limit(100)

  // One row per opportunity, keeping the most recent click.
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.opportunityId)) return false
    seen.add(row.opportunityId)
    return true
  })
}

/** Recent engagement events, for a campaign's activity feed. */
export async function recentEvents(ctx: ActorContext, campaignId?: string, limit = 50) {
  requirePermission(ctx, 'marketing:view')

  return db
    .select({
      id: campaignEvents.id,
      kind: campaignEvents.kind,
      url: campaignEvents.url,
      occurredAt: campaignEvents.occurredAt,
      email: campaignRecipients.email,
      campaignName: campaigns.name,
    })
    .from(campaignEvents)
    .innerJoin(campaignRecipients, eq(campaignRecipients.id, campaignEvents.recipientId))
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(
      scoped(
        ctx,
        campaignEvents,
        campaignId ? eq(campaignRecipients.campaignId, campaignId) : undefined,
      ),
    )
    .orderBy(desc(campaignEvents.occurredAt))
    .limit(limit)
}

/** Open follow-up tasks raised by engagement (spec §10). */
export async function openTasks(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      detail: tasks.detail,
      dueOn: tasks.dueOn,
      organizationId: tasks.organizationId,
      organizationName: organizations.name,
    })
    .from(tasks)
    .leftJoin(organizations, eq(organizations.id, tasks.organizationId))
    .where(scoped(ctx, tasks, eq(tasks.status, 'open')))
    .orderBy(tasks.dueOn)
    .limit(50)
}

export async function completeTask(ctx: ActorContext, taskId: string) {
  requirePermission(ctx, 'crm:manage')

  await db.transaction(async (tx) => {
    const [done] = await tx
      .update(tasks)
      .set({ status: 'done', completedAt: new Date() })
      .where(
        and(eq(tasks.id, taskId), eq(tasks.companyId, ctx.companyId), eq(tasks.status, 'open')),
      )
      .returning({ id: tasks.id, title: tasks.title })

    if (!done) return

    await recordAudit(
      ctx,
      {
        action: 'task.complete',
        entityType: 'task',
        entityId: done.id,
        after: { title: done.title },
      },
      tx,
    )
  })
}

/** Campaigns scheduled in a window, for the calendar (spec §10). */
export async function campaignCalendar(ctx: ActorContext, fromDate: Date) {
  requirePermission(ctx, 'marketing:view')

  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      kind: campaigns.kind,
      status: campaigns.status,
      scheduledFor: campaigns.scheduledFor,
    })
    .from(campaigns)
    .where(scoped(ctx, campaigns, gte(campaigns.scheduledFor, fromDate)))
    .orderBy(campaigns.scheduledFor)
}

/**
 * What this company's sending looks like to a mailbox provider (Phase 84).
 *
 * Counted over recipients *sent* in the window rather than events recorded in
 * it, because the question is "of the mail we sent, how much failed" — an
 * event-window count would divide this week's bounces by this week's sends and
 * mix two different cohorts.
 *
 * Takes a `companyId` rather than an actor: the caller is the failure digest,
 * running on the worker, which has already established who it is acting for.
 */
export async function sendingCounts(
  companyId: string,
  since: Date,
): Promise<SendingCounts> {
  const [row] = await db
    .select({
      // Everything a provider accepted. `failed` never reached one and
      // `skipped` was never sent, so neither belongs in the denominator.
      accepted: sql<string>`count(*) FILTER (WHERE ${acceptedByProvider})`,
      bounced: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.status} = 'bounced')`,
      complained: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.status} = 'complained')`,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.companyId, companyId),
        gte(campaignRecipients.sentAt, since),
      ),
    )

  return {
    accepted: Number(row?.accepted ?? 0),
    bounced: Number(row?.bounced ?? 0),
    complained: Number(row?.complained ?? 0),
  }
}

/**
 * The same counts, split by campaign (Phase 85).
 *
 * Every campaign that sent anything in the window, not only the bad ones: the
 * attribution core needs the whole set to work out whether removing one would
 * bring the rest back under the line, and a query that pre-filtered to the
 * campaigns that look bad would be answering the maximum question rather than
 * the counterfactual one.
 *
 * Only run when there is something to attribute. It is a group-by over the
 * same rows `sendingCounts` scans, and a quiet week should cost one query.
 */
export async function sendingByCampaign(
  companyId: string,
  since: Date,
): Promise<CampaignSending[]> {
  const rows = await db
    .select({
      campaignId: campaigns.id,
      name: campaigns.name,
      accepted: sql<string>`count(*) FILTER (WHERE ${acceptedByProvider})`,
      bounced: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.status} = 'bounced')`,
      complained: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.status} = 'complained')`,
    })
    .from(campaignRecipients)
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(
      and(
        eq(campaignRecipients.companyId, companyId),
        gte(campaignRecipients.sentAt, since),
      ),
    )
    .groupBy(campaigns.id, campaigns.name)

  return rows.map((row) => ({
    campaignId: row.campaignId,
    name: row.name,
    accepted: Number(row.accepted),
    bounced: Number(row.bounced),
    complained: Number(row.complained),
  }))
}

/**
 * Write down today's reading (Phase 86).
 *
 * Called by the daily digest on every run — **including the quiet ones**. A
 * record that only holds the bad days is blank on exactly the days that are the
 * baseline, which is the flaw in the accidental history
 * `background_jobs.result` has held since Phase 84.
 *
 * `takenOn` is a parameter rather than a clock read, the rule Phase 16 applied
 * to depreciation and Phase 24 to the retention cutoff: a snapshot that reads
 * the clock cannot be asked "what would you have written last Tuesday", and
 * cannot be asserted on.
 *
 * Idempotent on the day. The digest is scheduled daily and a worker restart can
 * run it twice; the second run replaces the first rather than adding a second
 * reading for the same date.
 */
export async function recordSendingSnapshot(
  companyId: string,
  counts: SendingCounts,
  takenOn: Date,
  windowDays: number,
): Promise<void> {
  await db
    .insert(sendingSnapshots)
    .values({
      companyId,
      takenOn: takenOn.toISOString().slice(0, 10),
      windowDays,
      accepted: counts.accepted,
      bounced: counts.bounced,
      complained: counts.complained,
    })
    .onConflictDoUpdate({
      target: [sendingSnapshots.companyId, sendingSnapshots.takenOn],
      set: {
        windowDays,
        accepted: counts.accepted,
        bounced: counts.bounced,
        complained: counts.complained,
      },
    })
}

/**
 * The readings, most recent last (Phase 86).
 *
 * Takes a `companyId` rather than an actor for the same reason `sendingCounts`
 * does: the caller is the digest, running on the worker, which has already
 * established who it is acting for. The operations page reaches it through
 * `health`, which does the permission check.
 */
export async function sendingHistory(
  companyId: string,
  since: Date,
): Promise<Reading[]> {
  const rows = await db
    .select({
      takenOn: sendingSnapshots.takenOn,
      accepted: sendingSnapshots.accepted,
      bounced: sendingSnapshots.bounced,
      complained: sendingSnapshots.complained,
    })
    .from(sendingSnapshots)
    .where(
      and(
        eq(sendingSnapshots.companyId, companyId),
        gte(sendingSnapshots.takenOn, since.toISOString().slice(0, 10)),
      ),
    )
    .orderBy(sendingSnapshots.takenOn)

  return rows
}
