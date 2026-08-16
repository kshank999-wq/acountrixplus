import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { opportunities, opportunityActivities } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { communicationsForOrganization, type CommunicationRow } from './communications'
import { tasksForOrganization, type TaskRow } from './tasks'

/**
 * One chronological view of a client relationship (spec §6 "communications,
 * files, and activity history").
 *
 * Three sources, merged in memory rather than in SQL. A `UNION` over three
 * tables with different shapes would need a lowest-common-denominator row
 * type, and each source would lose the columns that make it worth showing —
 * the direction of a call, the assignee on a task, the before-and-after of a
 * stage change.
 *
 * The cost is that pagination is approximate: each source is capped, then the
 * merge is capped. For a relationship timeline that is the right trade —
 * nobody scrolls to entry four hundred, and the alternative is a query nobody
 * can read.
 */

export type TimelineEntry =
  | { kind: 'communication'; at: Date; data: CommunicationRow }
  | { kind: 'task'; at: Date; data: TaskRow }
  | {
      kind: 'activity'
      at: Date
      data: { id: string; activityKind: string; summary: string; actorName: string | null }
    }

/**
 * Everything that has happened with one client, newest first.
 *
 * Activity comes from every opportunity belonging to the client, not just the
 * open one — "when did we last do anything with these people" spans deals, and
 * a timeline that reset with each new opportunity would answer the wrong
 * question.
 */
export async function organizationTimeline(
  ctx: ActorContext,
  organizationId: string,
  limit = 60,
): Promise<TimelineEntry[]> {
  requirePermission(ctx, 'crm:view')

  const deals = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(scoped(ctx, opportunities, eq(opportunities.organizationId, organizationId)))

  const [exchanges, work, activity] = await Promise.all([
    communicationsForOrganization(ctx, organizationId, limit),
    tasksForOrganization(ctx, organizationId),
    deals.length
      ? db
          .select({
            id: opportunityActivities.id,
            activityKind: opportunityActivities.kind,
            summary: opportunityActivities.summary,
            actorName: opportunityActivities.actorName,
            occurredAt: opportunityActivities.occurredAt,
          })
          .from(opportunityActivities)
          .where(
            scoped(
              ctx,
              opportunityActivities,
              inArray(
                opportunityActivities.opportunityId,
                deals.map((deal) => deal.id),
              ),
            ),
          )
          .orderBy(desc(opportunityActivities.occurredAt))
          .limit(limit)
      : Promise.resolve([]),
  ])

  const entries: TimelineEntry[] = [
    ...exchanges.map((row) => ({ kind: 'communication' as const, at: row.occurredAt, data: row })),
    ...activity.map(({ occurredAt, ...row }) => ({
      kind: 'activity' as const,
      at: occurredAt,
      data: row,
    })),
    // A task appears at the moment it matters: when it was finished, or on the
    // day it is due. An open follow-up dated next Tuesday belongs at the top of
    // the timeline, not buried at the point somebody typed it.
    ...work.map((row) => ({
      kind: 'task' as const,
      at: row.completedAt ?? (row.dueOn ? new Date(`${row.dueOn}T12:00:00Z`) : new Date()),
      data: row,
    })),
  ]

  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
}
