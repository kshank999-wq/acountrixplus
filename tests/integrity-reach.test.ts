import { describe, expect, it } from 'vitest'
import { outOfReachNote, runnableAt, type ReachDeclaration } from '@/modules/integrity/reach'
import { INTEGRITY_CHECKS, checkByKey } from '@/modules/integrity/register'

/**
 * How far back a check can see (Phase 109).
 *
 * Every check takes an `asOf`. Most walk their ledger side back to it and read
 * their subledger side as it stands now — Phase 108 fixed that for the two
 * control accounts and did not reach the rest. Measured by running every check
 * at three dates against the development books:
 *
 * ```
 * inventory.lots   2026-09-03: agrees  2855920/2855920
 *                  2026-05-31: DIFFERS 2855920/1668600
 *                  2026-03-31: DIFFERS 2855920/0
 * ```
 *
 * The left figure never moves. `inventory.lots` is a **fault**, so asking about
 * March reported $28,559.20 of broken books on books that were correct — which
 * `reconcileInventory`'s own comment calls "a reconciliation that cries wolf".
 */

const declaration = (over: Partial<ReachDeclaration> = {}): ReachDeclaration => ({
  reach: 'today_only',
  because: 'Its subledger side is a running column with no dated history behind it.',
  ...over,
})

const check = (asAt: ReachDeclaration) => ({
  key: 'example.check',
  label: 'An example check',
  asAt,
})

describe('whether a check can answer for a date', () => {
  it('runs a check that reaches any date, whenever it is asked', () => {
    const reaching = check(declaration({ reach: 'any_date' }))

    expect(runnableAt(reaching, '2026-03-31', '2026-09-03').run).toBe(true)
    expect(runnableAt(reaching, '2026-09-03', '2026-09-03').run).toBe(true)
  })

  it('runs a today-only check when today is what was asked', () => {
    // The nightly run asks about today, so nothing about it changes.
    expect(runnableAt(check(declaration()), '2026-09-03', '2026-09-03').run).toBe(true)
  })

  it('skips a today-only check asked about the past', () => {
    const verdict = runnableAt(check(declaration()), '2026-03-31', '2026-09-03')

    expect(verdict.run).toBe(false)
  })

  it('says which check, which date, and why', () => {
    const verdict = runnableAt(check(declaration()), '2026-03-31', '2026-09-03')

    expect(verdict.run).toBe(false)
    if (verdict.run) return
    expect(verdict.because).toContain('An example check')
    expect(verdict.because).toContain('2026-03-31')
    expect(verdict.because).toContain('running column')
    // The reason a wrong answer would be worse than none.
    expect(verdict.because).toContain('books that are correct')
  })

  it('runs a today-only check asked about the future', () => {
    // A future date has the same present-tense subledger as today, so there is
    // nothing to be wrong about.
    expect(runnableAt(check(declaration()), '2026-12-31', '2026-09-03').run).toBe(true)
  })
})

describe('what the page says', () => {
  const one = ['Cash tie-out']
  const three = ['Cash tie-out', 'Payments in transit', 'Client money held']

  it('counts one and many', () => {
    expect(outOfReachNote(one, '2026-03-31')).toContain('1 check could not answer')
    expect(outOfReachNote(one, '2026-03-31')).toContain('was skipped')
    expect(outOfReachNote(three, '2026-03-31')).toContain('3 checks could not answer')
    expect(outOfReachNote(three, '2026-03-31')).toContain('were skipped')
  })

  it('names the date that put them out of reach', () => {
    expect(outOfReachNote(three, '2026-03-31')).toContain('2026-03-31')
  })

  it('separates labels that already contain a comma', () => {
    // Every real label is a clause with a comma in it. Joining seven of them
    // with commas read as a fourteen-item list, which is how the browser check
    // earned its keep.
    const real = INTEGRITY_CHECKS.filter((entry) => entry.asAt.reach === 'today_only').map(
      (entry) => entry.label,
    )
    expect(real.some((label) => label.includes(','))).toBe(true)
    expect(outOfReachNote(real, '2026-03-31')).toContain('; ')
  })

  it('names the checks themselves (Phase 110)', () => {
    // Phase 109 took a count. Eleven checks vanishing is alarming and
    // unactionable; being told which eleven is the difference between "the one
    // I came here for is missing" and "the one I came here for ran".
    for (const label of three) expect(outOfReachNote(three, '2026-03-31')).toContain(label)
    expect(outOfReachNote(one, '2026-03-31')).toContain('Cash tie-out')
  })

  it('stays quiet when every check could answer', () => {
    expect(outOfReachNote([], '2026-03-31')).toBeUndefined()
  })
})

describe('every check in the register declares its reach', () => {
  it('declares one, with prose arguing for it', () => {
    for (const entry of INTEGRITY_CHECKS) {
      expect(entry.asAt, entry.key).toBeDefined()
      expect(['any_date', 'today_only'], entry.key).toContain(entry.asAt.reach)
      expect(entry.asAt.because.length, entry.key).toBeGreaterThan(40)
    }
  })

  it('gives the two control accounts the reach Phase 108 built them', () => {
    expect(checkByKey('ledger.receivables')!.asAt.reach).toBe('any_date')
    expect(checkByKey('ledger.payables')!.asAt.reach).toBe('any_date')
  })

  it('gives inventory the reach its movements support', () => {
    // stock_movements.moved_on dates every change and cost_cents is already
    // signed, so the lot value is restorable — this is the check the phase was
    // found through, and declaring it today_only would have settled for less
    // than the data allows.
    expect(checkByKey('inventory.lots')!.asAt.reach).toBe('any_date')
    expect(checkByKey('inventory.lots')!.asAt.because).toContain('stock_movements')
  })

  it('has at least one of each, so neither branch is theoretical', () => {
    const reaches = INTEGRITY_CHECKS.map((entry) => entry.asAt.reach)
    expect(reaches).toContain('any_date')
    expect(reaches).toContain('today_only')
  })
})
