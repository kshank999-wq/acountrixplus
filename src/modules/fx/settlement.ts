

/**
 * Money already received, discharging a demand carried at a different rate
 * (spec §35, Phase 66).
 *
 * ## The question two ADRs deferred
 *
 * `refuseForeign` stopped four operations from Phase 35. Phase 63 lifted three
 * of them, having found their question was already answered by the document
 * engine, and deliberately kept the fourth:
 *
 * > Applying a retainer is a **settlement**, not a reversal: it decides at what
 * > rate money already held discharges a new demand, which has a
 * > profit-and-loss effect and is an accounting decision, not arithmetic the
 * > document engine already made.
 *
 * ADR 0065 left it standing for the same reason. That was right both times —
 * and the decision, made here, turns out to be one this codebase has *already
 * taken once*, in `recordPayment`:
 *
 * ```ts
 * const fxCents = appliedFunctionalCents - carriedCents
 * ```
 *
 * A retainer is cash received and held. Drawing it against an invoice is a
 * receipt that arrived early. So the rule is the receipt's rule, and the only
 * thing this phase decides is that it *is* the same rule — which means writing
 * it once and letting both callers have it, rather than a third hand-rolled
 * subtraction that has to agree with two others for ever.
 *
 * ## What the numbers mean
 *
 * Three amounts, in the company's own money:
 *
 * - **released** — what leaves the liability. The held money at the rate it was
 *   taken in at, because that is what the books have been carrying it at since
 *   the day it arrived.
 * - **relieved** — what leaves the other side. For a draw that is the control
 *   account at what the *document* was carried at, which `relieveFunctional`
 *   decides and this composes rather than re-deriving. For a refund (Phase 67)
 *   it is the bank, at the rate on the day the money left — because that is
 *   what the statement will say.
 * - **realised** — the difference. A real profit-and-loss event: between the
 *   day the money came in and the day it settled something, the rate moved.
 *   Not revenue, because nothing more was sold.
 *
 * They satisfy `released === relieved + realised` by construction, which is
 * what makes the journal entry balance.
 *
 * ## Which side the balance is on (Phase 68)
 *
 * The rule above is stated in terms of a *liability* — held money, debited as
 * it leaves. That was every caller it had, and it hid the thing that actually
 * decides the sign.
 *
 * A vendor credit is the same settlement with the balance on the other side. It
 * posts `Dr Accounts Payable / Cr Expense` when it is issued, so an unapplied
 * one is an **asset**: money the supplier owes back. Recovering it debits the
 * bank and credits the payable — the mirror image of a refund, and passing it to
 * `settleHeld` in liability order returns a gain with a loss's sign.
 *
 * So the invariant is not about liabilities at all:
 *
 * > **`realised` is the debit side less the credit side.** Positive credits the
 * > exchange account, because `Dr A = Cr B + Cr (A − B)` is the only way a
 * > three-line entry balances.
 *
 * One private function holds that, and the two exported ones differ only in
 * naming which of their amounts is the debit. Nobody has to remember, which is
 * the point — the sign is the part that is silently wrong when it is wrong, and
 * a swapped gain still balances.
 *
 * Nothing here touches the database or the clock.
 */

export type Settlement = {
  /** Debit the liability by this. */
  releasedCents: number
  /** Credit the control account by this. */
  relievedCents: number
  /**
   * Positive is a gain — credit the exchange account. Negative is a loss —
   * debit it by the magnitude. Zero for a domestic settlement, and for a
   * foreign one where the rate has not moved.
   */
  realisedCents: number
}

export type Recovery = {
  /** Debit the bank by this — what actually arrived. */
  receivedCents: number
  /** Credit the account carrying the balance by this. */
  relievedCents: number
  /** Same convention as `Settlement`: positive credits the exchange account. */
  realisedCents: number
}

/**
 * The whole of the arithmetic, and the only place the sign is decided.
 *
 * Trivial on purpose. Its value is that it is stated once: a caller that has
 * worked out its two functional amounts still has to say which one it is
 * debiting, and that is the question this file exists to stop people answering
 * twice.
 */
function realise(debitCents: number, creditCents: number): number {
  return debitCents - creditCents
}

/**
 * What to post when held money settles a document.
 *
 * ## Why both amounts come in rather than a rate
 *
 * The first draft of this took the held money's *rate* and converted the draw.
 * A database check caught it: a retainer drawn in three parts would have had
 * its face amount reach zero while its functional amount did not, because the
 * sum of three conversions is not the conversion of the sum.
 *
 * Both sides are therefore `relieveFunctional`'s decision, applied to each —
 * including its rule that the final relief takes the whole remaining functional
 * balance, so neither the liability nor the document can be left holding a
 * stranded cent. What is left for this function is the part that is genuinely
 * its own: the difference between the two, and which way round it posts.
 *
 * Which is the whole point. The two sides were never in question — each has
 * been carried at its own rate since the day it was recorded. The only thing
 * anybody had to decide was what to do with the gap, and the answer is the one
 * `recordPayment` has used since Phase 35.
 */
export function settleHeld(input: {
  /**
   * What leaves the liability, from `relieveFunctional` on the held money.
   * The rate it came in at, which is what the books have carried it at since.
   */
  releasedCents: number
  /** What leaves the control account, from `relieveFunctional` on the document. */
  relievedCents: number
}): Settlement {
  return {
    releasedCents: input.releasedCents,
    relievedCents: input.relievedCents,
    // The held money is what is debited: it is a liability, and it is leaving.
    realisedCents: realise(input.releasedCents, input.relievedCents),
  }
}

/**
 * What to post when a balance owed *to* the business comes back as cash
 * (Phase 68).
 *
 * The mirror of `settleHeld`, and the reason this file now names its sides.
 * A vendor credit is an asset — the supplier agreed we owe them less than we
 * have already recognised, so `2000 Accounts Payable` carries a debit nobody
 * can spend once there are no more bills to apply it to. Getting the money back
 * debits the bank and credits that payable, which is `settleHeld` with the
 * debit and the credit the other way round.
 *
 * Given the same two numbers, this returns the opposite sign, and that is
 * correct rather than a quirk: a euro that got dearer is a **loss** on money you
 * are holding for somebody else and a **gain** on money somebody else is holding
 * for you.
 */
export function recoverHeld(input: {
  /** What arrives in the bank, at the rate on the day it arrives. */
  receivedCents: number
  /**
   * What leaves the account carrying the balance, from `relieveFunctional` on
   * it — the rate it has been carried at since it was raised.
   */
  relievedCents: number
}): Recovery {
  return {
    receivedCents: input.receivedCents,
    relievedCents: input.relievedCents,
    // The cash is what is debited here; the balance being recovered is credited.
    realisedCents: realise(input.receivedCents, input.relievedCents),
  }
}
