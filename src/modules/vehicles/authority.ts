/**
 * What the customer said yes to (spec §5 "Automotive / Repair").
 *
 * A pure core, with no database and no clock, for the reason every phase since
 * Phase 16 has had one — and here the reason is not only that somebody
 * disputes the arithmetic. **This is the one module in the application whose
 * central rule exists because the law says so.** Most jurisdictions require a
 * repair shop to obtain the customer's authorisation before exceeding a written
 * estimate, and a shop that bills past it has a bill it may not be able to
 * collect and a regulator it may have to explain itself to.
 *
 * ## The claims this file makes true
 *
 * **Nobody bills past what was authorised.** The ceiling is the authorised
 * amount plus whatever tolerance the shop has agreed, and work beyond it is
 * refused until somebody says yes again.
 *
 * **An odometer does not go backwards.** A reading below the last one recorded
 * is either a typo, a replaced instrument cluster, or a crime, and the three
 * need telling apart rather than averaging.
 */

export type AuthorityInput = {
  /** The total the customer has approved, across every authorisation so far. */
  authorisedCents: number
  /**
   * How far over the shop may go without asking again, in basis points.
   *
   * Zero is a legitimate and common setting: it means every penny over needs a
   * fresh yes. A tolerance exists because a job quoted at £400 that comes to
   * £402 should not need a phone call, not because the estimate is a suggestion.
   */
  toleranceBp: number
  /** What the work on the order currently adds up to. */
  quotedCents: number
}

export type Authority = {
  /** Authorised plus tolerance. The most that may be billed. */
  ceilingCents: number
  /** What is still available to commit without asking again. */
  headroomCents: number
  /** True when the order can be completed as it stands. */
  withinAuthority: boolean
  /**
   * How far past the ceiling the order is. Zero when within.
   *
   * Reported separately from `headroomCents` rather than as its negative,
   * because "you have £40 left" and "you are £40 over" are different sentences
   * to a service advisor and only one of them ends in a phone call.
   */
  overByCents: number
  /**
   * What a fresh authorisation would have to cover to make this order billable.
   *
   * The number the advisor reads down the phone. Deliberately the *additional*
   * amount rather than the new total, because that is what the customer is
   * being asked to agree to.
   */
  needsAuthorisationForCents: number
}

/**
 * Whether the work on an order is covered by what the customer agreed.
 *
 * The tolerance is applied to the authorised amount, not to the quote — so a
 * 10% tolerance on £400 authorised is a £440 ceiling, and stays £440 however
 * large the quote grows. Applying it to the quote instead would make the
 * allowance grow with the overspend, which is the opposite of a limit.
 */
export function authorityFor(input: AuthorityInput): Authority {
  const authorisedCents = amount(input.authorisedCents)
  const quotedCents = amount(input.quotedCents)
  const toleranceBp = clampBp(input.toleranceBp)

  // Rounded down: a ceiling that rounds up is a ceiling the shop set itself.
  const ceilingCents = authorisedCents + Math.floor((authorisedCents * toleranceBp) / 10_000)

  const withinAuthority = quotedCents <= ceilingCents

  return {
    ceilingCents,
    headroomCents: Math.max(0, ceilingCents - quotedCents),
    withinAuthority,
    overByCents: Math.max(0, quotedCents - ceilingCents),
    // What must be authorised, not what the total becomes. The tolerance is
    // deliberately not counted on again here: asking the customer to approve
    // £400 and then billing £440 because a tolerance applies to the new
    // authorisation too is how a limit stops being one.
    needsAuthorisationForCents: withinAuthority ? 0 : quotedCents - authorisedCents,
  }
}

export type OdometerVerdict =
  /** Higher than last time, or the first reading ever taken. */
  | { kind: 'ok'; milesTravelled: number | null }
  /**
   * The same reading as last time.
   *
   * Not an error: a car towed in, looked at, and collected without being driven
   * genuinely has not moved. Named rather than folded into `ok` so a shop that
   * sees a run of them can ask why.
   */
  | { kind: 'unmoved' }
  /**
   * Lower than last time.
   *
   * Refused rather than recorded. Odometer rollback is a crime in most places,
   * and the honest alternatives — a typo, or a replaced instrument cluster —
   * are both things a person has to assert deliberately rather than have
   * inferred for them.
   */
  | { kind: 'backwards'; byMiles: number }

/**
 * Whether a new odometer reading can follow the last one.
 *
 * `lastMiles` is null for a vehicle nobody has recorded a reading for yet, and
 * that first reading is accepted whatever it says — there is nothing to
 * contradict it.
 */
export function odometerStep(lastMiles: number | null, readingMiles: number): OdometerVerdict {
  const reading = Math.max(0, Math.round(Number.isFinite(readingMiles) ? readingMiles : 0))

  if (lastMiles === null || !Number.isFinite(lastMiles)) {
    return { kind: 'ok', milesTravelled: null }
  }

  const last = Math.max(0, Math.round(lastMiles))

  if (reading === last) return { kind: 'unmoved' }
  if (reading < last) return { kind: 'backwards', byMiles: last - reading }

  return { kind: 'ok', milesTravelled: reading - last }
}

/** A total that is not a number is zero, never `NaN` reaching a journal line. */
function amount(cents: number): number {
  if (!Number.isFinite(cents)) return 0
  return Math.max(0, Math.round(cents))
}

/** A rate outside 0–100% is a typo, not an instruction. */
function clampBp(bp: number): number {
  if (!Number.isFinite(bp)) return 0
  return Math.min(10_000, Math.max(0, Math.round(bp)))
}
