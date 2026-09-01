/**
 * Which client needs somebody today (Phase 87).
 *
 * ## The queue that asks one question
 *
 * Phase 18 built the firm's work queue — the one query in this application
 * that legitimately crosses tenants, written so it cannot be pointed anywhere
 * but at the caller's own live engagements. It reports **one signal**:
 * `awaitingReview`, the count of bank transactions waiting to be categorized.
 *
 * That is the least urgent thing on the list. Since then the application has
 * learned to notice, one client at a time, that the books disagree with
 * themselves (Phase 33), that background work has given up and letters have
 * bounced (Phase 24), and that a sending domain is going bad and which way it
 * is heading (Phases 84 to 86). Every one of those outranks a categorization
 * backlog, and none of them is on the page a firm actually opens. An accountant
 * with twelve clients would have to open twelve operations pages to find out
 * which one needs them — which means they will open none.
 *
 * ## The judgement: a ladder, not a score
 *
 * The tempting answer is a health score per client. It is the wrong one: it
 * compresses incomparable things into a number nobody can argue with, sorts by
 * it, and hides which thing is actually wrong. "Northgate: 62" tells you
 * nothing you can do.
 *
 * So the concerns are ranked by **what happens if you leave it until next
 * week**, which is a question each kind has a different answer to:
 *
 *  - `wrong` — the books disagree with themselves. Leave it and something gets
 *    filed that is not true. Nothing outranks this.
 *  - `spending` — it is getting worse on its own. ADR 0084's whole argument: a
 *    sending reputation is the one failure here that costs more the longer
 *    nobody acts, because the provider is scoring the sender the entire time.
 *  - `stuck` — the machine gave up. It is not getting worse, but nothing will
 *    move it without a person.
 *  - `waiting` — work waiting for a human. The normal state of bookkeeping, and
 *    therefore not news.
 *  - `unchecked` — nobody has looked. Quiet, and deliberately not `clear`.
 *  - `clear` — looked, and nothing wrong.
 *
 * ## Two rules this shares with the phases before it
 *
 * **A count without an age is not a signal.** Forty transactions waiting is
 * Tuesday. Forty transactions whose oldest is from June is a client nobody is
 * serving, and the count alone cannot tell you which you have. So `waiting`
 * orders by age, not by size.
 *
 * **"Never checked" is not "clean".** A company whose integrity checks have
 * never run gets `unchecked`, not `clear` — the same distinction `sendingHealth`
 * draws with `null` rather than `ok`, and `trendFor` draws between "we do not
 * know yet" and "it is steady". A roster that showed a green tick for a company
 * nobody has ever examined would be lying quietly, at scale.
 *
 * Nothing here touches the database or the clock.
 */

/** How long a backlog can sit before its age is the story rather than its size. */
export const STALE_BACKLOG_DAYS = 30

/**
 * How old an integrity run may be and still count as having looked.
 *
 * The check is scheduled nightly, so a fortnight means the job has been failing
 * or the worker has been down — either way nobody knows the state of these
 * books, which is a different fact from knowing they are fine.
 */
export const STALE_CHECK_DAYS = 14

export type Rung = 'wrong' | 'spending' | 'stuck' | 'waiting' | 'unchecked' | 'clear'

/** Worst first. The array *is* the ordering; there is no numeric score. */
export const RUNGS: readonly Rung[] = [
  'wrong',
  'spending',
  'stuck',
  'waiting',
  'unchecked',
  'clear',
]

export type ClientFacts = {
  /** Bank transactions nobody has decided about yet. */
  awaitingReview: number
  /** The oldest of them, `YYYY-MM-DD`, or null when there are none. */
  oldestAwaiting: string | null
  /** From the latest integrity run, or null when there has never been one. */
  integrity: { asOf: string; faults: number; errors: number } | null
  deadJobs: number
  bouncedMail: number
  /** From the sending reputation, or null below the volume floor. */
  sending: { level: 'ok' | 'watch' | 'urgent'; worsening: boolean } | null
}

export type Triage = {
  rung: Rung
  /** The one thing to say about this client, or null when there is nothing. */
  headline: string | null
  /** How many other concerns there are, so a row can say "and 2 more". */
  others: number
  /**
   * Orders clients on the same rung. Larger is more urgent.
   *
   * Only ever compared against another client on the *same* rung, so it never
   * has to make two different kinds of problem commensurable — which is the
   * thing a health score gets wrong.
   */
  weight: number
}

