import { convert } from './rates'

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
 * - **relieved** — what leaves the control account. What the *document* was
 *   carried at, which `relieveFunctional` decides and this composes rather than
 *   re-deriving.
 * - **realised** — the difference. A real profit-and-loss event: between the
 *   day the money came in and the day it settled something, the rate moved.
 *   Not revenue, because nothing more was sold.
 *
 * They satisfy `released === relieved + realised` by construction, which is
 * what makes the journal entry balance.
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

/**
 * What to post when held money settles a document.
 *
 * `relievedCents` is passed in rather than computed, because what a document
 * gives up is `relieveFunctional`'s decision — including its rule that the
 * final relief takes the whole remaining functional balance, so a document
 * cannot be left with a stranded cent. Recomputing it here would be a second
 * answer to a question that already has one.
 */
export function settleHeld(input: {
  /** The amount being drawn, in the currency the money is held in. */
  amountCents: number
  /** Millionths, held currency → functional. What the liability is carried at. */
  heldRateMillionths: number
  /** From `relieveFunctional(document, amountCents).functionalCents`. */
  relievedCents: number
}): Settlement {
  const releasedCents = convert(input.amountCents, input.heldRateMillionths)

  return {
    releasedCents,
    relievedCents: input.relievedCents,
    realisedCents: releasedCents - input.relievedCents,
  }
}
