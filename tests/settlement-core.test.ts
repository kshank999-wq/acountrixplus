import { describe, expect, it } from 'vitest'
import { settleHeld } from '@/modules/fx/settlement'
import { convert } from '@/modules/fx/rates'
import { relieveFunctional } from '@/modules/fx/documents'

/**
 * The retainer you could not draw (Phase 66).
 *
 * `refuseForeign` stopped four operations from Phase 35. Phase 63 lifted three
 * and kept this one deliberately, because a retainer draw is a *settlement* —
 * it decides at what rate money already held discharges a new demand, which has
 * a profit-and-loss effect. ADR 0065 left it standing for the same reason.
 *
 * The decision, made here: it is the receipt's rule. `recordPayment` has taken
 * it since Phase 35 as `appliedFunctionalCents - carriedCents`.
 */

/** 1.0835 when the money arrived; 1.10 when it was drawn. */
const ARRIVED = 1_083_500
const LATER = 1_100_000

describe('held money settling a document', () => {
  it('releases the liability at the rate the money came in at', () => {
    const settlement = settleHeld({
      amountCents: 400_000,
      heldRateMillionths: ARRIVED,
      relievedCents: convert(400_000, LATER),
    })

    expect(settlement.releasedCents).toBe(convert(400_000, ARRIVED))
  })

  it('relieves the control account by what the document was carried at', () => {
    const relievedCents = convert(400_000, LATER)

    const settlement = settleHeld({
      amountCents: 400_000,
      heldRateMillionths: ARRIVED,
      relievedCents,
    })

    expect(settlement.relievedCents).toBe(relievedCents)
  })

  /**
   * The substance, and the reason the refusal was kept twice: this is a real
   * profit-and-loss event, not a rounding artefact. The client's €4,000 was
   * worth $4,334.00 when it arrived and the invoice it settles was raised at
   * $4,400.00, so the business is $66.00 worse off on the movement.
   */
  it('realises the difference when the rate has moved', () => {
    const settlement = settleHeld({
      amountCents: 400_000,
      heldRateMillionths: ARRIVED,
      relievedCents: convert(400_000, LATER),
    })

    expect(settlement.releasedCents).toBe(433_400)
    expect(settlement.relievedCents).toBe(440_000)
    expect(settlement.realisedCents).toBe(-6_600)
  })

  it('realises a gain when the rate moved the other way', () => {
    const settlement = settleHeld({
      amountCents: 400_000,
      heldRateMillionths: LATER,
      relievedCents: convert(400_000, ARRIVED),
    })

    expect(settlement.realisedCents).toBe(6_600)
  })

  /**
   * The identity that makes the journal entry balance. Debit the liability by
   * `released`, credit the control account by `relieved`, and the exchange
   * account takes the rest — so the three always sum to nothing.
   */
  it('always balances: released is relieved plus realised', () => {
    for (const [amount, held, carried] of [
      [400_000, ARRIVED, LATER],
      [33_333, LATER, ARRIVED],
      [1, ARRIVED, LATER],
      [999_999, 1_000_000, 1_000_000],
    ] as const) {
      const settlement = settleHeld({
        amountCents: amount,
        heldRateMillionths: held,
        relievedCents: convert(amount, carried),
      })

      expect(settlement.releasedCents).toBe(
        settlement.relievedCents + settlement.realisedCents,
      )
    }
  })

  /** A domestic draw is not a conversion, and realises nothing. */
  it('realises nothing when both sides are the company’s own money', () => {
    const settlement = settleHeld({
      amountCents: 400_000,
      heldRateMillionths: 1_000_000,
      relievedCents: 400_000,
    })

    expect(settlement.releasedCents).toBe(400_000)
    expect(settlement.realisedCents).toBe(0)
  })

  it('realises nothing when the rate has not moved', () => {
    const settlement = settleHeld({
      amountCents: 400_000,
      heldRateMillionths: ARRIVED,
      relievedCents: convert(400_000, ARRIVED),
    })

    expect(settlement.realisedCents).toBe(0)
  })

  /**
   * The last draw takes whatever functional balance the document has left —
   * `relieveFunctional`'s rule, which this composes rather than re-deriving.
   * A settlement that recomputed it would strand a cent on the invoice.
   */
  it('takes the document’s remainder on the settling draw', () => {
    const invoice = {
      balanceCents: 33_333,
      exchangeRateMillionths: ARRIVED,
      // A cent away from convert(33_333, ARRIVED), as rounding leaves it.
      functionalBalanceCents: convert(33_333, ARRIVED) + 1,
    }

    const relief = relieveFunctional(invoice, 33_333)
    const settlement = settleHeld({
      amountCents: 33_333,
      heldRateMillionths: ARRIVED,
      relievedCents: relief.functionalCents,
    })

    // The invoice is left at exactly zero on both columns...
    expect(relief.functionalBalanceCents).toBe(0)
    // ...and the stray cent lands in the exchange difference, where it is a
    // named profit-and-loss figure rather than a silent discrepancy.
    expect(settlement.relievedCents).toBe(invoice.functionalBalanceCents)
    expect(settlement.releasedCents).toBe(
      settlement.relievedCents + settlement.realisedCents,
    )
  })
})
