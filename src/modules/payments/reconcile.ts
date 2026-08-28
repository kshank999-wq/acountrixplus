/**
 * Finding out what happened to a payment nobody came back from
 * (spec §13, §19).
 *
 * ## The hole this closes
 *
 * Phase 44 settled a card payment when the customer's browser returned to
 * `/i/[token]/paid`. That is the **least** reliable moment in the whole flow:
 * they close the tab, the redirect fails, the phone loses signal on the train.
 * The processor has taken the money either way.
 *
 * When that happens the checkout stays `pending` in our database, so nothing
 * posts. And the nightly check cannot see it: `heldByProcessor` counts only
 * `succeeded` rows, so the processor side of `payments.in_transit` reads zero,
 * the ledger side reads zero because nothing posted, and the comparison
 * reports agreement. ADR 0044 claimed that check would catch *"a payment the
 * customer made that never reached these books"*. It could not — the one
 * failure it was written for was the one it was blind to.
 *
 * Meanwhile the invoice still says the money is owed, so Phase 43 chases the
 * customer for an invoice they have already paid, which is the single worst
 * thing this system can do to somebody.
 *
 * ## The costly wrong answer
 *
 * Not "leaving a payment unsettled for an hour" — that is a delay. It is
 * **calling an unknown an abandonment**. If the processor is having an outage
 * and cannot say what happened, expiring the checkout writes off a customer's
 * money in silence, and no later answer will reopen it. So an unknown is never
 * resolved automatically. It is handed to a person, which is the only correct
 * destination for "we do not know whether we have been paid".
 *
 * Nothing here touches the database or the clock. `asOf` is passed in.
 */

/** What the processor said, as this module needs it. */
export type ReportedStatus = 'pending' | 'succeeded' | 'failed' | 'unknown'

export type SweepAction =
  /** Money changed hands. Post it. */
  | 'settle'
  /** The processor declined it. Record that and stop asking. */
  | 'mark_failed'
  /** Never completed, and the window has closed. Nothing was taken. */
  | 'expire'
  /** Still in flight. Ask again later. */
  | 'wait'
  /**
   * The processor has no record of a checkout we started.
   *
   * Never resolved automatically, in either direction. It means one of an
   * outage, a misconfigured account, or a checkout created against a different
   * set of credentials — and all three need a person, because the alternative
   * is a machine deciding on its own that a customer was not charged.
   */
  | 'investigate'

export type SweepVerdict = {
  action: SweepAction
  /** Shown to whoever reads the run, so a sweep is legible rather than a count. */
  why: string
}

/** What this module needs to know about a checkout we started. */
export type SweepableCheckout = {
  id: string
  status: string
  /** When it stops being reasonable to expect a completion. */
  expiresAt: string | null
  createdAt: string
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.floor((b - a) / 86_400_000)
}

/**
 * How long a checkout with no expiry is given before it is treated as stale.
 *
 * A processor's hosted page times out in well under an hour. A day is
 * generous on purpose: the cost of waiting another day is a delay, and the
 * cost of expiring too early is refusing to look for money that arrived.
 */
export const STALE_AFTER_DAYS = 1

/**
 * What to do about one checkout, given what the processor says.
 *
 * The order matters. A processor's answer beats our own record every time —
 * it is the party holding the money — so `succeeded` settles even a checkout
 * we had written off as expired, and `unknown` never resolves anything.
 */
export function sweepDecision(input: {
  checkout: SweepableCheckout
  reported: ReportedStatus
  asOf: string
}): SweepVerdict {
  const { checkout, reported, asOf } = input

  // The processor is the authority on whether it took the money. Our row
  // saying `expired` is our guess; this is their answer.
  if (reported === 'succeeded') {
    return {
      action: 'settle',
      why: 'The processor took the payment. It had not reached these books.',
    }
  }

  if (reported === 'failed') {
    return { action: 'mark_failed', why: 'The processor declined it.' }
  }

  if (reported === 'unknown') {
    return {
      action: 'investigate',
      why: 'The processor has no record of this payment. Somebody needs to look.',
    }
  }

  // Still pending at the processor. The only question left is whether enough
  // time has passed to stop expecting anything.
  const deadline = checkout.expiresAt ?? addDays(checkout.createdAt, STALE_AFTER_DAYS)

  if (Date.parse(asOf) > Date.parse(deadline)) {
    return {
      action: 'expire',
      why: 'Started and never completed. The processor took nothing.',
    }
  }

  return { action: 'wait', why: 'Still with the customer.' }
}

function addDays(iso: string, days: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Date(at + days * 86_400_000).toISOString()
}

/**
 * The two kinds of unresolved payment, which look identical without asking.
 *
 * `unaccounted` is the one that matters: we started a checkout and the
 * processor has no record of it. `unanswered` is the ordinary case — a
 * customer opened the page and walked away, and the processor agrees nothing
 * happened. `unasked` means the sweep has not run against this row yet, which
 * is worth saying rather than dressing up as either of the other two.
 */
export type UnresolvedKind = 'unaccounted' | 'unanswered' | 'unasked'

export function unresolvedKind(lastReportedStatus: string | null | undefined): UnresolvedKind {
  if (!lastReportedStatus) return 'unasked'
  return lastReportedStatus === 'unknown' ? 'unaccounted' : 'unanswered'
}

export type SweepSummary = {
  settled: number
  failed: number
  expired: number
  waiting: number
  /** Worth waking somebody for. Nothing else here is. */
  investigate: number
}

export const EMPTY_SWEEP: SweepSummary = {
  settled: 0,
  failed: 0,
  expired: 0,
  waiting: 0,
  investigate: 0,
}

/**
 * One sentence for the operations page, or null when nothing happened.
 *
 * Null rather than "0 settled" on a quiet run, for ADR 0024's reason: a job
 * announcing nothing every hour is a job whose output nobody reads by the
 * afternoon, and the one hour that matters is buried with it.
 */
export function describeSweep(summary: SweepSummary): string | null {
  const parts: string[] = []

  if (summary.settled > 0) {
    parts.push(`${summary.settled} payment${summary.settled === 1 ? '' : 's'} recovered`)
  }
  if (summary.failed > 0) parts.push(`${summary.failed} declined`)
  if (summary.expired > 0) parts.push(`${summary.expired} abandoned`)
  if (summary.investigate > 0) {
    parts.push(
      `${summary.investigate} the processor cannot account for — somebody needs to look`,
    )
  }

  return parts.length === 0 ? null : `${parts.join(', ')}.`
}

/**
 * Whether a sweep found something a person has to deal with.
 *
 * Only `investigate`. A settled payment is the sweep working; an expired one
 * is a customer changing their mind. Waking somebody for either teaches them
 * to ignore the alert that matters.
 */
export function needsAttention(summary: SweepSummary): boolean {
  return summary.investigate > 0
}
