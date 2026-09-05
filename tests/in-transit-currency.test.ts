import { describe, expect, it } from 'vitest'
import { PARITY, carriedFor, payoutSettlement } from '@/modules/payments/in-transit'
import { RateError } from '@/modules/fx/rates'

/**
 * The account where three currencies met (Phase 134).
 *
 * No database, no clock. The arithmetic that says why `1250 Payments in
 * Transit` could not reach zero on a foreign checkout, and what each of the
 * three postings has to be for it to.
 */

/** A €100 charge with a €5 fee, captured at 1.10. */
function euroCheckout() {
  return carriedFor({
    grossCents: 10_000,
    feeCents: 500,
    currency: 'EUR',
    captureRateMillionths: 1_100_000,
  })
}

describe('what one capture puts into the clearing account', () => {
  it('converts the gross and the fee at the one rate they share', () => {
    // Both entries are posted at the same moment against the same charge, so
    // they get one rate rather than each asking separately.
    const carried = euroCheckout()

    expect(carried.carriedGrossCents).toBe(11_000)
    expect(carried.carriedFeeCents).toBe(550)
  })

  it('leaves a domestic checkout exactly as it was', () => {
    // Why a hundred and thirty phases of card payments are untouched: at parity
    // the conversion is the identity, so every existing company gets the same
    // figures it already had.
    const carried = carriedFor({
      grossCents: 10_000,
      feeCents: 290,
      currency: 'USD',
      captureRateMillionths: PARITY,
    })

    expect(carried.carriedGrossCents).toBe(10_000)
    expect(carried.carriedFeeCents).toBe(290)
  })
})

