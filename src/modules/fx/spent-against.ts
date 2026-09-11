import { formatCents } from '@/lib/money'

/**
 * Money held in one currency, spent against a document in another (Phase 138).
 *
 * ## The defect
 *
 * `applyDeposit` settles an invoice with a tenant's security deposit. The
 * deposit is held in the company's own money — `deposit_movements` has no
 * currency column and is in no currency registry — and the invoice may be in
 * any currency at all, because `applyDeposit` takes an `invoiceId` and asks it
 * nothing.
 *
 * One number, `input.amountCents`, was used for both. Three things follow, and
 * each one is a rule this project has already named:
 *
 * 1. **The permission compares two currencies.** `input.amountCents >
 *    position.heldCents` puts a euro face amount against a dollar holding —
 *    Phase 122's "no sum adds two currencies", in the check that decides
 *    whether somebody else's money may be spent.
 * 2. **The entry posts a face amount into a functional ledger.** Accounts
 *    Receivable is credited with the euro figure while the subledger comes down
 *    by the converted one, so the control account and the invoice disagree —
 *    Phase 127's original defect, in a place its scan did not reach.
 * 3. **The figure that fixes both was already computed.**
 *    `reduceDocumentBalance` relieves the invoice at its own carried rate and
 *    **returns** `functionalCents`; `settleInvoiceWithoutCash` passes it
 *    through; `applyDeposit` reads `.number` off the result for a memo and
 *    throws the rest away.
 *
 * The third is Phase 49's rule inverted. A function with no caller is a feature
 * that does not exist; **a return value with no reader is an answer nobody
 * asked for**, and the same helper's other caller —`recordPayment`, through
 * `applyToDocument` — reads it and accumulates it.
 *
 * ## Why it converts rather than refusing
 *
 * Phase 133 refused the paths that cannot know a rate, and Phase 136 found that
 * refusing the *knowable* case was the error. This one is knowable: the invoice
 * carries the rate it was raised at, `relieveFunctional` gives what that face
 * amount is worth at it, and that figure is what the deposit gives up. Nothing
 * has to be guessed and no second rate is invented.
 *
 * So the rule is not "refuse a foreign invoice" but **"say what it costs"** —
 * and the refusal that remains is the honest one: there is not enough held.
 */

export type Spend = {
  /** What is still held for this tenant, in the company's own money. */
  heldCents: number
  /** What is being taken off the document, in the document's own currency. */
  faceCents: number
  /**
   * What that face amount is worth in the company's own money, at the rate the
   * **document** has been carried at since it was raised.
   *
   * Never a fresh conversion: this is `relieveFunctional(document,
   * faceCents).functionalCents`, the figure the document's own column moves by.
   * Computing it again here would be two answers to one question (Phase 116).
   */
  functionalCents: number
  /** The document's currency, for the sentence. */
  documentCurrency: string
  /** The company's own, for the sentence. */
  homeCurrency: string
}

export type Spends =
  | {
      ok: true
      /** What the holding gives up. Always the company's own money. */
      costsCents: number
      /** True when the document is in another currency, for the memo. */
      converted: boolean
    }
  | { ok: false; why: string }

/**
 * What settling `faceCents` of a document costs the holding, and whether there
 * is enough.
 *
 * Pure: no database, no clock, no rate lookup.
 */
export function spends(input: Spend): Spends {
  const { heldCents, faceCents, functionalCents, documentCurrency, homeCurrency } = input

  if (faceCents <= 0) {
    return { ok: false, why: 'An amount must be more than nothing.' }
  }

  // The two figures being compared are both the company's own money now. That
  // is the whole of the first fix: the old check put `faceCents` against
  // `heldCents`, and on a euro invoice against a dollar deposit those are not
  // the same kind of number (Phase 122).
  if (functionalCents > heldCents) {
    const converted = documentCurrency !== homeCurrency

    return {
      ok: false,
      why: converted
        ? `${formatCents(faceCents, documentCurrency)} of this invoice is worth ` +
          `${formatCents(functionalCents, homeCurrency)} at the rate it was raised at, and only ` +
          `${formatCents(heldCents, homeCurrency)} is held on this tenancy.`
        : `Only ${formatCents(heldCents, homeCurrency)} is held on this tenancy, so ` +
          `${formatCents(functionalCents, homeCurrency)} cannot be applied.`,
    }
  }

  return {
    ok: true,
    costsCents: functionalCents,
    converted: documentCurrency !== homeCurrency,
  }
}
