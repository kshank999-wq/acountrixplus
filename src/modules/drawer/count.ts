import { formatCents } from '@/lib/money'

/**
 * What a drawer should hold, and what it actually held (spec §5, §13).
 *
 * Phase 32 built taking money at a counter and left a limitation written down
 * in as many words:
 *
 * > There is no cash drawer, shift or Z-reading. The change figure is shown and
 * > deliberately never posted, so a drawer counted against the ledger will show
 * > $50 in and $30 out where the ledger says $20 — correct, and a thing to know
 * > before reconciling one.
 *
 * This is the reconciling. And the thing worth noticing is that Phase 32's
 * decision is what makes the arithmetic come out: because only what was *kept*
 * is ever posted, the drawer's expected balance is
 *
 *     float + Σ cash applied − Σ paid out
 *
 * and change appears nowhere in it. A system that had posted $50 in and $30
 * out would need to net them back off to count a till, and would be wrong the
 * first time somebody miscounted a single transaction.
 *
 * A pure core, with no database and no clock — the eleventh, and for the same
 * reason as the tender core: the sum is being done in front of somebody
 * holding the notes, and they have to be able to say why it says what it says.
 *
 * ## The claims this file makes true
 *
 * **Counting is a declaration, not a calculation.** `countedCents` comes from a
 * person looking in a drawer. Nothing here derives it, adjusts it, or rounds it
 * towards what was expected. The whole value of a Z-reading is that it is what
 * somebody said was there.
 *
 * **A difference is named, never plugged.** Over and short are the same fact
 * with opposite signs and both are posted. A till that is $2 over is not a
 * till that balanced.
 *
 * **A float is not takings.** It goes in at the start and comes out at the end,
 * and it is somebody's working capital rather than anything the business
 * earned.
 */

/** Money that left the drawer during a shift for something other than banking. */
export type PaidOut = {
  /** What it was for. Recorded, never interpreted. */
  reason: string
  amountCents: number
}

export type ShiftCount = {
  /** What was put in at the start. */
  floatCents: number
  /** What the counter took in cash and kept. Change is not in here. */
  takingsCents: number
  /** Petty spending out of the drawer during the shift. */
  paidOutCents: number
  /** What the drawer should therefore hold. */
  expectedCents: number
  /** What somebody counted. A declaration. */
  countedCents: number
  /**
   * Counted less expected. Positive is over, negative is short.
   *
   * Not an error to be corrected — a fact to be posted. `5900 Cash Over and
   * Short` is where it goes, and a running balance near zero is a well-run
   * till while a drifting one is a question for somebody.
   */
  overShortCents: number
  /** True only when the count lands exactly. */
  balances: boolean
  /**
   * What is left to bank once the float is taken back out.
   *
   * Measured from what was *counted*, not from what was expected: the business
   * can only bank money it actually has.
   */
  toBankCents: number
  /** The float carried to the next shift, or taken back to petty cash. */
  floatRetainedCents: number
}

/** Raised when a count cannot be made sense of. */
export class DrawerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DrawerError'
  }
}

export type CountInput = {
  floatCents: number
  takingsCents: number
  paidOut?: PaidOut[]
  countedCents: number
  /**
   * How much float to leave in the drawer for the next shift.
   *
   * Defaults to the float it opened with, which is what a shop that runs the
   * same till every day actually does. Zero empties it.
   */
  retainFloatCents?: number
}

/**
 * Works out what a drawer should hold and what the count says.
 *
 * ## Why the float is not subtracted from the difference
 *
 * A tempting shortcut is to compare `counted − float` against takings. It gives
 * the same number when the float is right and hides the case that matters: a
 * shift that opened with the wrong float. Keeping the float on the expected
 * side means a drawer opened with $80 instead of $100 reads as $20 short on
 * the day it happens, which is when somebody can still remember why.
 */
export function countFor(input: CountInput): ShiftCount {
  const floatCents = amount(input.floatCents)
  const takingsCents = amount(input.takingsCents)
  const paidOutCents = (input.paidOut ?? []).reduce(
    (sum, row) => sum + amount(row.amountCents),
    0,
  )
  const countedCents = amount(input.countedCents)

  const expectedCents = floatCents + takingsCents - paidOutCents

  if (expectedCents < 0) {
    throw new DrawerError(
      `More was paid out of this drawer (${formatCents(paidOutCents)}) than ever went into it ` +
        `(${formatCents(floatCents + takingsCents)}). One of those is wrong.`,
    )
  }

  const retainFloatCents = Math.min(
    amount(input.retainFloatCents ?? floatCents),
    countedCents,
  )

  return {
    floatCents,
    takingsCents,
    paidOutCents,
    expectedCents,
    countedCents,
    overShortCents: countedCents - expectedCents,
    balances: countedCents === expectedCents,
    toBankCents: countedCents - retainFloatCents,
    floatRetainedCents: retainFloatCents,
  }
}

/** How a difference reads to somebody at the counter. */
export function describe(count: ShiftCount): string {
  if (count.balances) return 'The drawer balances.'

  const size = formatCents(Math.abs(count.overShortCents))
  return count.overShortCents > 0
    ? `${size} more in the drawer than the till says was taken.`
    : `${size} less in the drawer than the till says was taken.`
}

/** A figure that is not a number is zero, never `NaN` reaching a journal line. */
function amount(cents: number): number {
  if (!Number.isFinite(cents)) return 0
  return Math.max(0, Math.round(cents))
}
