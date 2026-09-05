import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEE_SCHEDULE,
  describeSchedule,
  feeFor,
  payableAmount,
} from '@/modules/payments/settlement'

/**
 * What a card payment is worth, and when (Phase 44).
 *
 * The claim under test: **the three numbers always add up**. A fee and a net
 * that do not sum to the gross leave a penny in the clearing account that
 * nothing will ever move, and an account that cannot reach zero is an account
 * nobody can reconcile.
 */

describe('feeFor', () => {
  it('takes the percentage and the fixed amount', () => {
    // The familiar 2.9% + 30¢ on a $1,000 invoice.
    expect(feeFor(100_000, DEFAULT_FEE_SCHEDULE)).toEqual({
      grossCents: 100_000,
      feeCents: 2_930,
      netCents: 97_070,
    })
  })

  /**
   * The assertion the module exists for. Derived by subtraction rather than
   * computed, so no rounding rule anywhere can strand a penny.
   */
  it('always adds back up, at every amount', () => {
    for (let gross = 0; gross <= 5_000; gross += 7) {
      const settlement = feeFor(gross, DEFAULT_FEE_SCHEDULE)
      expect(settlement.feeCents + settlement.netCents).toBe(settlement.grossCents)
    }
  })

  it('rounds the percentage half-up and says so by example', () => {
    // 2.9% of $10.05 is 29.145¢.
    expect(feeFor(1_005, { percentBp: 290, fixedCents: 0 }).feeCents).toBe(29)
    // 2.9% of $10.10 is 29.29¢.
    expect(feeFor(1_010, { percentBp: 290, fixedCents: 0 }).feeCents).toBe(29)
    // 2.9% of $10.20 is 29.58¢, which rounds up.
    expect(feeFor(1_020, { percentBp: 290, fixedCents: 0 }).feeCents).toBe(30)
  })

  /**
   * A processor declines a payment it would pay to accept; it does not send
   * the business a bill. So the fee stops at the gross and the net stops at
   * zero, rather than going negative and crediting the clearing account with
   * money nobody has.
   */
  it('never charges more than the payment', () => {
    const tiny = feeFor(10, DEFAULT_FEE_SCHEDULE)
    expect(tiny.feeCents).toBe(10)
    expect(tiny.netCents).toBe(0)
  })

  it('costs nothing on nothing', () => {
    expect(feeFor(0, DEFAULT_FEE_SCHEDULE)).toEqual({
      grossCents: 0,
      feeCents: 0,
      netCents: 0,
    })
  })

  it('refuses to be handed a negative payment', () => {
    expect(feeFor(-500, DEFAULT_FEE_SCHEDULE)).toEqual({
      grossCents: 0,
      feeCents: 0,
      netCents: 0,
    })
  })

  it('handles a schedule with no fixed fee, and one with no percentage', () => {
    expect(feeFor(100_000, { percentBp: 100, fixedCents: 0 }).feeCents).toBe(1_000)
    expect(feeFor(100_000, { percentBp: 0, fixedCents: 50 }).feeCents).toBe(50)
    expect(feeFor(100_000, { percentBp: 0, fixedCents: 0 })).toEqual({
      grossCents: 100_000,
      feeCents: 0,
      netCents: 100_000,
    })
  })
})

describe('describeSchedule', () => {
  it('reads the way a processor’s statement does', () => {
    expect(describeSchedule(DEFAULT_FEE_SCHEDULE)).toBe('2.9% + 0.30 per payment')
    expect(describeSchedule({ percentBp: 250, fixedCents: 25 })).toBe('2.5% + 0.25 per payment')
    expect(describeSchedule({ percentBp: 175, fixedCents: 20 })).toBe('1.75% + 0.20 per payment')
    expect(describeSchedule({ percentBp: 300, fixedCents: 0 })).toBe('3% + 0.00 per payment')
  })
})


describe('payableAmount', () => {
  it('offers the whole balance by default', () => {
    expect(payableAmount({ balanceCents: 120_000 })).toEqual({ ok: true, amountCents: 120_000 })
  })

  it('allows a part payment', () => {
    expect(payableAmount({ balanceCents: 120_000, requestedCents: 40_000 })).toEqual({
      ok: true,
      amountCents: 40_000,
    })
  })

  /**
   * The customer is looking at a page that may be minutes stale. Somebody may
   * have posted a cheque against this invoice while the link sat open.
   */
  it('refuses to take more than is outstanding', () => {
    const result = payableAmount({ balanceCents: 10_000, requestedCents: 20_000 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('more than the amount outstanding')
  })

  it('refuses an invoice that has already been settled', () => {
    const result = payableAmount({ balanceCents: 0 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('settled')
  })

  it('refuses nothing, and refuses a negative', () => {
    expect(payableAmount({ balanceCents: 120_000, requestedCents: 0 }).ok).toBe(false)
    expect(payableAmount({ balanceCents: 120_000, requestedCents: -500 }).ok).toBe(false)
  })

  /**
   * The gross settles the debt. Charging the fee back to the customer's
   * balance would leave every card-paid invoice showing 29 dollars owing for
   * ever, and the customer paid what they were asked for.
   */
  it('settles the debt with the gross, so a paid invoice is paid', () => {
    const { ok, amountCents } = payableAmount({ balanceCents: 100_000 }) as {
      ok: true
      amountCents: number
    }
    expect(ok).toBe(true)
    expect(amountCents).toBe(100_000)
    expect(feeFor(amountCents, DEFAULT_FEE_SCHEDULE).netCents).toBe(97_070)
  })
})
