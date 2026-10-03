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

export const PENDING_WIRING: readonly Pending[] = []

/**
 * **Empty since Phase 157**, for the first time since this register was written.
 *
 * It held seven entries over eleven targets when Phase 139 built it, and the
 * entries left one at a time rather than in a clear-out:
 *
 * ```
 * 139  seven entries, eleven targets   built
 * 151  two entries                     the wiring pass took five
 * 153  one entry, one target           three of mayPostToBank's four targets
 * 157  none                            receivePledge, which needed a row
 * ```
 *
 * The last one is the one worth remembering. Phase 153 cleared three of
 * `mayPostToBank`'s four targets by adding columns and could not clear the
 * fourth, because a pledge is received in instalments and each has its own day
 * and its own rate — so it argued `a row` as a blocker distinct from `a field`
 * rather than adding a column that would be right for the first instalment and
 * wrong for the second. Four phases later that row exists and the entry is gone.
 *
 * ## Kept rather than deleted
 *
 * `wiringStateFor` still refuses an entry whose target already calls its core,
 * an entry naming a core that is not exported, and an unblocked entry with no
 * acceptance test. Those rules are what made the register worth having, and the
 * situation it was built for — a core built in one phase and wired in a later
 * one — is how this project works. The next staged core should find the
 * vocabulary already here rather than argue it again.
 *
 * `tests/pending-wiring.test.ts` asserts the emptiness rather than tolerating
 * it, and holds every rule against a fixture entry written in the test so that
 * the rules are still checked on a day when nothing is outstanding.
 */

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
