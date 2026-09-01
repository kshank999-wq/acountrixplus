import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  campaignEvents,
  campaignRecipients,
  campaigns,
  opportunities,
  organizations,
  tasks,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { basisPoints } from '@/modules/crm/analytics'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'

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
  */
  const sent = rows.filter(
    (row) => row.status !== 'skipped' && row.status !== 'failed' && row.status !== 'pending',
  )

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
      sent: sql<string>`count(*) FILTER (WHERE ${campaignRecipients.status} NOT IN ('skipped','bounced','pending'))`,
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
