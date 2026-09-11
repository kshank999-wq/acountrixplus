import { RATE_ONE, convert } from './rates'
import { formatCents } from '@/lib/money'

/**
 * How much of a foreign document a home-money holding can settle (Phase 142).
 *
 * ## NOT WIRED YET
 *
 * `redeemGiftCard` does not call this. The cores are being put in place first
 * and hooked up in a later pass, so **the defect described below is still
 * live**. `tests/gift-card-against-foreign-invoice.test.ts` is the skipped
 * acceptance test for that pass, and `PENDING_WIRING` carries the entry.
 *
 * ## The defect
 *
 * A gift card holds the company's own money. `gift_cards` has no currency
 * column and no functional twin — it is in no currency registry, and ADR 0029
 * argued that a card cannot be foreign by construction, which is true of the
 * card. It is not true of the invoice the card is spent against.
 *
 * `redeemGiftCard` decides how much to apply like this:
 *
 * ```ts
 * const dueCents = bill.balanceCents          // the invoice's FACE balance
 * const plan = redeemFor(card.balanceCents, dueCents)
 * ```
 *
 * `card.balanceCents` is dollars and `bill.balanceCents` is euros, so the `min`
 * inside `redeemFor` compares two currencies — Phase 122's rule, in the decision
 * that says how much of a debt is forgiven. Then `plan.appliedCents` is posted
 * to **both** journal lines while the invoice's functional twin comes down by
 * `relieveFunctional(bill, plan.appliedCents)`, which converts.
 *
 * Measured: a €1,000 invoice carried at 1.10 is $1,100 on the books. Redeem a
 * **$600** card against it today and:
 *
 * | | moves by |
 * | --- | --- |
 * | Accounts Receivable, in the ledger | **$600** |
 * | the invoice's functional balance | **$660** |
 * | the customer's debt | **€600**, which is $660 of it |
 *
 * So the control account and the subledger disagree by $60 — `ledger.receivables`
 * raises a `fault` every night, the Phase 137 shape in a path Phase 137 did not
 * reach — and the business has given away $660 of debt for a $600 card.
 *
 * ## Why this is a new core rather than `spends`
 *
 * Phase 138 built `spends` for the other holding of this kind, and there are
 * exactly two: `gift_cards` and `deposit_movements` are the only tables that
 * hold the company's own money and settle a document with it. Everything else
 * that relieves a balance — retainers, credit notes, held customer credit,
 * vendor credits — carries a currency and a rate of its own.
 *
 * The two ask different questions, which is why bending one into the other
 * would be the mistake Phase 130 named:
 *
 * - **`spends`** — *this much: can the holding afford it?* A person types how
 *   much of a tenant's deposit to keep, and the answer is yes or a refusal.
 * - **`affords`** — *as much as it can: how much is that?* Nobody types an
 *   amount when a card is redeemed; the card pays what it can and the rest
 *   stays owing.
 *
 * Giving `spends` a "or as much as you can" mode would make one function answer
 * two questions, and the refusal it exists to produce is meaningless for a card:
 * a card that cannot cover the bill is the normal case, not an error.
 *
 * ## What it returns, and what it deliberately does not
 *
 * It returns a **face** amount — what comes off the document, in the document's
 * own currency — and nothing else about money.
 *
 * The functional figure is then `relieveFunctional(document, faceCents)`, which
 * already exists and already gets the hard part right: when the face balance
 * lands on zero it returns the carried `functionalBalanceCents` rather than a
 * fresh conversion, so a card that clears an invoice takes **both** columns to
 * zero exactly. Computing the functional figure here as well would be two
 * answers to one question (Phase 116), and the second one would be the wrong
 * one in precisely the case that matters most.
 *
 * ## The arithmetic, and why it floors
 *
 * `convert` multiplies a face amount by the rate. Going the other way has no
 * counterpart in `rates.ts` — `rateFrom` derives a *rate* from a pair, not a
 * face from a functional — so this is the first inverse in the codebase, and it
 * rounds **down**:
 *
 * > `faceCents = floor(heldCents × RATE_ONE / rateMillionths)`
 *
 * Flooring is what guarantees `convert(faceCents, rate) ≤ heldCents`: the face
 * amount is at most `held × 1e6 / rate`, so its product with the rate is at most
 * `held × 1e6`, and rounding a number no greater than `held` cannot exceed it.
 * Rounding to nearest could buy one cent more of the document than the card
 * holds, which is a card going overdrawn — a liability account going the wrong
 * way for a penny, every night, in a check nobody would think to look at.
 */

