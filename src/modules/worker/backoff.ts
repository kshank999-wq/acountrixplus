/**
 * Retry timing. Pure, so the schedule is testable without waiting for it.
 *
 * Lives in its own file because the only way to have confidence in a backoff
 * policy is to assert the actual numbers, and the only way to do that cheaply
 * is for it to be a function of an integer rather than of a database.
 */

/** Base delay in milliseconds. Doubles each attempt. */
export const BASE_DELAY_MS = 10_000

/** Nothing waits longer than this, however many times it has failed. */
export const MAX_DELAY_MS = 60 * 60 * 1000

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * Exponential, capped, and **jittered**. The jitter is not decoration: a
 * provider outage fails every queued job at once, and without jitter they all
 * retry at the same instant, hit the still-broken provider together, and
 * synchronise harder on each round. Spreading them means the recovery is
 * discovered by one job rather than by all of them colliding.
 *
 * The jitter is proportional and one-sided — it only ever delays. Retrying
 * *earlier* than the policy says is the one direction that cannot help.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exponential = BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1)
  const capped = Math.min(exponential, MAX_DELAY_MS)

  // Up to 25% on top. Bounded so a cap of an hour cannot become an hour and a
  // quarter without somebody having decided that.
  return Math.round(capped * (1 + random() * 0.25))
}

/** When a job that has just failed should next be attempted. */
export function nextAttemptAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + backoffMs(attempts, random))
}

/**
 * How long a claim is honoured before another worker may take the job.
 *
 * This is the number that decides how bad a killed worker is. Too short and a
 * slow-but-healthy job gets run twice concurrently; too long and a crashed
 * worker's jobs sit untouched. Fifteen minutes is longer than any handler here
 * should take and short enough that a crash is not an outage — and it is safe
 * either way, because handlers must tolerate running twice regardless.
 */
export const CLAIM_TIMEOUT_MS = 15 * 60 * 1000

/** Whether a claim taken at `lockedAt` has expired and may be stolen. */
export function claimExpired(lockedAt: Date | null, now: Date): boolean {
  if (!lockedAt) return true
  return now.getTime() - lockedAt.getTime() > CLAIM_TIMEOUT_MS
}
