import { describe, expect, it } from 'vitest'
import { drawFrom, mayUse, splitReceipt } from '@/modules/receivables/overpayment'

/**
 * Money the customer sent that nothing was owed for (Phase 53).
 *
 * The claim under test: **a receipt larger than what is owed is recorded at
 * what the bank shows.** The application used to say *"Reduce it to
 * $7,400.00"* — asking somebody to put a figure in the books that the bank
 * statement disagrees with, leaving the reconciliation out for ever.
 */

const ask = (over: Partial<Parameters<typeof splitReceipt>[0]> = {}) =>
  splitReceipt({
    kind: 'receipt',
    amountCents: 800_000,
    appliedCents: 740_000,
    hasParty: true,
    ...over,
  })

describe('a receipt bigger than what is owed', () => {
  it('is recorded in full, with the difference held', () => {
    const verdict = ask()

    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.split).toEqual({ appliedCents: 740_000, heldCents: 60_000 })
    expect(verdict.ok && verdict.why).toContain('held as credit for this customer')
  })

  /**
   * The whole point. What goes in the books is what the bank shows, and the
   * difference becomes a liability rather than a rounding hole.
   */
  it('never reduces what was banked', () => {
    const verdict = ask({ amountCents: 800_000, appliedCents: 0 })
    expect(verdict.ok && verdict.split.appliedCents + verdict.split.heldCents).toBe(800_000)
  })

  /** A customer paying before any invoice exists is the same thing. */
  it('holds the whole of an advance against no documents at all', () => {
    const verdict = ask({ appliedCents: 0 })

    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.split.heldCents).toBe(800_000)
  })

  it('says nothing when the receipt lands exactly', () => {
    const verdict = ask({ appliedCents: 800_000 })

    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.split.heldCents).toBe(0)
    expect(verdict.ok && verdict.why).toBeNull()
  })
})

describe('what cannot be held', () => {
  /**
   * Paying a supplier more than is owed leaves *them* owing *us*, which is an
   * asset and not this account. Vendor credits already cover the ordinary case,
   * and a second answer would give a business two places to look for one sum.
   */
  it('refuses an overpayment to a supplier', () => {
    const verdict = ask({ kind: 'disbursement' })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('vendor credit')
  })

  /**
   * You cannot owe money to no one. A leftover with nobody named has nowhere
   * for the liability to attach — which is how Phase 46's stranded payments
   * happened.
   */
  it('refuses a leftover with nobody named', () => {
    const verdict = ask({ hasParty: false })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('nobody to hold the difference for')
  })

  it('refuses an amount of nothing', () => {
    expect(ask({ amountCents: 0 }).ok).toBe(false)
    expect(ask({ amountCents: -100 }).ok).toBe(false)
  })

  it('refuses settling more than the payment is for', () => {
    const verdict = ask({ amountCents: 100_000, appliedCents: 200_000 })
    expect(verdict.ok === false && verdict.why).toContain('cannot settle more than it is for')
  })
})

describe('drawing on held credit', () => {
  it('takes what fits', () => {
    expect(drawFrom({ availableCents: 60_000, dueCents: 90_000 })).toBe(60_000)
    expect(drawFrom({ availableCents: 60_000, dueCents: 40_000 })).toBe(40_000)
  })

  it('never goes negative', () => {
    expect(drawFrom({ availableCents: -5, dueCents: 90_000 })).toBe(0)
    expect(drawFrom({ availableCents: 60_000, dueCents: -5 })).toBe(0)
  })
})

describe('using held credit', () => {
  it('allows an application that fits', () => {
    expect(mayUse({ use: 'apply', amountCents: 40_000, availableCents: 60_000, dueCents: 90_000 }).ok).toBe(
      true,
    )
  })

  it('refuses more than is held', () => {
    const verdict = mayUse({
      use: 'apply',
      amountCents: 90_000,
      availableCents: 60_000,
      dueCents: 90_000,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('600.00 is held')
  })

  /** Past settled would hide the difference somewhere nobody looks. */
  it('refuses more than the document owes', () => {
    const verdict = mayUse({
      use: 'apply',
      amountCents: 60_000,
      availableCents: 60_000,
      dueCents: 40_000,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('only owes 400.00')
  })

  it('refuses applying to something already settled', () => {
    const verdict = mayUse({ use: 'apply', amountCents: 10_000, availableCents: 60_000, dueCents: 0 })
    expect(verdict.ok === false && verdict.why).toContain('nothing to put credit against')
  })

  /** A refund answers to what is held, and to nothing else. */
  it('allows a refund of what is held', () => {
    expect(mayUse({ use: 'refund', amountCents: 60_000, availableCents: 60_000 }).ok).toBe(true)
  })

  it('refuses a refund of more than is held', () => {
    expect(mayUse({ use: 'refund', amountCents: 60_001, availableCents: 60_000 }).ok).toBe(false)
  })

  it('refuses either for nothing', () => {
    expect(mayUse({ use: 'refund', amountCents: 0, availableCents: 60_000 }).ok).toBe(false)
  })
})
