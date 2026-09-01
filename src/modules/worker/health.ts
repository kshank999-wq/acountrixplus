import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { failedDeliveries } from '@/modules/notify/service'
import { sendingCounts } from '@/modules/marketing/analytics'
import {
  REPUTATION_WINDOW_DAYS,
  sendingHealth,
  type SendingHealth,
} from '@/modules/marketing/reputation'
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
  /**
   * How this company's sending looks to a mailbox provider (Phase 84).
   *
   * `null` below the volume floor, which is not the same as healthy — see
   * `sendingHealth`. Measured over its own, longer window: a bounce arrives
   * days after the send, so the digest's twenty-four hours would miss the
   * bounces those sends are about to produce.
   */
  sending: SendingHealth | null
  /** The number a digest leads with. Zero means say nothing at all. */
  total: number
  /**
   * Whether there is anything worth saying.
   *
   * Not just `total > 0` since Phase 84. A sending reputation going bad is not
   * a count of things that failed — nothing failed, and that is exactly what
   * makes it easy to miss until the domain is spent.
   */
  worthSaying: boolean
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
  opts: { since?: Date; limit?: number; reputationSince?: Date } = {},
): Promise<Health> {
  requirePermission(ctx, 'company:manage')

  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
  const limit = opts.limit ?? 20

  const reputationSince =
    opts.reputationSince ??
    new Date(Date.now() - REPUTATION_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [jobs, mail, counts] = await Promise.all([
    listJobs({ companyId: ctx.companyId, status: ['dead'], since, limit }),
    failedDeliveries(ctx.companyId, limit, undefined, since),
    sendingCounts(ctx.companyId, reputationSince),
  ])

  const sending = sendingHealth(counts)
  const total = jobs.length + mail.length

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
    sending,
    total,
    worthSaying: total > 0 || (sending !== null && sending.level !== 'ok'),
  }
}
