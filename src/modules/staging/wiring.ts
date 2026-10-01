/**
 * What is built and not wired (Phase 139).
 *
 * ## Why this exists
 *
 * The cores are being put in place first and hooked up in a later pass, so that
 * banks, deposits and the rest are connected deliberately rather than one at a
 * time. That is a reasonable way to stage the work and it has one sharp cost:
 *
 * > **Phase 49's rule.** A function with no caller is a feature that does not
 * > exist. A staged core is indistinguishable from a forgotten one, and the only
 * > record that `spends` is waiting for `applyDeposit` is prose in three files
 * > that nothing checks.
 *
 * Prose that nothing checks is what Phase 135 found rotting in `BANK_POSTINGS`,
 * and ADR 0135's answer applies here too: **a false sentence is exactly as long
 * as a true one.** So the backlog is a registry, and a scan holds it to the
 * source in both directions:
 *
 * - an entry whose target **does** call the core is stale, and must be removed
 *   rather than left to read as outstanding;
 * - an entry with nothing blocking it must name the test that says it is done,
 *   because "wire it up" with no acceptance is a task nobody can finish.
 *
 * ## What it is not
 *
 * Not a list of every unwired export. Measured: **1,349 exported functions in
 * `src/modules`, 293 with no caller elsewhere in `src/`** — and almost all of
 * those are registry lookups (`bankPostingFor`, `carrierFor`, `falsifierFor`)
 * and devices a test drives on purpose. A scan that called those dead would be
 * wrong about nearly three hundred things, which is why this is a declaration
 * with prose rather than a count.
 *
 * This registry holds only work that is **known to be outstanding and known to
 * be wrong today**: each entry names a defect still live in the code.
 */

/** What stands between the entry and being wired. */
export type Blocker =
  /**
   * Only the wiring. Every piece exists; somebody has to call the core and
   * unskip the acceptance test.
   */
  | 'nothing'
  /**
   * A column and the screen that fills it. The path cannot ask the question
   * because nothing records the answer, so wiring alone would not help — this
   * is the shape ADR 0136 called "a real change to a real screen".
   */
  | 'a field'
  /**
   * A table. Not a column on an existing row but a **row that does not exist**
   * (Phase 153).
   *
   * Stronger than `a field` and sharper: a column can be added to the row the
   * act already writes, and this cannot, because the act writes no row of its
   * own. Separated from `a field` when `receivePledge` turned out to be the one
   * of four that could not be cleared by a migration — it accumulates into
   * `contributions.received_cents` and each instalment has its own day and its
   * own rate, so a single rate column would be right for the first receipt and
   * quietly wrong for the second.
   */
  | 'a row'

export type Pending = {
  /** The core that exists and is not called. */
  core: string
  coreFile: string
  /** What has to call it. One entry may name several. */
  targets: readonly { symbol: string; file: string }[]
  /** The phase that built or nominated it. */
  phase: number
  blockedBy: Blocker
  /**
   * The test that says this is done — skipped until it is.
   *
   * Required when nothing is blocking. `null` is only honest for an entry that
   * cannot be finished yet, because a test written against a column that does
   * not exist would be fiction rather than a definition of done.
   */
  acceptance: string | null
  /**
   * What is wrong in the code **today**, in a sentence somebody can go and
   * check. Not what the fix will do — what the defect is, so that reading this
   * registry is reading a list of live faults rather than a list of plans.
   */
  liveDefect: string
  /** Why it is staged rather than wired, argued. */
  because: string
}

export const PENDING_WIRING: readonly Pending[] = [
  {
    core: 'mayPostToBank',
    coreFile: 'src/modules/fx/bank-side.ts',
    targets: [{ symbol: 'receivePledge', file: 'src/modules/funds/contributions.ts' }],
    phase: 136,
    blockedBy: 'a row',
    acceptance: null,
    liveDefect:
      '`receivePledge` refuses a foreign bank account outright, so a fund keeping a euro account ' +
      'has to record a donor’s receipt against a home-currency account the money did not go into, ' +
      'or not record it at all. Three of the four paths this entry named were cleared in Phase 153 ' +
      'by a migration; this one needs a row rather than a column and is the only one left.',
    because:
      'A pledge is received in instalments — `received_cents` accumulates and the function refuses ' +
      'more than is outstanding — so each receipt has its own day and its own rate, and there is ' +
      'no row for a receipt to carry them on. Phase 129’s rule is that a posting records the rate ' +
      'it used; a single `exchange_rate_millionths` on `contributions` would be right for the ' +
      'first instalment and wrong for the second, which is worse than the refusal it replaced. ' +
      'The acceptance test is `null` for the same reason it was in Phase 136: one written against ' +
      'a table that does not exist would be fiction rather than a definition of done.',
  },
]

export type WiringVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether an entry still describes the code.
 *
 * `targetsCallingCore` and `coreExists` are **measured from the source**, never
 * declared — the same rule Phase 136's `askingFor` follows, for the same reason:
 * a backlog that believes its own entries is a backlog that goes stale.
 */
export function wiringStateFor(input: {
  entry: Pending
  /** Measured: which of the entry's targets already call the core. */
  targetsCallingCore: readonly string[]
  /** Measured: is the core exported where the entry says it is? */
  coreExists: boolean
  /** Measured: does the named acceptance file exist? `null` when none is named. */
  acceptanceExists: boolean | null
}): WiringVerdict {
  const { entry, targetsCallingCore, coreExists, acceptanceExists } = input

  if (!coreExists) {
    return {
      ok: false,
      why:
        `${entry.core} is not exported from ${entry.coreFile}, so this entry names nothing. ` +
        'Either the core moved and the entry needs its new home, or it was never built and the ' +
        'entry is a plan wearing the clothes of a fact.',
    }
  }

  if (targetsCallingCore.length > 0) {
    return {
      ok: false,
      why:
        `${targetsCallingCore.join(', ')} already call${targetsCallingCore.length === 1 ? 's' : ''} ` +
        `${entry.core}, so this entry is stale and must be removed. A backlog that still lists ` +
        'finished work is worse than no backlog: it makes the remaining entries untrustworthy ' +
        'too.',
    }
  }

  if (entry.blockedBy === 'nothing' && entry.acceptance === null) {
    return {
      ok: false,
      why:
        `${entry.core} has nothing blocking it and names no acceptance test, so "wire it up" has ` +
        'no definition of done. An entry that cannot be finished cannot be checked off, and one ' +
        'that is never checked off is how a backlog becomes a graveyard.',
    }
  }

  if (entry.acceptance !== null && acceptanceExists === false) {
    return {
      ok: false,
      why:
        `${entry.core} names ${entry.acceptance} as its acceptance test and that file does not ` +
        'exist. The test is the entry’s only claim to being finishable.',
    }
  }

  return { ok: true }
}
