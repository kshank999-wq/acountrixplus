import { convert } from './rates'

/**
 * What a document is worth in the company's own money (spec §35, Phase 63).
 *
 * ## Why this exists
 *
 * `createInvoice` and `createBill` each convert a document the same way, in
 * their own copy of the same four lines:
 *
 * > Each line converts on its own and the total is their sum, so the entry
 * > balances by construction. Converting the total and letting the lines
 * > convert separately would leave `functionalBalanceCents` a cent away from
 * > the journal entry it is supposed to agree with.
 *
 * That rule is right, and it was written twice. Phase 63 needs it a third time
 * — for credit notes — and a third copy of an arithmetic rule that has to agree
 * to the cent with the other two is exactly how a set of books acquires a drift
 * nobody can explain.
 *
 * ## What it unblocks
 *
 * `refuseForeign` has stopped four operations dead since Phase 35, on the
 * grounds that:
 *
 * > for a multi-line document — a credit note, a vendor credit — that amount is
 * > the *sum of the converted lines*, not the conversion of the sum. The two
 * > differ by a cent often enough to matter, and picking either without
 * > deciding which is right is how a set of books acquires a drift nobody can
 * > explain.
 *
 * Nobody had to decide: **the document engine decided it when it raised the
 * invoice.** A credit note reverses a document, and reversing it by different
 * arithmetic than raised it is the drift, not the fix. So the answer is to
 * follow the same rule — which means having one of it.
 *
 * Nothing here touches the database or the clock.
 */

export type FunctionalAmounts = {
  /** Each line converted on its own, in order. */
  lineCents: number[]
  functionalTaxCents: number
  /** The sum of the converted lines and the converted tax. */
  functionalTotalCents: number
}

/**
 * Converts a document's lines and tax at one rate.
 *
 * Line by line rather than in total, because the journal entry posts a line per
 * line: converting the total would leave the document's stored functional
 * amount a cent away from the entry derived from it, and the two are supposed
 * to be the same number seen twice.
 */
export function functionalAmounts(input: {
  lineCents: number[]
  taxCents?: number
  /** Millionths, foreign → functional. `1_000_000` for a domestic document. */
  rateMillionths: number
}): FunctionalAmounts {
  const lineCents = input.lineCents.map((cents) => convert(cents, input.rateMillionths))
  const functionalTaxCents = convert(input.taxCents ?? 0, input.rateMillionths)

  return {
    lineCents,
    functionalTaxCents,
    functionalTotalCents:
      lineCents.reduce((sum, cents) => sum + cents, 0) + functionalTaxCents,
  }
}

export type CreditVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Whether a credit may be applied to this document.
 *
 * ## Why a credit note takes the currency of what it credits
 *
 * A credit note is not an independent claim; it reverses part of a document
 * that already exists. A €4,000 invoice is reduced by €500, not by "$540 worth
 * of euro" — the customer's own ledger will show €500 against that invoice, and
 * anything else is a difference they will query.
 *
 * So the currency is inherited at issue rather than chosen, and applying a
 * credit across currencies is refused. This is Phase 62's rule again: money
 * held in one currency has not discharged a demand in another.
 *
 * The refusal names both currencies, because the fix is to raise the credit
 * against the right document and somebody needs to know which.
 */
export function creditableAgainst(input: {
  creditNumber: string
  creditCurrency: string
  documentNumber: string
  documentCurrency: string
}): CreditVerdict {
  return matchingCurrency({
    heldLabel: input.creditNumber,
    heldCurrency: input.creditCurrency,
    documentNumber: input.documentNumber,
    documentCurrency: input.documentCurrency,
    because:
      'A credit reduces what a document says is owed, and it can only do that in the currency ' +
      'the document is in',
    remedy:
      `raise the credit against a document in ${input.creditCurrency}, or a new one in ` +
      `${input.documentCurrency}.`,
  })
}

/**
 * Whether a retainer may be drawn against this invoice (Phase 66).
 *
 * The same rule a third time, which is why the shape below is shared. A
 * retainer is cash the client sent in a particular currency; drawing it against
 * an invoice in another would tell them their euro had settled a dollar demand.
 *
 * The *remedy* is not shared, because it genuinely differs: a credit is raised
 * against a document, and a retainer is taken from a client before any document
 * exists. Telling somebody to "raise the retainer against a document" would be
 * advice they cannot follow.
 */
export function drawableAgainst(input: {
  retainerLabel: string
  retainerCurrency: string
  documentNumber: string
  documentCurrency: string
}): CreditVerdict {
  return matchingCurrency({
    heldLabel: input.retainerLabel,
    heldCurrency: input.retainerCurrency,
    documentNumber: input.documentNumber,
    documentCurrency: input.documentCurrency,
    because:
      'Money held in one currency has not discharged a demand in another, whatever the rate ' +
      'happens to be today',
    remedy:
      `draw it against an invoice in ${input.retainerCurrency}, or take a retainer in ` +
      `${input.documentCurrency}.`,
  })
}

/**
 * Phase 62's rule, in the one place all three callers can have it: money in one
 * currency has not discharged a demand in another.
 *
 * What is shared is the comparison and the discipline of naming both sides —
 * Phase 47's rule, that a refusal must say what is wrong with *this* row. The
 * sentence after it belongs to the caller, because the fix does.
 */
function matchingCurrency(input: {
  heldLabel: string
  heldCurrency: string
  documentNumber: string
  documentCurrency: string
  because: string
  remedy: string
}): CreditVerdict {
  if (input.heldCurrency === input.documentCurrency) return { ok: true }

  return {
    ok: false,
    reason:
      `${input.heldLabel} is in ${input.heldCurrency} and ${input.documentNumber} is in ` +
      `${input.documentCurrency}. ${input.because} — ${input.remedy}`,
  }
}
