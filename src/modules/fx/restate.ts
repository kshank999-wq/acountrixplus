/**
 * Putting a posting right that went into the books at the wrong rate
 * (Phase 130).
 *
 * ## Why this exists
 *
 * Three consecutive ADRs end with the same sentence:
 *
 * > **It does not repair the books of anybody who already hit this.** …
 * > correcting it is a decision with a date and a reason, and belongs to
 * > whoever owns those books. *(ADR 0127)*
 *
 * > **It does not repair books already affected.** Every foreign bank
 * > transaction posted before this is still in the ledger at its face value.
 * > *(ADR 0128)*
 *
 * > **It does not repair the rows the backfill exposes.** It counts them and
 * > names them. *(ADR 0129)*
 *
 * Each was right about *how* — a repair is a dated correction, never something
 * a migration does behind anybody's back. None of them provided the correction.
 * Phase 31 taught, and Phase 33 wrote down, what a follow-up repeated across
 * consecutive ADRs usually means: **it is the phase.** Three is not a hint.
 *
 * ## What a restatement is, and what it is not
 *
 * It is **not** a re-post. `syncLedgerForTransaction` voids and rebuilds, and
 * Phase 129 stopped that from touching the rate precisely because it rewrote
 * history with no record. Repairing by re-posting would reintroduce the defect
 * wearing the clothes of a fix: the old figure would vanish, and a period
 * somebody has already reported on would quietly change.
 *
 * So a restatement is a **second entry**, dated the day the decision is made,
 * carrying the difference and a reason. The original stays exactly as it was —
 * which is what makes the books readable afterwards, and what lets a closed
 * period refuse it through the machinery Phase 92 already built.
 *
 * ## The allocation rule
 *
 * A transaction's entry is category lines against one bank line. Scaling each
 * category line and letting the bank line be the sum of the scaled parts is
 * Phase 35's rule for converting a document — convert the parts, total the
 * conversions — and it is here for the same reason: converting the total
 * separately and spreading it leaves the entry a cent out against itself.
 */

/** What a restatement would do, before anybody commits to it. */
export type Restatement = {
  /** What the books carry for this movement now. */
  fromCents: number
  /** What they will carry once the correcting entry is posted. */
  toCents: number
  /** The correcting entry's own magnitude — what actually gets posted. */
  deltaCents: number
  /**
   * The difference on each category line, in the order they were given.
   *
   * Signed against the original: positive means that line takes more.
   */
  categoryDeltas: number[]
}

export type RestateVerdict =
  | { ok: true; restatement: Restatement }
  | { ok: false; why: string }

/**
 * What a correcting entry would carry, or why there is nothing to correct.
 *
 * `categoryCents` are the magnitudes of the original entry's category lines,
 * which sum to what the bank line was posted at. A simple transaction has one;
 * a split has several.
 */
export function restatement(input: {
  categoryCents: readonly number[]
  /** What the books took for the movement — the bank line's magnitude. */
  fromCents: number
  /** What they should have taken. */
  toCents: number
}): RestateVerdict {
  const { categoryCents, fromCents, toCents } = input

  if (!Number.isFinite(toCents) || toCents <= 0) {
    return { ok: false, why: 'A restatement has to put the movement at more than nothing.' }
  }

  if (fromCents <= 0) {
    return {
      ok: false,
      why: 'This movement is not in the books at a figure that can be restated.',
    }
  }

  if (toCents === fromCents) {
    return {
      ok: false,
      why: 'That is what the books already carry, so there is nothing to correct.',
    }
  }

  const total = categoryCents.reduce((sum, cents) => sum + cents, 0)
  if (total !== fromCents) {
    return {
      ok: false,
      why:
        'The category lines do not add up to what the bank line carries, so this entry cannot ' +
        'be restated without deciding something nobody has decided.',
    }
  }

  // Each part scaled at the new rate, and the whole taken as the sum of the
  // scaled parts. Phase 35's rule: never the other way round.
  const categoryDeltas = categoryCents.map(
    (cents) => Math.round((cents * toCents) / fromCents) - cents,
  )
  const deltaCents = categoryDeltas.reduce((sum, cents) => sum + cents, 0)

  if (deltaCents === 0) {
    return {
      ok: false,
      why: 'At that rate the books carry the same figure to the cent, so nothing would change.',
    }
  }

  return {
    ok: true,
    restatement: {
      fromCents,
      // What the entry will actually carry — the sum of the parts, which can
      // differ from `toCents` by a cent when the parts round. The parts are
      // what the ledger gets, so they are what this reports.
      toCents: fromCents + deltaCents,
      deltaCents,
      categoryDeltas,
    },
  }
}

/**
 * Whether this transaction is one a person may restate at all.
 *
 * A movement that never posted has nothing to correct — categorise it and it
 * will post at the rate on file, which is the ordinary path rather than a
 * correction. Phase 129's rule that a posted rate is fixed is exactly what
 * makes this a separate, deliberate act.
 */
export function mayRestate(input: {
  rateMillionths: number | null
  functionalAmountCents: number | null
}): { ok: true } | { ok: false; why: string } {
  if (input.rateMillionths === null || input.functionalAmountCents === null) {
    return {
      ok: false,
      why:
        'This transaction has not been posted, so there is no figure in the books to put right. ' +
        'Categorise it and it will post at the rate on file for the day it moved.',
    }
  }

  return { ok: true }
}