type Concern = { rung: Rung; headline: string; weight: number }

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function daysSince(day: string, asOf: Date): number {
  const then = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(then)) return 0
  const today = Date.parse(`${asOf.toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.round((today - then) / (24 * 60 * 60 * 1000))
}

/**
 * What most needs attention at one client, and how much else there is.
 *
 * `asOf` is a parameter rather than a clock read — the rule Phase 16 applied to
 * depreciation, Phase 24 to the retention cutoff and Phase 86 to the daily
 * reading. A triage that reads the clock cannot be asked what it would have
 * said on Monday, and cannot be asserted on.
 */
export function triageFor(facts: ClientFacts, asOf: Date): Triage {
  const concerns: Concern[] = []

  if (facts.integrity && facts.integrity.faults > 0) {
    concerns.push({
      rung: 'wrong',
      headline: `${plural(facts.integrity.faults, 'check disagrees', 'checks disagree')} with the ledger`,
      weight: facts.integrity.faults,
    })
  }

  /*
    A check that threw is not a check that passed. It is its own admission —
    nobody knows whether those two sides agree — so it is `unchecked` rather
    than `wrong`, and it is never silently counted as clean.
  */
  if (facts.integrity && facts.integrity.errors > 0) {
    concerns.push({
      rung: 'unchecked',
      headline: `${plural(facts.integrity.errors, 'check', 'checks')} could not run`,
      weight: facts.integrity.errors,
    })
  }

  if (facts.sending && facts.sending.level !== 'ok') {
    concerns.push({
      rung: 'spending',
      headline:
        facts.sending.level === 'urgent'
          ? 'Marketing email is bouncing past the level providers act on'
          : 'Marketing email is bouncing more than it should',
      weight: facts.sending.level === 'urgent' ? 2 : 1,
    })
  } else if (facts.sending && facts.sending.worsening) {
    // Still under every threshold, and heading the wrong way. The weeks of
    // warning Phase 84 was built for, finally early enough to be weeks.
    concerns.push({
      rung: 'spending',
      headline: 'Marketing email is still fine and getting worse',
      weight: 0,
    })
  }

  const gaveUp = facts.deadJobs + facts.bouncedMail
  if (gaveUp > 0) {
    const parts: string[] = []
    if (facts.deadJobs > 0) parts.push(plural(facts.deadJobs, 'job', 'jobs'))
    if (facts.bouncedMail > 0) parts.push(plural(facts.bouncedMail, 'letter', 'letters'))
    concerns.push({
      rung: 'stuck',
      headline: `${parts.join(' and ')} gave up`,
      weight: gaveUp,
    })
  }

  if (facts.awaitingReview > 0) {
    const age = facts.oldestAwaiting ? daysSince(facts.oldestAwaiting, asOf) : 0
    concerns.push({
      rung: 'waiting',
      headline:
        age >= STALE_BACKLOG_DAYS
          ? `${facts.awaitingReview} waiting, oldest ${age} days`
          : `${facts.awaitingReview} waiting to be categorized`,
      // Age, not count. Forty transactions is Tuesday; forty that start in
      // June is a client nobody is serving.
      weight: age,
    })
  }

  /*
    Nobody has looked. Not the same as nothing being wrong, and a roster that
    showed a green tick for a company nobody has ever examined would be lying
    quietly, at scale.
  */
  if (facts.integrity === null) {
    concerns.push({
      rung: 'unchecked',
      headline: 'The books have never been checked',
      weight: 0,
    })
  } else if (daysSince(facts.integrity.asOf, asOf) >= STALE_CHECK_DAYS) {
    concerns.push({
      rung: 'unchecked',
      headline: `Last checked ${daysSince(facts.integrity.asOf, asOf)} days ago`,
      weight: daysSince(facts.integrity.asOf, asOf),
    })
  }

  if (concerns.length === 0) {
    return { rung: 'clear', headline: null, others: 0, weight: 0 }
  }

  concerns.sort((a, b) => {
    const byRung = RUNGS.indexOf(a.rung) - RUNGS.indexOf(b.rung)
    return byRung !== 0 ? byRung : b.weight - a.weight
  })

  const worst = concerns[0]
  return {
    rung: worst.rung,
    headline: worst.headline,
    others: concerns.length - 1,
    weight: worst.weight,
  }
}

/**
 * Worst client first, then alphabetically.
 *
 * Alphabetical rather than by size within a rung when the weights tie, so the
 * roster does not reshuffle itself between page loads for no reason a reader
 * could see.
 */
export function byUrgency<T extends { triage: Triage; companyName: string }>(
  a: T,
  b: T,
): number {
  const byRung = RUNGS.indexOf(a.triage.rung) - RUNGS.indexOf(b.triage.rung)
  if (byRung !== 0) return byRung

  const byWeight = b.triage.weight - a.triage.weight
  if (byWeight !== 0) return byWeight

  return a.companyName.localeCompare(b.companyName)
}
