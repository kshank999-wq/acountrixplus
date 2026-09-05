/**
 * The rate a bank transaction posted at, kept rather than asked for twice
 * (Phase 129).
 *
 * ## The defect
 *
 * Phase 128 made `buildLines` convert a foreign bank transaction at the rate
 * for the day the money moved, and made `cashTieOut` convert the feed side the
 * same way so the two could be compared. Both call `rateFor`. **Neither writes
 * the answer down**, so the same question is asked twice, at different times,
 * of a table that changes.
 *
 * `bank_transactions` is the only money that reaches the ledger with no rate
 * beside it. Every other moving amount has carried its pair since Phase 116,
 * for exactly this reason.
 *
 * ## Why the answer changes, without anybody editing anything
 *
 * `rateFor` walks **backwards** to the most recent rate on or before the date
 * asked for. So entering a rate for a day that did not have one — the ordinary
 * act of keeping the table current, not a correction — changes what an *older*
 * question resolves to.
 *
 * Measured on the database before a line was changed:
 *
 * ```
 * rate on 2026-09-10 before: 1100000     (from a rate dated 2026-03-01)
 * after posting   feed -50000  books -55000  ledger -55000  diff 0
 *
 * ... somebody enters the rate for 2026-09-01, which nothing had ...
 *
 * rate on 2026-09-10 after:  1150000
 * after new rate  feed -50000  books -57500  ledger -55000  diff -2500
 * ```
 *
 * The ledger is right and the check is wrong, and nothing in the audit trail
 * explains the $25.
 *
 * ## The worse half
 *
 * `syncLedgerForTransaction` is idempotent by voiding and re-posting. So the
 * re-derivation does not only mislead a check — it **rewrites the books**:
 *
 * ```
 * posted at 1.10:              55000
 * after an unrelated recateg:  57500
 * CHANGED by 2500 with no correction record
 * ```
 *
 * Moving a transaction to a different expense account, or putting a job code on
 * it, silently restates what it was worth. Phase 70 settled that a correction
 * to the books says what it is and why; this says nothing, because nobody
 * decided it. The money did not move again — only the rate table grew.
 *
 * ## The rule
 *
 * **A rate is resolved once, on the day it is first needed, and then it is a
 * fact about that posting.** Re-categorising is not a revaluation: nothing
 * about the money changed. Revaluing a past posting deliberately is a
 * correction with a date and a reason, through the vocabulary Phase 70 built —
 * never a side effect of somebody tidying a category.
 */

/** What a transaction is worth in the books, and the rate that made it so. */
export type PostedRate = {
  rateMillionths: number
  /** `first` when this posting resolved it; `kept` when an earlier one did. */
  because: 'first' | 'kept'
}

/**
 * The rate to post at: the one already recorded, or today's answer if there is
 * none yet.
 *
 * The stored rate wins even when the table now says something else, and that is
 * the whole point. `rateFor` answers *"what is on file for that day"*, which is
 * a question about the rate table today. What a posting needs is *"what did
 * this money go into the books at"*, which is a question about the past and has
 * exactly one right answer once it has been answered.
 *
 * A stored rate of zero or less is treated as absent rather than honoured: it
 * could only come from a corrupted write, and posting a magnitude of zero
 * against a real bank movement would silently drop it from the books.
 */
export function rateForPosting(input: {
  storedRateMillionths: number | null
  currentRateMillionths: number
}): PostedRate {
  const stored = input.storedRateMillionths

  if (stored !== null && Number.isFinite(stored) && stored > 0) {
    return { rateMillionths: stored, because: 'kept' }
  }

  return { rateMillionths: input.currentRateMillionths, because: 'first' }
}

/**
 * The rate implied by a face amount and what the ledger actually took for it.
 *
 * This is how the backfill reads history: not by asking the rate table what it
 * *would* say today, but by dividing what is in the journal by what was on the
 * statement. Phase 127's rule for a backfill — **record what the ledger
 * contains, not what it should have contained** — and the only way to write
 * down a rate for a posting made before rates were written down.
 *
 * `null` for a zero face amount, which has no rate rather than an infinite one.
 * The sign cancels, so an outflow and an inflow at the same rate agree.
 */
export function rateFromPosted(
  faceCents: number,
  functionalCents: number,
): number | null {
  if (faceCents === 0) return null
  return Math.round((functionalCents * 1_000_000) / faceCents)
}

/**
 * Whether a foreign transaction went into the books at its face value.
 *
 * This is Phase 128's defect, read off a row: euros put into a dollar ledger as
 * though they were dollars. Every foreign bank transaction posted before that
 * phase is one of these, and until the rate was written down there was no way
 * to tell one from a correctly posted row.
 *
 * ## It is a position, not a fault
 *
 * A currency really can sit at parity on the day money moved, and then a
 * correctly posted row looks exactly like a damaged one. There is no fact that
 * separates them — the rate table can no longer be asked, because the answer it
 * gives today is not the answer that was used.
 *
 * So this reports *what to look at*, and a person decides. That is the same
 * honesty `banking.cash_tie_out` has carried since Phase 40, and the reason
 * both are `position` rather than `fault` in the register.
 */
export function bookedAtFace(input: {
  isForeign: boolean
  amountCents: number
  functionalAmountCents: number | null
}): boolean {
  if (!input.isForeign) return false
  if (input.functionalAmountCents === null) return false
  if (input.amountCents === 0) return false

  return input.functionalAmountCents === input.amountCents
}
