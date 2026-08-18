import { RateError, convert, isForeign } from './rates'

/**
 * What comes off a document's home-currency balance (spec §19).
 *
 * ## Why this is a function and not five copies of two lines
 *
 * A document balance goes down in more places than "somebody paid it". A credit
 * note is applied, a retainer is drawn against, a vendor credit offsets a bill,
 * a gift card settles a visit, a debt is written off. Each of those has its own
 * rule about what the *status* becomes afterwards — `paid`, `written_off`,
 * `partial` — and they genuinely differ, which is why they are not one function.
 *
 * The home-currency side does not differ. It is the same arithmetic every time,
 * and Phase 35 learned what happens when it lives at only some of the call
 * sites: the gift-card path reduced an invoice without reducing what the
 * control account is checked against, and Phase 31's reconciliation reported a
 * £50 difference that was really a missing line of code. The check caught it.
 * Putting the rule here is how it stops needing to.
 *
 * ## Relieved at the document's own rate, except for the last of it
 *
 * A part payment comes off at the rate the document was raised at — that is
 * what the ledger carries, so that is what is being relieved. Converting at
 * *today's* rate here would leave a remainder unrelated to anything.
 *
 * The final settlement takes the whole remaining amount rather than a computed
 * one, because six-decimal rounding on three part payments does not necessarily
 * sum back to the original. Without that, a fully paid invoice can be left
 * carrying one stranded cent forever — visible on no report, and enough to make
 * the receivables check disagree every night.
 */
export function relieveFunctional(
  document: {
    balanceCents: number
    exchangeRateMillionths: number
    functionalBalanceCents: number
  },
  amountCents: number,
): { functionalCents: number; functionalBalanceCents: number } {
  const newBalance = document.balanceCents - amountCents

  const functionalCents =
    newBalance === 0
      ? document.functionalBalanceCents
      : convert(amountCents, document.exchangeRateMillionths)

  return {
    functionalCents,
    functionalBalanceCents: document.functionalBalanceCents - functionalCents,
  }
}

/**
 * Refuses an operation that has no defined answer in a foreign currency yet.
 *
 * ## Why a refusal rather than an approximation
 *
 * Reducing a foreign balance means posting a home-currency amount to the
 * control account, and for a multi-line document — a credit note, a vendor
 * credit — that amount is the *sum of the converted lines*, not the conversion
 * of the sum. The two differ by a cent often enough to matter, and picking
 * either without deciding which is right is how a set of books acquires a drift
 * nobody can explain (the trap Phase 26 named and Phase 31 exists to catch).
 *
 * A retainer is worse than that: it is cash already received in the company's
 * own currency, and drawing it against a euro invoice is a settlement at *some*
 * rate. Which rate — the day the retainer arrived, or the day it is drawn — is
 * an accounting decision with a real effect on reported profit. It should be
 * made by somebody, deliberately, not defaulted to whichever was easier here.
 *
 * So these four operations stop on a foreign document, and say what to do
 * instead. A refusal somebody reads beats a number nobody can reconcile.
 */
export function refuseForeign(
  document: { number: string; currency: string },
  functionalCurrency: string,
  operation: string,
): void {
  if (!isForeign(document.currency, functionalCurrency)) return

  throw new RateError(
    `${document.number} is in ${document.currency} and these books are in ` +
      `${functionalCurrency}. ${operation} in a foreign currency is not supported yet — ` +
      'record it as a payment at the rate on the day, or post the journal entry directly, ' +
      'so the rate it happens at is one somebody chose.',
  )
}
