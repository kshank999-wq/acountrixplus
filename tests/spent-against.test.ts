import { describe, expect, it } from 'vitest'
import { spends } from '@/modules/fx/spent-against'

/**
 * Money held in one currency, spent against a document in another (Phase 138).
 *
 * No database, no clock. `applyDeposit` used one number as both a euro face
 * amount and a dollar holding — so the check that decides whether somebody
 * else's money may be spent compared two currencies, and the entry put the euro
 * figure into a functional ledger.
 *
 * €400 of an invoice raised at 1.10 is worth $440.
 */

const HOME = 'USD'
const FACE = 40_000
const WORTH = 44_000

describe('a deposit spent against a foreign invoice', () => {
  it('costs what the invoice is carried at, not its face amount', () => {
    const verdict = spends({
      heldCents: 50_000,
      faceCents: FACE,
      functionalCents: WORTH,
      documentCurrency: 'EUR',
      homeCurrency: HOME,
    })

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return

    // $440, which is what `relieveFunctional` already took off the invoice's
    // own functional column. Posting `faceCents` here is what left the control
    // account disagreeing with the subledger.
    expect(verdict.costsCents).toBe(WORTH)
    expect(verdict.converted).toBe(true)
  })

  it('refuses when the holding covers the face amount but not its worth', () => {
    // **The case the old check got wrong.** $420 held, €400 applied: 40000 is
    // not greater than 42000, so the old comparison let it through — and then
    // spent $440 of a $420 deposit. Two currencies in one comparison (Phase
    // 122), deciding whether a tenant's money may be spent.
    const verdict = spends({
      heldCents: 42_000,
      faceCents: FACE,
      functionalCents: WORTH,
      documentCurrency: 'EUR',
      homeCurrency: HOME,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return

    // Phase 119's standard: both figures, each in its own currency, so somebody
    // can see why without reading the code.
    expect(verdict.why).toContain('€400.00')
    expect(verdict.why).toContain('$440.00')
    expect(verdict.why).toContain('$420.00')
    expect(verdict.why).toContain('the rate it was raised at')
  })

  it('allows exactly enough', () => {
    const verdict = spends({
      heldCents: WORTH,
      faceCents: FACE,
      functionalCents: WORTH,
      documentCurrency: 'EUR',
      homeCurrency: HOME,
    })

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.costsCents).toBe(WORTH)
  })
})

describe('a deposit spent against a domestic invoice', () => {
  it('costs the face amount, because the two are the same number', () => {
    // Why a hundred and thirty phases never saw this: with one currency
    // `faceCents` and `functionalCents` are equal, so using either is right.
    const verdict = spends({
      heldCents: 50_000,
      faceCents: FACE,
      functionalCents: FACE,
      documentCurrency: HOME,
      homeCurrency: HOME,
    })

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return

    expect(verdict.costsCents).toBe(FACE)
    expect(verdict.converted).toBe(false)
  })

  it('keeps the sentence it had when nothing was converted', () => {
    const verdict = spends({
      heldCents: 30_000,
      faceCents: FACE,
      functionalCents: FACE,
      documentCurrency: HOME,
      homeCurrency: HOME,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return

    // No talk of rates on a domestic tenancy: it would be noise, and Phase 119
    // is about a sentence a person can act on.
    expect(verdict.why).toContain('Only $300.00 is held on this tenancy')
    expect(verdict.why).not.toContain('rate')
  })
})

describe('what it refuses outright', () => {
  it('refuses nothing, and less than nothing', () => {
    for (const faceCents of [0, -1]) {
      const verdict = spends({
        heldCents: 50_000,
        faceCents,
        functionalCents: faceCents,
        documentCurrency: HOME,
        homeCurrency: HOME,
      })

      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.why).toContain('more than nothing')
    }
  })

  it('refuses against an empty tenancy whatever the currency', () => {
    for (const currency of ['USD', 'EUR', 'GBP']) {
      expect(
        spends({
          heldCents: 0,
          faceCents: FACE,
          functionalCents: WORTH,
          documentCurrency: currency,
          homeCurrency: HOME,
        }).ok,
      ).toBe(false)
    }
  })
})

describe('the comparison that is the point of the phase', () => {
  it('never compares a face amount to a holding', () => {
    // The property, stated as a property. Whatever the face amount is — and it
    // can be any number at all, since it is in a currency the holding is not —
    // the decision turns only on what it is *worth*.
    for (const faceCents of [1, 40_000, 999_999]) {
      const enough = spends({
        heldCents: 44_000,
        faceCents,
        functionalCents: 44_000,
        documentCurrency: 'JPY',
        homeCurrency: HOME,
      })
      expect(enough.ok, `face ${faceCents} worth 44000 against 44000 held`).toBe(true)

      const short = spends({
        heldCents: 43_999,
        faceCents,
        functionalCents: 44_000,
        documentCurrency: 'JPY',
        homeCurrency: HOME,
      })
      expect(short.ok, `face ${faceCents} worth 44000 against 43999 held`).toBe(false)
    }
  })

  it('costs exactly what the document gave up, never a recomputation', () => {
    // Phase 116's rule: read the pair that moved rather than converting again.
    // `costsCents` is `functionalCents` and nothing else, so there is no second
    // rate anywhere in this decision.
    for (const functionalCents of [1, 44_000, 123_457]) {
      const verdict = spends({
        heldCents: 1_000_000,
        faceCents: 40_000,
        functionalCents,
        documentCurrency: 'EUR',
        homeCurrency: HOME,
      })
      if (!verdict.ok) throw new Error('expected enough held')
      expect(verdict.costsCents).toBe(functionalCents)
    }
  })
})