export type Affordable = {
  /**
   * What the holding has left, in the company's own money.
   *
   * A gift-card balance. It has no currency of its own — that is what makes
   * this question necessary rather than a plain `min`.
   */
  heldCents: number
  /** What the document still owes, in the document's own currency. */
  balanceCents: number
  /**
   * What that balance is worth in the books' money, carried at the rate the
   * document was raised at.
   *
   * Read from the document's own column, never recomputed (Phase 116). It is
   * what decides full settlement from partial, and the full case must use the
   * carried figure or the two columns stop landing on zero together.
   */
  functionalBalanceCents: number
  /** The rate the document has been carried at since it was raised. */
  rateMillionths: number
  /** The document's currency, for the sentence. */
  documentCurrency: string
  /** The company's own, for the sentence. */
  homeCurrency: string
}

export type Affords =
  | {
      ok: true
      /**
       * What comes off the document, in the document's own currency.
       *
       * Hand this to `relieveFunctional` for the figure the ledger posts.
       */
      faceCents: number
      /** True when this clears the document outright. */
      settlesInFull: boolean
      /** True when the document is in another currency, for the memo. */
      converted: boolean
    }
  | { ok: false; why: string }

/**
 * The largest face amount this holding can settle.
 *
 * Pure: no database, no clock, no rate lookup. The rate is the document's own
 * and the caller reads it off the document.
 */
export function affords(input: Affordable): Affords {
  const {
    heldCents,
    balanceCents,
    functionalBalanceCents,
    rateMillionths,
    documentCurrency,
    homeCurrency,
  } = input

  const converted = documentCurrency !== homeCurrency

  if (heldCents <= 0) {
    return { ok: false, why: 'There is nothing left on it.' }
  }

  if (balanceCents <= 0) {
    return { ok: false, why: 'There is nothing owing on it.' }
  }

  if (rateMillionths <= 0) {
    return {
      ok: false,
      why:
        'This document has no exchange rate recorded, so there is no saying what settling part ' +
        'of it is worth. Put the rate on the document first.',
    }
  }

  // Enough to clear it outright, measured in the one currency both figures are
  // already in. The face amount is then the whole balance, and
  // `relieveFunctional` will relieve exactly `functionalBalanceCents` — which is
  // the only way both columns reach zero together.
  if (functionalBalanceCents <= heldCents) {
    return { ok: true, faceCents: balanceCents, settlesInFull: true, converted }
  }

  // Not enough, so buy as much of the document's currency as the holding covers.
  // Floor, never round: see the note above about a card going overdrawn.
  const faceCents = Math.floor((heldCents * RATE_ONE) / rateMillionths)

  if (faceCents <= 0) {
    return {
      ok: false,
      why:
        `${formatCents(heldCents, homeCurrency)} does not buy a single cent of ` +
        `${documentCurrency} at the rate this document was raised at, so there is nothing to ` +
        'apply.',
    }
  }

  return { ok: true, faceCents, settlesInFull: false, converted }
}

/**
 * What that face amount costs the holding, for a caller that has no document.
 *
 * The partial branch only. A caller holding the document should use
 * `relieveFunctional` instead — it is the same arithmetic for a partial and the
 * *right* arithmetic for a full settlement, where this would recompute a figure
 * the document already carries.
 *
 * It exists because the property in `tests/affordable.test.ts` that matters most
 * — a holding is never spent past what it holds — has to be checkable without a
 * database, and a test that reimplemented the conversion would be proving its
 * own arithmetic rather than this file's.
 */
export function costOf(faceCents: number, rateMillionths: number): number {
  return convert(faceCents, rateMillionths)
}
