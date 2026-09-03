import { guardFor, type GuardedAct } from './reauthentication'

/**
 * Counting the guessing at a guarded act (Phase 100).
 *
 * ## The guard nobody counted
 *
 * Phase 99 made four acts ask for the password. It refuses a wrong one and does
 * nothing else: no record, no limit, and no word to the person whose account it
 * is. Its own ADR said so:
 *
 * > Somebody guessing at an unattended laptop can try the password on four acts
 * > as often as they like and nothing is recorded, nothing is rate limited, and
 * > the account's owner is never told — while `login_attempts` has counted
 * > exactly this since Phase 13 for the sign-in form one page away.
 *
 * A guess against the sign-in form is bounded at ten in fifteen minutes and
 * shows up on a screen. A guess against the same password, from inside a
 * session, was free and invisible. That is the wrong way round: somebody typing
 * into the sign-in form might be the owner on a new laptop, while somebody
 * typing into the security page is already holding a live session, which is a
 * far stronger signal that something is wrong.
 *
 * ## The judgement: this limits the act, not the account
 *
 * The obvious move — a new `login_outcome` and rows in `login_attempts` — is
 * refused, and the reason is worth writing down because the code makes it look
 * safe.
 *
 * `lockoutState` counts **every** row in its window that is not `success` and
 * not `locked_out`. A `wrong_reauth` row would therefore be counted as a failed
 * sign-in, and five fumbles on the security page would lock the account out of
 * signing in. That hands somebody who has a session — the exact person this
 * guard exists to stop — a way to lock the real owner out of their own books.
 * The guard would become a weapon.
 *
 * So a failed re-authentication bounds **the act it was for**, for a cool-off,
 * and touches signing in not at all. The owner can always still sign in; what
 * they cannot do for a quarter of an hour is keep guessing at their own
 * recovery codes.
 *
 * ## The judgement: it is keyed on the person, not the address
 *
 * `login_attempts` is keyed on an email because at sign-in time that is all
 * anybody knows. Here the person is signed in and the session says exactly who
 * they are, so the count is per user and per act. Two different questions, and
 * giving them one table is what would have produced the defect above.
 *
 * ## The judgement: the owner is told once, not five times
 *
 * A run of wrong passwords at somebody's own security page is the one signal
 * only they can act on. But telling on the first is noise — people mistype —
 * and telling on each is a mailbox full of the same sentence. So the warning
 * goes out exactly as the count crosses the limit, and not again while it stays
 * over.
 *
 * Nothing here touches the database. `now` is passed in.
 */

/** How many wrong passwords at one act before it stops accepting them. */
export const GUARD_MAX_ATTEMPTS = 5

/** How long the act stays shut, and the window the failures are counted over. */
export const GUARD_COOLOFF_MINUTES = 15

export type GuardAttempt = {
  act: GuardedAct
  /** Whether the password was right. A success clears the run. */
  ok: boolean
  at: Date
}

export type GuardStanding = {
  /** True when this act will not accept another attempt yet. */
  blocked: boolean
  failedCount: number
  /** When it opens again, or null when it is open. */
  retryAfter: Date | null
  /**
   * True on exactly the attempt that crossed the limit.
   *
   * Not "true while blocked": that would send the same letter on every retry,
   * and a mailbox full of one sentence is a mailbox nobody reads.
   */
  shouldWarn: boolean
}

/**
 * Where this act stands, given its recent attempts newest-first.
 *
 * Walking newest-first and stopping at a success is `lockoutState`'s shape and
 * is deliberate: getting it right once clears the run, so somebody who mistyped
 * four times and then remembered is not held for a quarter of an hour.
 */
export function standingFrom(
  attempts: GuardAttempt[],
  opts: { now?: Date; max?: number; minutes?: number } = {},
): GuardStanding {
  const now = opts.now ?? new Date()
  const max = opts.max ?? GUARD_MAX_ATTEMPTS
  const minutes = opts.minutes ?? GUARD_COOLOFF_MINUTES
  const windowStart = now.getTime() - minutes * 60_000

  let failedCount = 0
  let oldestFailure: Date | null = null

  for (const attempt of attempts) {
    if (attempt.at.getTime() < windowStart) break
    if (attempt.ok) break

    failedCount++
    oldestFailure = attempt.at
  }

  if (failedCount < max || !oldestFailure) {
    return { blocked: false, failedCount, retryAfter: null, shouldWarn: false }
  }

  return {
    blocked: true,
    failedCount,
    retryAfter: new Date(oldestFailure.getTime() + minutes * 60_000),
    // Exactly at the limit, not above it.
    shouldWarn: failedCount === max,
  }
}

/**
 * What somebody reads when the act has stopped accepting attempts.
 *
 * Says the account is untouched, because the honest worry at that moment is
 * that guessing has locked them out of everything — and it has not.
 */
export function blockedMessage(standing: GuardStanding, now = new Date()): string {
  const minutes = standing.retryAfter
    ? Math.max(1, Math.ceil((standing.retryAfter.getTime() - now.getTime()) / 60_000))
    : GUARD_COOLOFF_MINUTES

  return (
    `That is not your password, and there have been ${standing.failedCount} wrong ones. ` +
    `Try this again in ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
    'You can still sign in as normal — nothing about the account has changed.'
  )
}

/**
 * The letter the account's owner gets, once per run.
 *
 * No link, on Phase 98's rule: a letter warning somebody their session may be
 * in the wrong hands must not also carry a way to act on the account.
 */
export function warningLetter(input: {
  act: GuardedAct
  failedCount: number
  companyName: string
}): { subject: string; body: string[] } {
  const what = guardFor(input.act).prompt.toLowerCase()

  return {
    subject: `Somebody is guessing your password on ${input.companyName}`,
    body: [
      `There have been ${input.failedCount} wrong passwords in a row on your ${input.companyName} security page, at the box asking for ${what}.`,
      'That box is only reachable from a signed-in session, so either you mistyped several times, or somebody else is using a session of yours.',
      'If it was not you: sign in, change your password, and end the other sessions from the security page. That page lists every device signed in.',
      'This message carries no link, deliberately. Nothing about the account has changed, and signing in still works as it always did.',
    ],
  }
}
