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
    targets: [
      { symbol: 'recordRemittance', file: 'src/modules/payroll/remittance.ts' },
      { symbol: 'receivePledge', file: 'src/modules/funds/contributions.ts' },
      { symbol: 'receiveDeposit', file: 'src/modules/properties/deposits.ts' },
      { symbol: 'refundDeposit', file: 'src/modules/properties/deposits.ts' },
    ],
    phase: 136,
    blockedBy: 'a field',
    acceptance: null,
    liveDefect:
      'These four refuse a foreign bank account outright, so a business banking in euros cannot ' +
      'remit a payroll liability, take a pledge, or hold and return a tenancy deposit through ' +
      'that account at all. The refusal is honest — nothing records what currency the money was ' +
      'in — but it is a capability that does not exist rather than a figure that is wrong.',
    because:
      '`mayPostToBank` has taken a `moneyCurrency` since Phase 136 and these four have nothing to ' +
      'pass it. ADR 0136 called that "a real change to a real screen" and declined to make it, ' +
      'and that is still right: a column, a form field and a migration come before the wiring. ' +
      'The acceptance test is `null` on purpose — one written against a column that does not ' +
      'exist would be fiction rather than a definition of done.',
  },
  {
    core: 'priceApplicationLines',
    coreFile: 'src/modules/jobs/application.ts',
    targets: [
      { symbol: 'priceApplication', file: 'src/modules/jobs/billing.ts' },
      { symbol: 'BillingPanel', file: 'src/app/jobs/[id]/panels.tsx' },
    ],
    phase: 146,
    blockedBy: 'nothing',
    acceptance: 'tests/a-preview-that-matches-the-post.test.ts',
    liveDefect:
      'priceApplication says it was separated out so the UI could show what an application will ' +
      'bill, and the UI has never called it — its only caller is createProgressBilling. ' +
      'BillingPanel works the three figures out again and reports a total the service will not ' +
      'honour: a line billed backwards is clamped to zero on the screen and refused outright on ' +
      'the server, and neither the percent nor the retainage is bounded before the click.',
    because:
      'The core is the service’s own arithmetic and its own sentences, moved rather than ' +
      'restated, with one change that is the point of the phase: problems come back as a list ' +
      'instead of throwing on the first, because a preview has to show all twelve at once where ' +
      'a commit only has to refuse. Wiring it touches a screen and a service together, which is ' +
      'the pass this is staged for.',
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
