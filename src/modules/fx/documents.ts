import { convert } from './rates'

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
 * `refuseForeign` lived here from Phase 35 until Phase 66, and is gone.
 *
 * It stopped four operations that had no defined answer in a foreign currency:
 * crediting an invoice, crediting a bill, applying a credit, and drawing a
 * retainer. It was right to, and it was right for thirty-one phases — a refusal
 * somebody reads beats a number nobody can reconcile.
 *
 * Phase 63 lifted three of them, having found their question was already
 * answered by the document engine: a credit note reverses a document, and
 * reversing it by different arithmetic than raised it *is* the drift the
 * refusal was guarding against. Those three share one rule with the documents
 * they reverse, in `fx/denomination.ts`.
 *
 * Phase 66 lifted the last. The retainer draw genuinely was a different
 * question — a settlement, at a rate somebody had to choose, with a real effect
 * on reported profit — and it was deferred twice on purpose, by ADR 0063 and
 * again by ADR 0065. The answer, when it was finally looked at, was that
 * neither rate needed choosing: the retainer has been carried at the rate the
 * money arrived at and the invoice at the rate it was raised at, and the gap
 * between them is the realised gain or loss `recordPayment` has posted all
 * along. `fx/settlement.ts` holds it.
 *
 * This note stays because the shape of the thing is worth keeping: a refusal is
 * not a permanent verdict, it is a question nobody has answered yet, and the
 * cost of removing one is a phase of work rather than a wrong number for years.
 */
