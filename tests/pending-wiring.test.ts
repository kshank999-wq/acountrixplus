import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PENDING_WIRING, wiringStateFor, type Pending } from '@/modules/staging/wiring'

/**
 * What is built and not wired (Phase 139).
 *
 * No database, no clock. The cores are being staged and hooked up in a later
 * pass, which costs one thing: by Phase 49's rule a function with no caller is a
 * feature that does not exist, so a staged core and a forgotten one look
 * identical.
 *
 * This holds the register to the source in **both** directions — an entry that
 * has been wired is as wrong as one that never gets wired, because a backlog
 * still listing finished work makes its remaining entries untrustworthy too.
 */

/** The body of one top-level function. */
function bodyOf(file: string, symbol: string): string {
  const src = readFileSync(file, 'utf8')
  const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${symbol}\\(`, 'm'))
  if (start < 0) throw new Error(`${symbol} is not a top-level function in ${file}`)

  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end < 0 ? undefined : end)
}

/** Measured, never declared: which targets already call the core. */
function measured(entry: Pending) {
  const coreSrc = existsSync(entry.coreFile) ? readFileSync(entry.coreFile, 'utf8') : ''

  return {
    entry,
    coreExists: new RegExp(`^export (?:async )?function ${entry.core}\\(`, 'm').test(coreSrc),
    targetsCallingCore: entry.targets
      .filter((target) => new RegExp(`\\b${entry.core}\\(`).test(bodyOf(target.file, target.symbol)))
      .map((target) => target.symbol),
    acceptanceExists: entry.acceptance === null ? null : existsSync(entry.acceptance),
  }
}

describe('the register of what is staged', () => {
  it('is empty, and says so rather than letting that pass unnoticed', () => {
    // Measured, not bounded (Phase 126). Four entries covering seven targets:
    // the deposit application, the write-off recovery, the four paths that
    // refuse a foreign bank account because nothing records their currency, and
    // — added by Phase 141 — the donation that reads around the gate those four
    // go through.
    // Five since Phase 142 added the gift-card redemption, which ADR 0141 had
    // to leave off precisely because this register requires a core that exists.
    // Six since Phase 145 added the tax rounding, which is the first entry here
    // that is not about currency — the figure is in the right currency and is
    // the wrong number.
    // Seven over eleven since Phase 146, whose entry is the first to name a
    // target in `src/app` — a screen and a service that have to be wired to one
    // answer together, because the defect is that they each have their own.
    // Five over nine since Phase 151 started the wiring pass and took two off:
    // `bankGlAccountFor` → `recordContribution`, and `taxPerCode` →
    // `priceDocumentTax`. The register shrinks as the work is done, which is
    // the direction it was built to move in — `wiringStateFor` fails an entry
    // whose target already calls its core, so a finished entry cannot be left
    // sitting here reading as outstanding.
    // Four over eight: `recoverHeld` → `recoverWriteOff` went too, and wiring
    // it moved the only entry in `BANK_POSTINGS` whose handling has ever
    // changed — `refuses` to `matched`, because giving it a day rate removed
    // the reason it was withholding the money's currency.
    // Three over seven: `spends` → `applyDeposit` went too, and wiring it
    // needed two return values widened on the way — `settleInvoiceWithoutCash`
    // had returned the functional figure since Phase 127 with a declared type
    // that did not mention it, and `applyDeposit` had no way to tell a caller
    // what actually came off the tenancy.
    // Two over five: `affords` → `redeemGiftCard` went too, and unskipping its
    // acceptance test found that the test was a stub — it created an invoice,
    // asserted two ids were truthy, and never called `redeemGiftCard`. A
    // skipped test is where a fiction is easiest to keep, because nothing ever
    // runs it to find out.
    // One over four. `priceApplicationLines` → `priceApplication` and
    // `BillingPanel` was the last entry blocked by nothing, and the only one
    // naming a screen: the service prices through the core and reports its
    // problems, the panel calls the same core directly, and the refusal moved
    // to `createProgressBilling` where a commit's refusal belongs.
    //
    // **One over one since Phase 153.** `mayPostToBank` was blocked by a column
    // and has been since Phase 136; that phase added the columns and wired three
    // of its four targets. The fourth, `receivePledge`, is still here with a
    // *different* blocker: a pledge is received in instalments, so each receipt
    // has its own rate and there is no row to carry one on. `a row` was added as
    // a blocker rather than stretching `a field`, which is Phase 130's rule —
    // argue a new enum value instead of bending the nearest.
    //
    // The entry count did not move and the target count did, which is the shape
    // worth asserting: a register that only ever shrinks by whole entries cannot
    // show partial progress, and partial progress is what this was.
    //
    // **Empty since Phase 157**, for the first time since Phase 139 built this.
    // `contribution_receipts` is the row `receivePledge` was waiting on, so the
    // last entry is gone — and the emptiness is asserted rather than tolerated,
    // because a register nobody checks for staleness is how a finished backlog
    // and a forgotten one come to look alike.
    //
    // The four assertions in the next block test `wiringStateFor` against a
    // fixture written in this file, so the rules are still checked on a day when
    // nothing is outstanding. They were moved off the live register in Phase 151
    // for exactly this day.
    expect(PENDING_WIRING).toEqual([])
  })

  it('still describes the code, entry by entry', () => {
    // The assertion the register exists for. It fails when an entry is wired
    // (stale, remove it) and when one names a core that is not there.
    const wrong = PENDING_WIRING.map((entry) => wiringStateFor(measured(entry)))
      .filter((verdict) => !verdict.ok)
      .map((verdict) => (verdict.ok ? '' : verdict.why))

    expect(wrong).toEqual([])
  })

  it('argues every entry, because a list of names is a fact that looks the same either way', () => {
    // Phase 101's device, and Phase 135's lesson about what it costs when the
    // prose is never checked: a false sentence is exactly as long as a true one,
    // so length is the floor and not the point.
    for (const entry of PENDING_WIRING) {
      expect(entry.because.length, entry.core).toBeGreaterThan(140)
      expect(entry.liveDefect.length, entry.core).toBeGreaterThan(140)
    }
  })

  it('names a live defect for every entry, not a plan', () => {
    // What separates this from a wish list. Each entry says what is wrong in the
    // code today, so reading the register is reading a list of faults.
    //
    // `rounds` since Phase 145, argued rather than worked around: the entry it
    // was added for says "priceDocumentTax rounds every tax line on its own
    // base", which is present tense about live code and is the thing this
    // assertion is testing for. Writing it as "posts" to satisfy the list would
    // have been a worse sentence passing a check that had stopped meaning
    // anything — and the list is a spelling, which is the shape this codebase
    // has now found wanting seven times.
    for (const entry of PENDING_WIRING) {
      // `refuses?` since Phase 153, and the `s` is the whole change: the list
      // read `refuse\b`, which does not match "refuses". Every entry that had
      // used the word happened to have written the bare stem, so a check meant
      // to find a present-tense verb about live code was rejecting the most
      // natural present tense of one of its own six words. Widened rather than
      // worked around by rewording the entry, which is the direction Phase 145
      // settled: the sentence is the thing that has to be true.
      expect(entry.liveDefect, entry.core).toMatch(
        /\b(?:compares|posts|refuses?|reports|puts|rounds)\b/,
      )
    }
  })
})

describe('what the register refuses', () => {
  /**
   * An entry with nothing blocking it, written here rather than taken from the
   * register.
   *
   * It was `PENDING_WIRING[0]` until Phase 151 wired four entries off the front
   * and left a blocked one at index zero, and then it was a `find` for an
   * unblocked entry — until the wiring pass finished and there were none left.
   * These four are about what `wiringStateFor` refuses, not about what is
   * currently outstanding, so they should never have been reading the live
   * register: the day the backlog empties is the day they had nothing to stand
   * on, which is exactly when a rule about backlogs should still hold.
   */
  const entry: Pending = {
    core: 'someCore',
    coreFile: 'src/modules/fx/settlement.ts',
    targets: [{ symbol: 'someTarget', file: 'src/modules/receivables/credits.ts' }],
    phase: 151,
    blockedBy: 'nothing',
    acceptance: 'tests/pending-wiring.test.ts',
    liveDefect:
      'A sentence long enough to satisfy the register’s own floor, describing a fault that posts ' +
      'the wrong figure somewhere a person would eventually notice it, so that this fixture is ' +
      'shaped like the entries it stands in for rather than like a stub.',
    because:
      'A fixture, so that the four assertions below test `wiringStateFor` rather than whatever ' +
      'happens to be outstanding on the day they run. Taking a real entry made them pass for the ' +
      'wrong reason twice: once on a positional assumption, and once when the register emptied.',
  }

  it('catches an entry that has already been wired', () => {
    const verdict = wiringStateFor({
      entry,
      targetsCallingCore: [entry.targets[0].symbol],
      coreExists: true,
      acceptanceExists: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('stale and must be removed')
  })

  it('catches an entry naming a core that is not there', () => {
    const verdict = wiringStateFor({
      entry,
      targetsCallingCore: [],
      coreExists: false,
      acceptanceExists: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('a plan wearing the clothes of a fact')
  })

  it('catches an unblocked entry with no definition of done', () => {
    const verdict = wiringStateFor({
      entry: { ...entry, acceptance: null },
      targetsCallingCore: [],
      coreExists: true,
      acceptanceExists: null,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('no definition of done')
  })

  it('catches an acceptance test that was named but never written', () => {
    const verdict = wiringStateFor({
      entry,
      targetsCallingCore: [],
      coreExists: true,
      acceptanceExists: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('does not exist')
  })

  it('lets a blocked entry name no test, which is the honest answer', () => {
    // The argued exception. A path that cannot ask what currency the money was in
    // needs somewhere to record the answer before anything can be wired, and a
    // test written against a column — or a table — that does not exist would be
    // fiction rather than a definition of done.
    //
    // `a field` from Phase 136, `a row` from Phase 153, and nothing since Phase
    // 157 cleared the last one. Asked of a fixture rather than the live register
    // now, which is the point of having one: the rule outlives the entries it was
    // written for, and a blocked entry will arrive again.
    const blocked: Pending = {
      ...entry,
      core: 'someStagedCore',
      blockedBy: 'a row',
      acceptance: null,
      because:
        'A fixture standing in for a blocked entry, so this rule is still checked on a day when ' +
        'the register is empty. The real ones were `mayPostToBank`’s four targets: three needed a ' +
        'column and the fourth needed a table, because a pledge arrives in instalments.',
    }

    expect(
      wiringStateFor({
        entry: blocked,
        targetsCallingCore: [],
        coreExists: true,
        acceptanceExists: null,
      }).ok,
    ).toBe(true)

    // And the exception is only for a blocked entry: unblocked with no test is
    // still "wire it up" with no definition of done.
    expect(
      wiringStateFor({
        entry: { ...blocked, blockedBy: 'nothing' },
        targetsCallingCore: [],
        coreExists: true,
        acceptanceExists: null,
      }).ok,
    ).toBe(false)
  })
})

describe('the acceptance tests it points at', () => {
  it('are skipped rather than red, and say why in the file', () => {
    // A red suite nobody can fix teaches people to ignore the suite, which is
    // what ADR 0137 said about `ledger.receivables` reporting a fault with no
    // document behind it. A staged plan must not do to the tests what the
    // defect did to the nightly check.
    for (const entry of PENDING_WIRING) {
      if (entry.acceptance === null) continue

      const src = readFileSync(entry.acceptance, 'utf8')
      expect(src, entry.acceptance).toContain('describe.skip(')
      expect(src, entry.acceptance).toContain('acceptance test for the wiring pass')
    }
  })
})
