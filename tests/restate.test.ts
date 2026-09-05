import { describe, expect, it } from 'vitest'
import { mayRestate, restatement } from '@/modules/fx/restate'

/**
 * Putting a wrong-rate posting right (Phase 130).
 *
 * ADR 0127, ADR 0128 and ADR 0129 each end by saying a repair is a dated
 * correction and declining to build one. Phase 31's lesson, written down in
 * Phase 33: a follow-up repeated across consecutive ADRs is the phase.
 *
 * A restatement is a second entry, not a re-post. The original stays where it
 * is — rewriting it is the very thing Phase 129 stopped.
 */

describe('what a correcting entry would carry', () => {
  it('takes the difference between what the books hold and what they should', () => {
    const verdict = restatement({ categoryCents: [50_000], fromCents: 50_000, toCents: 55_000 })

    expect(verdict).toEqual({
      ok: true,
      restatement: {
        fromCents: 50_000,
        toCents: 55_000,
        deltaCents: 5_000,
        categoryDeltas: [5_000],
      },
    })
  })

  it('can take a figure down as well as up', () => {
    const verdict = restatement({ categoryCents: [55_000], fromCents: 55_000, toCents: 50_000 })
    expect(verdict.ok && verdict.restatement.deltaCents).toBe(-5_000)
  })

  it('scales each part and totals the parts, never the other way round', () => {
    // Phase 35's rule. 60000 and 40000 at 1.1 give 66000 and 44000, and the
    // bank line takes their sum — so the entry cannot be a cent out against
    // itself however the parts round.
    const verdict = restatement({
      categoryCents: [60_000, 40_000],
      fromCents: 100_000,
      toCents: 110_000,
    })

    expect(verdict.ok && verdict.restatement.categoryDeltas).toEqual([6_000, 4_000])
    expect(verdict.ok && verdict.restatement.deltaCents).toBe(10_000)
  })

  it('reports what the ledger will actually hold when the parts round', () => {
    // Three parts that cannot divide evenly: each rounds on its own, and the
    // figure reported is their sum rather than the ideal total, because the
    // sum is what the ledger gets.
    const verdict = restatement({
      categoryCents: [3_333, 3_333, 3_334],
      fromCents: 10_000,
      toCents: 11_000,
    })

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    const { categoryDeltas, deltaCents, toCents } = verdict.restatement
    expect(categoryDeltas.reduce((a, b) => a + b, 0)).toBe(deltaCents)
    expect(toCents).toBe(10_000 + deltaCents)
    expect(Math.abs(toCents - 11_000)).toBeLessThanOrEqual(1)
  })

  it('refuses when the books already carry that figure', () => {
    const verdict = restatement({ categoryCents: [55_000], fromCents: 55_000, toCents: 55_000 })
    expect(verdict).toEqual({
      ok: false,
      why: 'That is what the books already carry, so there is nothing to correct.',
    })
  })

  it('refuses a change too small to move a single cent', () => {
    // A rate that rounds to the same figure is not a correction, and posting a
    // zero entry would put a reason in the audit trail for nothing at all.
    const verdict = restatement({ categoryCents: [100], fromCents: 100, toCents: 100 })
    expect(verdict.ok).toBe(false)
  })

  it('refuses to restate to nothing', () => {
    const verdict = restatement({ categoryCents: [50_000], fromCents: 50_000, toCents: 0 })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.why).toMatch(/more than nothing/)
  })

  it('refuses when the parts do not add up to the whole', () => {
    // Somebody has edited one side. Scaling would silently decide which side
    // was right, and that is a decision nobody has made.
    const verdict = restatement({
      categoryCents: [60_000, 30_000],
      fromCents: 100_000,
      toCents: 110_000,
    })

    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.why).toMatch(/do not add up/)
  })
})

describe('whether a transaction may be restated at all', () => {
  it('allows one that has posted', () => {
    expect(mayRestate({ rateMillionths: 1_000_000, functionalAmountCents: -50_000 })).toEqual({
      ok: true,
    })
  })

  it('refuses one still in the inbox, and says what to do instead', () => {
    const verdict = mayRestate({ rateMillionths: null, functionalAmountCents: null })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.why).toMatch(/Categorise it/)
  })
})
