import { describe, expect, it } from 'vitest'
import {
  describeReversal,
  refundVoidability,
  reversalOf,
  type VoidableRefund,
} from '@/modules/receivables/refund-void'
import { convert } from '@/modules/fx/rates'

/**
 * Taking a refund back (Phase 69).
 *
 * ADR 0068 named the gap: Phase 52 taught payments to unwind, and none of the
 * three refunds could. The decision this phase makes is a refusal to look
 * anything up — a reversal is not a new economic event, so it puts back the
 * three amounts the row already carries rather than re-deriving them.
 */

const RAISED = 1_083_500
const RETURNED = 1_100_000

/** A euro vendor credit recovered: money came in, and it realised a gain. */
function recovery(over: Partial<VoidableRefund> = {}): VoidableRefund {
  return {
    id: 'r1',
    subjectType: 'credit_note',
    subjectId: 'n1',
    direction: 'in',
    refundedOn: '2026-06-15',
    amountCents: 50_000,
    currency: 'EUR',
    carriedCents: convert(50_000, RAISED),
    cashCents: convert(50_000, RETURNED),
    realisedCents: convert(50_000, RETURNED) - convert(50_000, RAISED),
    voidedAt: null,
    reference: null,
    ...over,
  }
}

/** A euro retainer given back: money went out, and it realised a loss. */
function refund(over: Partial<VoidableRefund> = {}): VoidableRefund {
  return {
    ...recovery(),
    subjectType: 'retainer',
    direction: 'out',
    realisedCents: convert(50_000, RAISED) - convert(50_000, RETURNED),
    ...over,
  }
}

const open = { subjectVoided: false, subjectLabel: 'VC-1004' }
const noPeriods: never[] = []

describe('whether a refund may be taken back', () => {
  it('allows one that is open, on a subject that still exists', () => {
    expect(
      refundVoidability({
        refund: recovery(),
        ties: open,
        closedPeriods: noPeriods,
        today: '2026-08-29',
      }).ok,
    ).toBe(true)
  })

  it('refuses one already taken back', () => {
    const verdict = refundVoidability({
      refund: recovery({ voidedAt: '2026-07-01' }),
      ties: open,
      closedPeriods: noPeriods,
      today: '2026-08-29',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('already been taken back')
  })

  /** Phase 52's shape: the refusal names the record that would be left lying. */
  it('refuses when the balance it came from has since been voided', () => {
    const verdict = refundVoidability({
      refund: recovery(),
      ties: { subjectVoided: true, subjectLabel: 'VC-1004' },
      closedPeriods: noPeriods,
      today: '2026-08-29',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('VC-1004')
    expect(verdict.ok === false && verdict.why).toContain('cancelled record')
  })

  it('refuses to reach back into a closed period, and says which date', () => {
    const verdict = refundVoidability({
      refund: recovery(),
      ties: open,
      closedPeriods: [{ periodStart: '2026-01-01', periodEnd: '2026-06-30' }],
      today: '2026-08-29',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('2026-06-15')
    expect(verdict.ok === false && verdict.why).toContain('closed period')
  })

  it('allows one dated after the closed period ends', () => {
    expect(
      refundVoidability({
        refund: recovery({ refundedOn: '2026-07-01' }),
        ties: open,
        closedPeriods: [{ periodStart: '2026-01-01', periodEnd: '2026-06-30' }],
        today: '2026-08-29',
      }).ok,
    ).toBe(true)
  })
})

describe('what putting it back moves', () => {
  /**
   * The substance. Every figure comes off the row — there is no rate argument
   * to pass, which is the decision rather than an omission.
   */
  it('puts back exactly what the refund took, to the cent', () => {
    const row = recovery()
    const back = reversalOf(row)

    expect(back.balanceCents).toBe(row.amountCents)
    expect(back.carriedCents).toBe(row.carriedCents)
    expect(back.cashCents).toBe(row.cashCents)
  })

  it('unwinds the realised gain rather than recomputing one', () => {
    const row = recovery()
    expect(row.realisedCents).toBe(825)
    expect(reversalOf(row).realisedCents).toBe(-825)
  })

  it('unwinds a loss the same way', () => {
    const row = refund()
    expect(row.realisedCents).toBe(-825)
    expect(reversalOf(row).realisedCents).toBe(825)
  })

  it('turns money that went out into money coming back, and the reverse', () => {
    expect(reversalOf(refund()).direction).toBe('in')
    expect(reversalOf(recovery()).direction).toBe('out')
  })

  /** Phase 68's invariant still holds on the way back. */
  it('keeps the three amounts adding up, mirrored', () => {
    const row = recovery()
    const back = reversalOf(row)

    // Coming in, cash covered the balance plus the gap; going back out, the
    // same three figures balance the other way round.
    expect(row.cashCents).toBe(row.carriedCents + row.realisedCents)
    expect(back.cashCents).toBe(back.carriedCents - back.realisedCents)
  })

  it('realises nothing to unwind on a domestic refund', () => {
    expect(reversalOf(recovery({ currency: 'USD', realisedCents: 0 })).realisedCents).toBe(0)
  })

  /** Reversing twice is the original — the arithmetic has no drift in it. */
  it('is its own inverse', () => {
    const row = recovery()
    const once = reversalOf(row)
    const twice = reversalOf({ ...row, ...once, amountCents: once.balanceCents })

    expect(twice.balanceCents).toBe(row.amountCents)
    expect(twice.realisedCents).toBe(row.realisedCents)
    expect(twice.direction).toBe(row.direction)
  })
})

describe('what it tells the person who did it', () => {
  it('says money is available again when a recovery is undone', () => {
    expect(describeReversal(recovery())).toContain('€500.00 is available again')
  })

  it('says money is owed again when a refund is undone', () => {
    expect(describeReversal(refund())).toContain('€500.00 is owed again')
  })

  /** The party's money for what they get, ours for the exchange movement. */
  it('names the unwound gain in the company’s own currency', () => {
    const said = describeReversal(recovery())
    expect(said).toContain('$8.25 exchange gain')
    expect(said).toContain('unwound')
  })

  it('says nothing about exchange on a domestic one', () => {
    const said = describeReversal(recovery({ currency: 'USD', realisedCents: 0 }))
    expect(said).not.toContain('exchange')
  })
})
