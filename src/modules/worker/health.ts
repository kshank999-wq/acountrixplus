import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { failedDeliveries } from '@/modules/notify/service'
import { listJobs } from './queue'

/**
 * What has gone wrong lately, in one shape (spec §18, §19).
 *
 * Two things existed and told nobody:
 *
 * > **Nothing retries a dead job automatically, and nothing tells you about
 * > one.** Deliberate for the retry; the missing digest is the obvious next
 * > handler now that the notification machinery it needs exists.
 * >
 * > **Bounced transactional mail is recorded, not surfaced.**
 * > `failedDeliveries` exists and no screen calls it, so nobody is told when
 * > an invitation to a mistyped address never arrived.
 *
 * The same query feeds the digest and the operations page, on purpose. A
 * notification saying "two things failed" and a page showing three is worse
 * than either alone, because now nobody trusts the page.
 */

export type Health = {
  since: Date
  deadJobs: Array<{
    id: string
    kind: string
    lastError: string | null
    finishedAt: Date | null
    attempts: number
  }>
  bouncedMail: Array<{
    id: string
    kind: string
    email: string
    subject: string
    error: string | null
    createdAt: Date
  }>
  /** The number a digest leads with. Zero means say nothing at all. */
  total: number
}

/**
 * Failures in a window, for one company.
 *
 * Dead jobs with no tenant are included deliberately, matching the choice
 * Phase 10 made for the operations page: *housekeeping jobs have no tenant,
 * and hiding them from every company means nobody ever sees them fail.* The
 * alternative is a class of failure only a deployment operator could ever
 * notice, on a deployment that may not have one.
 */
export async function health(
  ctx: ActorContext,
  opts: { since?: Date; limit?: number } = {},
): Promise<Health> {
  requirePermission(ctx, 'company:manage')

  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
  const limit = opts.limit ?? 20

  const [jobs, mail] = await Promise.all([
    listJobs({ companyId: ctx.companyId, status: ['dead'], since, limit }),
    failedDeliveries(ctx.companyId, limit, undefined, since),
  ])

  return {
    since,
    deadJobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      lastError: job.lastError,
      finishedAt: job.finishedAt,
      attempts: job.attempts,
    })),
    bouncedMail: mail,
    total: jobs.length + mail.length,
  }
}
