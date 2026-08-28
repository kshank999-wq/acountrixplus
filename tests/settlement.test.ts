import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEE_SCHEDULE,
  describeSchedule,
  feeFor,
  payableAmount,
  payoutReconciliation,
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

describe('payoutReconciliation', () => {
  const items = [
    { paymentId: 'a', grossCents: 100_000, feeCents: 2_930 },
    { paymentId: 'b', grossCents: 50_000, feeCents: 1_480 },
    { paymentId: 'c', grossCents: 25_000, feeCents: 755 },
  ]

  it('agrees when the batch is what its payments come to', () => {
    const check = payoutReconciliation({ reportedCents: 169_835, items })

    expect(check.grossCents).toBe(175_000)
    expect(check.feeCents).toBe(5_165)
    expect(check.expectedCents).toBe(169_835)
    expect(check.differenceCents).toBe(0)
    expect(check.balances).toBe(true)
    expect(check.count).toBe(3)
  })

  /**
   * The payout is the one figure in this flow that arrives from outside and
   * posts to a bank account. A disagreement means a refund netted off, a fee
   * schedule that is not what the company believes, or a double-counted
   * payment — all worth a person's attention before it posts.
   */
  it('reports the difference rather than absorbing it', () => {
    // A $200 refund netted off the batch.
    const check = payoutReconciliation({ reportedCents: 149_835, items })

    expect(check.balances).toBe(false)
    expect(check.differenceCents).toBe(-20_000)
    expect(check.expectedCents).toBe(169_835)
  })

  it('signs the difference so somebody can tell which way it went', () => {
    expect(payoutReconciliation({ reportedCents: 170_000, items }).differenceCents).toBe(165)
    expect(payoutReconciliation({ reportedCents: 169_000, items }).differenceCents).toBe(-835)
  })

  it('copes with an empty batch', () => {
    const check = payoutReconciliation({ reportedCents: 0, items: [] })
    expect(check.balances).toBe(true)
    expect(check.expectedCents).toBe(0)
    expect(check.count).toBe(0)
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
