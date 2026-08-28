/**
 * What a card payment is actually worth, and when (spec §13, §3).
 *
 * ## The mistake this module exists to prevent
 *
 * A customer pays a $1,000 invoice by card. The obvious entry is
 *
 *     Dr Bank 1,000 / Cr Accounts Receivable 1,000
 *
 * and it is wrong in two independent ways, both of which surface weeks later
 * as somebody unable to reconcile.
 *
 * **The amount is wrong.** The processor keeps a fee. $970.70 arrives, not
 * $1,000. Booking the gross to the bank overstates cash by the fee and hides
 * a real operating expense that never reaches the profit and loss — a
 * business using this would not know what card acceptance costs them.
 *
 * **The date is wrong, and so is the shape.** The money is not at the bank on
 * Tuesday; it is at the processor, and on Friday it arrives *batched* with
 * eleven other payments as a single deposit. The bank statement has one line
 * for $8,431.15. The ledger, posted the obvious way, has twelve lines on
 * three different days. Phase 40's tie-out fails and there is no way to make
 * it pass, because the two sides genuinely do not correspond.
 *
 * ## So the money has somewhere to be while it is in transit
 *
 * Payment captured:  Dr Payments in Transit / Cr Accounts Receivable (gross)
 * Fee taken:         Dr Merchant Fees       / Cr Payments in Transit
 * Payout arrives:    Dr Bank                / Cr Payments in Transit (net)
 *
 * The bank sees exactly one row per payout, which is exactly what the
 * statement shows. `1250 Payments in Transit` carries what the processor is
 * holding, which is a real asset the business owns and cannot yet spend, and
 * the balance of that account is checkable against the processor's own
 * figures — which is what the integrity check does.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * What a processor charges.
 *
 * Basis points plus a fixed amount is the shape essentially every card
 * processor uses — 2.9% + 30¢ is the familiar one — and it is the shape a
 * business can actually check against their statement.
 */
export type FeeSchedule = {
  /** Hundredths of a percent. 2.9% is 290. */
  percentBp: number
  /** Charged once per payment, whatever its size. */
  fixedCents: number
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = { percentBp: 290, fixedCents: 30 }

export type Settlement = {
  grossCents: number
  feeCents: number
  /** What the processor will actually send. */
  netCents: number
}

/**
 * Splits a payment into the fee and what arrives.
 *
 * **Rounded half-up, and the fee is what moves.** A processor computing
 * 2.9% of $10.05 gets 29.145¢ and charges 29¢; the direction of that rounding
 * is the processor's decision, not ours, and the honest thing is to pick one
 * and be checkable. What matters far more than the half-cent is that
 * `fee + net === gross` exactly, always — the net is derived by subtraction
 * rather than computed, so the three numbers can never fail to add up and
 * leave a penny stranded in the clearing account for ever.
 *
 * The fee never exceeds the gross. A £0.10 payment under a 30¢ fixed fee
 * would otherwise produce a negative net, which is not a thing that happens:
 * a processor declines that payment rather than paying to accept it.
 */
export function feeFor(grossCents: number, schedule: FeeSchedule): Settlement {
  const gross = Math.max(0, Math.trunc(grossCents))

  const percentage = Math.round((gross * schedule.percentBp) / 10_000)
  const uncapped = percentage + Math.max(0, Math.trunc(schedule.fixedCents))
  const feeCents = Math.min(gross, Math.max(0, uncapped))

  return { grossCents: gross, feeCents, netCents: gross - feeCents }
}

/** Describes a fee schedule the way a statement does, for a screen. */
export function describeSchedule(schedule: FeeSchedule): string {
  const percent = (schedule.percentBp / 100).toFixed(2).replace(/\.?0+$/, '')
  const fixed = (schedule.fixedCents / 100).toFixed(2)
  return `${percent}% + ${fixed} per payment`
}

export type PayoutItem = {
  paymentId: string
  grossCents: number
  feeCents: number
}

export type PayoutCheck = {
  /** What the payments in this batch came to before fees. */
  grossCents: number
  feeCents: number
  /** What the batch should therefore deposit. */
  expectedCents: number
  /** What the processor says it deposited. */
  reportedCents: number
  /** Reported minus expected. Zero is the only good answer. */
  differenceCents: number
  balances: boolean
  count: number
}

/**
 * Whether a payout equals the payments it claims to settle.
 *
 * Checked rather than assumed, because a payout is the one number in this
 * whole flow that arrives from outside and is posted to the bank. If it
 * disagrees with its own items, one of three things has happened — a refund
 * or chargeback netted off the batch, a fee schedule that is not what the
 * company thinks it is, or a payment recorded twice — and all three are worth
 * a person's attention before the entry posts, not after.
 */
export function payoutReconciliation(input: {
  reportedCents: number
  items: PayoutItem[]
}): PayoutCheck {
  const grossCents = input.items.reduce((sum, item) => sum + item.grossCents, 0)
  const feeCents = input.items.reduce((sum, item) => sum + item.feeCents, 0)
  const expectedCents = grossCents - feeCents

  return {
    grossCents,
    feeCents,
    expectedCents,
    reportedCents: input.reportedCents,
    differenceCents: input.reportedCents - expectedCents,
    balances: input.reportedCents === expectedCents,
    count: input.items.length,
  }
}

/**
 * How much of an invoice a payment may settle.
 *
 * The **gross** settles the debt, not the net. The customer paid $1,000 and
 * owes nothing more; the fee is a cost the business chose to incur by
 * accepting a card, and charging it back to the customer's balance would
 * leave every card-paid invoice showing 29 dollars outstanding for ever.
 *
 * Refuses to overpay, for the reason Phase 41 gave: an invoice that has been
 * part-paid since the link was opened must not be paid twice, and the customer
 * is looking at a page that may be minutes stale.
 */
export function payableAmount(input: {
  balanceCents: number
  requestedCents?: number | null
}): { ok: true; amountCents: number } | { ok: false; reason: string } {
  const balance = Math.trunc(input.balanceCents)

  if (balance <= 0) {
    return { ok: false, reason: 'This invoice has been settled. Nothing is outstanding.' }
  }

  const requested = input.requestedCents == null ? balance : Math.trunc(input.requestedCents)

  if (requested <= 0) return { ok: false, reason: 'Enter an amount to pay.' }
  if (requested > balance) {
    return { ok: false, reason: 'That is more than the amount outstanding on this invoice.' }
  }

  return { ok: true, amountCents: requested }
}
