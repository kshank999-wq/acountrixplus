/**
 * Money the customer sent that nothing was owed for (spec §13, §16).
 *
 * ## What the application told people to do
 *
 * A customer owed $7,400 and sent $8,000. The screen said:
 *
 * > *"$8,000.00 is more than the $7,400.00 outstanding. **Reduce it to
 * > $7,400.00**, or raise the document the rest covers first."*
 *
 * Both of those are wrong, and the first is worse than the second. Recording
 * $7,400 puts a figure in the books that the bank statement disagrees with, and
 * leaves the reconciliation $600 out **for ever** — there is no later event
 * that fixes it, because the difference was never recorded as anything.
 * "Raise the document the rest covers" means inventing an invoice for money the
 * customer does not owe, which fabricates $600 of revenue to make a bank line
 * match.
 *
 * `allocate` has computed `unappliedCents` correctly since Phase 41. Nothing
 * was ever done with it except refuse.
 *
 * ## What the leftover actually is
 *
 * **A liability.** A customer who has paid more than they owe is a customer the
 * business owes money to — either as credit against their next invoice or as a
 * refund. It is not revenue, because nothing more was sold; and it is not a
 * negative receivable, because netting it against what other customers owe
 * would hide it inside the aging report and quietly overstate collectable cash.
 *
 * It is also not **unearned revenue**, which is money taken for work that will
 * be done. An overpayment carries no promise of future work — often it is a
 * keying error, and the honest end of it is a refund. Phase 15's retainers are
 * the deliberate version and already have `2550 Client Retainers Held`; this is
 * the accidental one and gets its own account for the same reason Phase 44 kept
 * money at a processor separate from cash in hand.
 *
 * Nothing here touches the database or the clock.
 */

export type ReceiptSplit = {
  /** What the receipt settles. */
  appliedCents: number
  /** What is left over, held as credit for the customer. */
  heldCents: number
}

export type SplitVerdict =
  | { ok: true; split: ReceiptSplit; why: string | null }
  | { ok: false; why: string }

/**
 * Whether a payment with money left over may be recorded, and as what.
 *
 * The refusals are the interesting part:
 *
 * - **A disbursement.** Paying a supplier more than is owed leaves *them*
 *   owing *us*, which is an asset and not this account. Vendor credits
 *   (Phase 12) already cover the ordinary case, and inventing a second answer
 *   would give a business two places to look for the same money.
 * - **Nobody named.** You cannot owe money to no one. A receipt with a leftover
 *   and no customer has nowhere for the liability to attach, and holding it
 *   against nothing is how Phase 46's stranded payments happened.
 */
export function splitReceipt(input: {
  kind: 'receipt' | 'disbursement'
  amountCents: number
  /** What the allocation could actually apply. */
  appliedCents: number
  /** Whether a customer is named on the payment. */
  hasParty: boolean
}): SplitVerdict {
  const { kind, amountCents, appliedCents, hasParty } = input

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, why: 'A payment amount must be greater than zero.' }
  }

  if (appliedCents > amountCents) {
    return { ok: false, why: 'A payment cannot settle more than it is for.' }
  }

  const heldCents = amountCents - appliedCents

  if (heldCents === 0) {
    return { ok: true, split: { appliedCents, heldCents: 0 }, why: null }
  }

  if (kind === 'disbursement') {
    return {
      ok: false,
      why:
        'That is more than is owed to this supplier. Paying more than a bill leaves the supplier ' +
        'owing you, which is not the same thing as a credit you are holding for a customer — ' +
        'raise a vendor credit for the difference instead, or reduce the payment.',
    }
  }

  if (!hasParty) {
    return {
      ok: false,
      why:
        'That is more than is outstanding, and there is nobody to hold the difference for. ' +
        'Name the customer, or reduce the amount to what the documents cover.',
    }
  }

  return {
    ok: true,
    split: { appliedCents, heldCents },
    why:
      `${(heldCents / 100).toFixed(2)} more than was owed. It is held as credit for this ` +
      'customer — the bank and the books agree, and the credit goes against their next invoice ' +
      'or back to them.',
  }
}

/**
 * How much of a customer's held credit a document may take.
 *
 * Never more than is held, never more than is owed. Both refusals exist in the
 * service; defaulting sensibly here means nobody meets them — the same shape
 * Phase 49 used for spending a vendor credit.
 */
export function drawFrom(input: { availableCents: number; dueCents: number }): number {
  const available = Math.max(0, Math.trunc(input.availableCents))
  const due = Math.max(0, Math.trunc(input.dueCents))
  return Math.min(available, due)
}

export type CreditUse = 'apply' | 'refund'

export type UseVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a particular use of held credit is allowed.
 *
 * Applying and refunding are the only two ends, and they are different claims:
 * applying says the money stays with the business and settles something;
 * refunding says it goes back. Neither may exceed what is held, and neither may
 * be for nothing.
 */
export function mayUse(input: {
  use: CreditUse
  amountCents: number
  availableCents: number
  /** For an application: what the document still owes. */
  dueCents?: number
}): UseVerdict {
  const { use, amountCents, availableCents, dueCents } = input

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, why: 'That has to be for more than nothing.' }
  }

  if (amountCents > availableCents) {
    return {
      ok: false,
      why:
        `Only ${(availableCents / 100).toFixed(2)} is held for this customer, and that is ` +
        `${(amountCents / 100).toFixed(2)}.`,
    }
  }

  if (use === 'apply') {
    if (dueCents === undefined || dueCents <= 0) {
      return { ok: false, why: 'That document is settled, so there is nothing to put credit against.' }
    }

    if (amountCents > dueCents) {
      return {
        ok: false,
        why:
          `That document only owes ${(dueCents / 100).toFixed(2)}. Applying more would take it ` +
          'past settled and hide the difference.',
      }
    }
  }

  return { ok: true }
}
