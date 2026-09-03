/**
 * How far back a check can see (spec §19).
 *
 * ## The defect
 *
 * Every check in the register takes an `asOf` date. Most walk their **ledger**
 * side back to it with `entry_date <= asOf`, and then read their **subledger**
 * side as it stands now. Phase 108 fixed that for the two control accounts and
 * did not reach the rest.
 *
 * Measured by running every check at three dates against the development books:
 *
 * ```
 * inventory.lots   2026-09-03: agrees  2855920/2855920
 *                  2026-05-31: DIFFERS 2855920/1668600
 *                  2026-03-31: DIFFERS 2855920/0
 * ```
 *
 * The left figure never moves; the right one walks back. `inventory.lots` is a
 * **fault** — the register's highest severity — so asking about March reports
 * $28,559.20 of broken books on books that are perfectly correct.
 * `reconcileInventory`'s own doc comment says why that matters:
 *
 * > a reconciliation that cries wolf is one people learn to ignore.
 *
 * ## Why a declaration rather than nine repairs
 *
 * Some subledgers can be restored to a date and some cannot, and which is which
 * is a fact about each one's tables — not something a reader of the register can
 * infer. So each check **declares its reach**, with prose arguing for it, on the
 * device Phases 70, 101, 105, 106 and 108 used.
 *
 * A check that cannot answer for a past date is **skipped** there rather than
 * answered wrongly. The register already separates a skip from a pass, and says
 * so in as many words:
 *
 * > a skip is not a pass. It is counted separately and never contributes to
 *
 * The nightly run asks about today, so nothing about it changes.
 *
 * No database and no clock: this file decides, `service.ts` runs.
 */

/** Whether a check's subledger side can be restored to a past date. */
export type Reach = 'any_date' | 'today_only'

export type ReachDeclaration = {
  reach: Reach
  /**
   * What makes the subledger side restorable, or what stops it.
   *
   * Prose rather than a bare enum for the reason Phase 70 gave: `today_only`
   * looks identical whether it is a considered limit or an oversight, and the
   * argument is the part a reader needs.
   */
  because: string
}

export type Runnable =
  | { run: true }
  | { run: false; because: string }

/**
 * Whether this check can honestly answer for `asOf`.
 *
 * `today` is a parameter and never a clock read, like everything else in this
 * module. A check reaching `any_date` always runs; a `today_only` one runs only
 * when the date asked about is today or later — a date in the future has the
 * same present-tense subledger as today, so nothing is lost by answering.
 */
export function runnableAt(
  check: { key: string; label: string; asAt: ReachDeclaration },
  asOf: string,
  today: string,
): Runnable {
  if (check.asAt.reach === 'any_date') return { run: true }
  if (asOf >= today) return { run: true }

  return {
    run: false,
    because:
      `“${check.label}” can only speak for today: ${check.asAt.because} ` +
      `Rather than compare a ledger as at ${asOf} against a subledger as it stands now — ` +
      'which reports a difference on books that are correct — it was skipped.',
  }
}

/**
 * What the page says about the checks a date put out of reach.
 *
 * Kept separate from the module-gated skips because the two mean different
 * things: a module switched off is a check that does not apply, and this is a
 * check that applies but cannot answer the question asked. Reporting them as
 * one number would leave somebody thinking a check they rely on had been turned
 * off.
 */
export function outOfReachNote(count: number, asOf: string): string | undefined {
  if (count === 0) return undefined

  return count === 1
    ? `1 check could not answer for ${asOf} and was skipped — it can only speak for today.`
    : `${count} checks could not answer for ${asOf} and were skipped — they can only speak for today.`
}
