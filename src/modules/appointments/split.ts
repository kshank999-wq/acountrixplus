/**
 * What an appointment is worth, and to whom (spec §5).
 *
 * Two industry rows again, as in Phase 28: Healthcare/Practice asks for
 * "service revenue, providers, locations, payment categories", and Personal
 * Care asks for "appointments/service revenue, staff/contractor splits,
 * products". A dentist and a hair salon keep a diary, deliver a service out of
 * it, and owe a share of it to the person who did the work. That is one shape.
 *
 * A pure core, with no database and no clock, for the reason every phase since
 * Phase 16 has had one — but here the reason is unusually literal. **This is
 * the arithmetic that decides what somebody is paid.** A stylist on 45% who
 * thinks they are owed £58.50 and is handed £58.49 will ask, and the answer has
 * to be something better than "that is what the system said".
 *
 * ## The claims this file makes true
 *
 * **The split always sums to the price.** Not approximately, and not with a
 * remainder somebody has to chase later. The practitioner's share is computed
 * and the business takes what is left — so the two halves add to the whole by
 * construction rather than by luck.
 *
 * **A card is money the business already has and has not yet earned.** A gift
 * card cannot pay more than the bill, and cannot pay more than it holds. Both
 * are arithmetic, and both go wrong in the same direction if nobody writes them
 * down: a card that overpays turns a liability into revenue that was never
 * there.
 */

/** Rates are basis points — 4_500 is 45%. */
export type SplitInput = {
  /** What the service was actually charged at, after any discount. */
  serviceCents: number
  /** Retail sold alongside the service. Often split at a different rate. */
  productCents: number
  /** The practitioner's share of the service, in basis points. */
  commissionBp: number
  /**
   * Their share of the retail, in basis points.
   *
   * Separate from `commissionBp` because they genuinely differ in this trade —
   * a stylist on 45% of the service is commonly on 10% of the shampoo, and one
   * rate covering both would misstate every bill that had a product on it.
   */
  productCommissionBp: number
}

export type Split = {
  /** What the client was charged in total. */
  totalCents: number
  /** Owed to the practitioner, and theirs from the moment the work is done. */
  practitionerCents: number
  /** What the business keeps. `total - practitioner`, always. */
  businessCents: number
  /**
   * The fraction of a penny the exact rates would have produced, and who got
   * it. Positive means the business kept it.
   *
   * Surfaced rather than silently absorbed because "why is it 49p and not 50p"
   * is a question with an answer, and the answer should not require reading
   * this file.
   */
  roundingCents: number
}

/**
 * Divides a bill between the business and the person who did the work.
 *
 * ## Two decisions worth arguing with
 *
 * **The split is taken on what was charged, not on what was listed.** A £100
 * service discounted to £80 splits £80. The alternative — the practitioner
 * earning on the list price while the business absorbs the whole discount —
 * exists in the trade and is a defensible commercial choice, but it makes the
 * discount invisible in the split and lets a manager give away margin that is
 * not theirs to give.
 *
 * **The business absorbs the half-penny.** The practitioner's share is rounded
 * and the business takes the remainder, so the two always sum to the price.
 * Consistency is what matters more than direction here: a rule that sometimes
 * favours one party and sometimes the other is the one that produces a
 * discrepancy nobody can explain.
 */
export function splitFor(input: SplitInput): Split {
  const serviceCents = amount(input.serviceCents)
  const productCents = amount(input.productCents)
  const totalCents = serviceCents + productCents

  // Kept in ten-thousandths of a penny until the last step, so the remainder
  // below is exact integer arithmetic rather than whatever a float left behind.
  const exactScaled =
    serviceCents * clampBp(input.commissionBp) + productCents * clampBp(input.productCommissionBp)

  const practitionerCents = Math.round(exactScaled / 10_000)

  return {
    totalCents,
    practitionerCents,
    businessCents: totalCents - practitionerCents,
    // Positive when the practitioner was rounded down and the business kept it.
    roundingCents: (exactScaled - practitionerCents * 10_000) / 10_000,
  }
}

/**
 * A price that is not a number is zero, not `NaN`.
 *
 * `Math.max(0, NaN)` is `NaN`, so without this a bad input would run all the
 * way through to a journal line and put `NaN` in the ledger — which balances
 * against nothing and cannot be reported on. Nothing in the schema can produce
 * one today; this is here so that stays true if a caller ever computes a price
 * rather than reading one.
 */
function amount(cents: number): number {
  if (!Number.isFinite(cents)) return 0
  return Math.max(0, Math.round(cents))
}

/**
 * A rate outside 0–100% is a typo, not an instruction.
 *
 * Clamped rather than thrown on, because this is a pure function called from a
 * report as readily as from a posting, and a report that raises is a report
 * that cannot show you the row that is wrong.
 */
function clampBp(bp: number): number {
  if (!Number.isFinite(bp)) return 0
  return Math.min(10_000, Math.max(0, Math.round(bp)))
}

export type Redemption = {
  /** Taken off the bill and out of the card. */
  appliedCents: number
  /** What the card holds afterwards. Never negative. */
  remainingBalanceCents: number
  /** What the client still has to pay by some other means. */
  stillDueCents: number
}

/**
 * How much of a bill a gift card can settle.
 *
 * Both bounds matter and they fail differently. A card cannot pay more than it
 * holds — that would create money. A card cannot pay more than the bill —
 * that would hand back change in cash on a voucher, turning a liability the
 * business owes in *service* into one it owes in money, which is a materially
 * different promise and in several jurisdictions a regulated one.
 */
export function redeemFor(balanceCents: number, dueCents: number): Redemption {
  const balance = amount(balanceCents)
  const due = amount(dueCents)
  const appliedCents = Math.min(balance, due)

  return {
    appliedCents,
    remainingBalanceCents: balance - appliedCents,
    stillDueCents: due - appliedCents,
  }
}
