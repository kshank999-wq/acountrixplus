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
  it('finds entries, so an empty register cannot pass as a finished one', () => {
    // Measured, not bounded (Phase 126). Four entries covering seven targets:
    // the deposit application, the write-off recovery, the four paths that
    // refuse a foreign bank account because nothing records their currency, and
    // — added by Phase 141 — the donation that reads around the gate those four
    // go through.
    expect(PENDING_WIRING.length).toBe(4)
    expect(PENDING_WIRING.flatMap((entry) => entry.targets).length).toBe(7)
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
    for (const entry of PENDING_WIRING) {
      expect(entry.liveDefect, entry.core).toMatch(/\b(?:compares|posts|refuse|reports|puts)\b/)
    }
  })
})

describe('what the register refuses', () => {
  const entry = PENDING_WIRING[0]

  it('catches an entry that has already been wired', () => {
    const verdict = wiringStateFor({
      entry,
      targetsCallingCore: ['applyDeposit'],
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
    // The argued exception. The four paths that refuse a foreign bank account
    // need a column and a screen before anything can be wired, and a test
    // written against a column that does not exist would be fiction.
    const blocked = PENDING_WIRING.find((row) => row.blockedBy === 'a field')
    expect(blocked?.acceptance).toBe(null)

    expect(
      wiringStateFor({
        entry: blocked as Pending,
        targetsCallingCore: [],
        coreExists: true,
        acceptanceExists: null,
      }).ok,
    ).toBe(true)
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
