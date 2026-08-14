import { pruneIdempotencyKeys } from '@/modules/mobile/idempotency'
import { nudgeReviewQueue } from '@/modules/mobile/notifications'
import { listInbox } from '@/modules/bookkeeping/transactions'
import { registerHandler, type JobContext } from '../registry'
import { pruneFinishedJobs } from '../queue'
import { pruneWorkers } from '../runner'

/**
 * Housekeeping.
 *
 * Two of these have existed and been uncalled since Phase 8:
 *
 * > **Nothing schedules the nudge.** `nudgeReviewQueue` works and is tested,
 * > and the only thing that calls it is the seed.
 * >
 * > **Idempotency keys are never pruned automatically.** `pruneIdempotencyKeys`
 * > exists and is tested; nothing calls it on a schedule.
 *
 * Neither needed any code written. They needed something to call them, which
 * is the whole reason this phase exists.
 */

/**
 * The review nudge (ADR 0008).
 *
 * Runs per company and is deliberately *not* a notification per transaction.
 * `nudgeReviewQueue` has a threshold below which it stays quiet — a phone that
 * buzzes on every imported coffee is a phone with notifications switched off
 * by the end of the week.
 */
registerHandler({
  kind: 'mobile.nudge_review',
  label: 'Nudge people about transactions waiting for review',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const waiting = (await listInbox(actor, { states: ['new'], limit: 500 })).rows.length

    const result = await nudgeReviewQueue({
      companyId: actor.companyId,
      userId: actor.userId,
      waiting,
    })

    return { waiting, sent: result.sent }
  },
})

/**
 * Expired idempotency keys (ADR 0008).
 *
 * Global: keys belong to companies but the sweep spans all of them, and
 * enqueueing one job per company to delete a handful of rows each would be a
 * worse use of the queue than one job doing a single ranged delete.
 */
registerHandler({
  kind: 'housekeeping.prune_idempotency_keys',
  label: 'Delete expired idempotency keys',
  global: true,
  handler: async () => {
    const deleted = await pruneIdempotencyKeys()
    return { deleted }
  },
})

/**
 * Finished jobs, and workers that stopped reporting.
 *
 * `dead` jobs are never swept — see `pruneFinishedJobs`. A failure nobody
 * looked at is not evidence to be tidied away.
 */
registerHandler({
  kind: 'housekeeping.prune_jobs',
  label: 'Delete succeeded and cancelled jobs older than 14 days',
  global: true,
  handler: async (context: JobContext) => {
    const days = Number(context.payload.days ?? 14)
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const jobs = await pruneFinishedJobs(before)
    const workers = await pruneWorkers(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))

    return { jobsDeleted: jobs, workersForgotten: workers, olderThanDays: days }
  },
})