describe('what a payout does to the three accounts', () => {
  it('states the defect as a number', () => {
    // The whole phase in one assertion. Before this, the clearing account was
    // charged $110.00 (converted) and relieved of $5.00 + $95.00 (face), and
    // kept $10.00 that was not a balance, a fee or a gain.
    const carried = euroCheckout()
    const chargedToClearing = carried.carriedGrossCents
    const relievedTheOldWay = 500 + 9_500 // the face fee and the face payout

    expect(chargedToClearing - relievedTheOldWay).toBe(1_000)

    // And with all three in the same money, at an unchanged rate, it is zero.
    const outcome = payoutSettlement({
      faceCents: 9_500,
      currency: 'EUR',
      items: [carried],
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(carried.carriedGrossCents - carried.carriedFeeCents - outcome.settlement.bankCents).toBe(
      0,
    )
  })

  it('gives the bank the arrival rate and the clearing account the capture rate', () => {
    // Captured at 1.10, settled three days later at 1.12. Both rates are real
    // and each belongs on exactly one line.
    const outcome = payoutSettlement({
      faceCents: 9_500,
      currency: 'EUR',
      items: [euroCheckout()],
      arrivalRateMillionths: 1_120_000,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.settlement.bankCents).toBe(10_640) // €95 at 1.12
    expect(outcome.settlement.clearedCents).toBe(10_450) // $110.00 − $5.50
    expect(outcome.settlement.gainCents).toBe(190)
  })

  it('sums the parts rather than converting the sum', () => {
    // Phase 35's rule, and here it is not a nicety. Three charges whose
    // converted parts do not equal the conversion of their total: relieving the
    // account by the second figure would leave it a cent adrift on a batch that
    // is perfectly correct, which reads exactly like a real discrepancy.
    const items = [
      carriedFor({ grossCents: 333, feeCents: 0, currency: 'EUR', captureRateMillionths: 1_100_000 }),
      carriedFor({ grossCents: 333, feeCents: 0, currency: 'EUR', captureRateMillionths: 1_100_000 }),
      carriedFor({ grossCents: 333, feeCents: 0, currency: 'EUR', captureRateMillionths: 1_100_000 }),
    ]

    const summedParts = items.reduce((sum, item) => sum + item.carriedGrossCents, 0)

    const outcome = payoutSettlement({
      faceCents: 999,
      currency: 'EUR',
      items,
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // 366 × 3 = 1098, while 999 at 1.10 converts to 1099. The account is
    // relieved of the 1098 it was actually charged.
    expect(summedParts).toBe(1_098)
    expect(outcome.settlement.clearedCents).toBe(1_098)
    expect(outcome.settlement.bankCents).toBe(1_099)
    expect(outcome.settlement.gainCents).toBe(1)
  })

  it('compares the processor’s figure with the payments in the same currency', () => {
    // `payoutReconciliation` compared a face figure against a sum that could be
    // in another currency. Both sides here are face and both are this payout's.
    const outcome = payoutSettlement({
      faceCents: 9_400,
      currency: 'EUR',
      items: [euroCheckout()],
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.settlement.expectedCents).toBe(9_500)
    expect(outcome.settlement.differenceCents).toBe(-100)
    expect(outcome.settlement.balances).toBe(false)
  })

  it('leaves a domestic payout at exactly the figures it always had', () => {
    const carried = carriedFor({
      grossCents: 100_000,
      feeCents: 2_900,
      currency: 'USD',
      captureRateMillionths: PARITY,
    })

    const outcome = payoutSettlement({
      faceCents: 97_100,
      currency: 'USD',
      items: [carried],
      arrivalRateMillionths: PARITY,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.settlement.bankCents).toBe(97_100)
    expect(outcome.settlement.clearedCents).toBe(97_100)
    expect(outcome.settlement.gainCents).toBe(0)
    expect(outcome.settlement.balances).toBe(true)
  })

  it('reads a currency the same however it is cased', () => {
    const outcome = payoutSettlement({
      faceCents: 9_500,
      currency: 'eur',
      items: [euroCheckout()],
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.settlement.currency).toBe('EUR')
  })
})

describe('a payout that cannot be settled', () => {
  it('refuses a batch holding two currencies, and says it is the matching', () => {
    // Not a rate problem. A processor settles one currency per batch, so this
    // is the wrong payments against the wrong payout — and saying "no rate" for
    // it would send somebody to the rate table to fix something else.
    const outcome = payoutSettlement({
      faceCents: 9_500,
      currency: 'EUR',
      items: [
        euroCheckout(),
        carriedFor({
          grossCents: 5_000,
          feeCents: 100,
          currency: 'GBP',
          captureRateMillionths: 1_270_000,
        }),
      ],
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return

    expect(outcome.why).toContain('EUR')
    expect(outcome.why).toContain('GBP')
    expect(outcome.why).toContain('1 of the 2')
    expect(outcome.why).toMatch(/matched to the wrong payout/)
  })

  it('names both of the other currencies when there are two', () => {
    const outcome = payoutSettlement({
      faceCents: 9_500,
      currency: 'EUR',
      items: [
        carriedFor({ grossCents: 100, feeCents: 0, currency: 'GBP', captureRateMillionths: PARITY }),
        carriedFor({ grossCents: 100, feeCents: 0, currency: 'CHF', captureRateMillionths: PARITY }),
      ],
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return

    // Sorted, so the sentence is the same however the rows came back.
    expect(outcome.why).toContain('CHF and GBP')
    expect(outcome.why).toContain('2 of the 2')
  })

  it('refuses a rate that is not a rate rather than posting nothing', () => {
    // `convert` throws on a zero or negative rate (Phase 35). Inherited rather
    // than re-checked: a payout posted at a rate of nothing is a bank movement
    // recorded as never having happened.
    expect(() =>
      payoutSettlement({
        faceCents: 9_500,
        currency: 'EUR',
        items: [euroCheckout()],
        arrivalRateMillionths: 0,
      }),
    ).toThrow(RateError)
  })

  it('settles a payout with nothing matched to it as the whole of a gain', () => {
    // A payout we cannot tie to any checkout still moved money into the bank.
    // The clearing account gives up nothing because nothing was put in for it,
    // and the entire figure shows as a difference rather than being silently
    // absorbed.
    const outcome = payoutSettlement({
      faceCents: 9_500,
      currency: 'EUR',
      items: [],
      arrivalRateMillionths: 1_100_000,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.settlement.clearedCents).toBe(0)
    expect(outcome.settlement.expectedCents).toBe(0)
    expect(outcome.settlement.differenceCents).toBe(9_500)
    expect(outcome.settlement.balances).toBe(false)
  })
})
