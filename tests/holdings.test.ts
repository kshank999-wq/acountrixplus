import { describe, expect, it } from 'vitest'
import { comparableHoldings } from '@/modules/fx/holdings'

/**
 * The credit netted against a converted balance (Phase 65).
 *
 * The customers screen sums `invoices.functional_balance_cents` — converted —
 * and `payments.unapplied_cents` — not converted — and Phase 54 nets one
 * against the other. A €4,000 invoice with a €500 overpayment gave a balance of
 * $4,334.00 reduced by 500: neither dollars nor euro, printed with a dollar
 * sign.
 *
 * ADR 0062 named the three places that do it. Closing them needs the payment's
 * rate, which nothing kept.
 */

const HOME = 'USD'

describe('what is being held, as one comparable number', () => {
  it('is nothing when nothing is held', () => {
    const result = comparableHoldings([], HOME)

    expect(result.functionalHeldCents).toBe(0)
    expect(result.holdings).toEqual([])
    expect(result.converted).toBe(false)
    expect(result.note).toBeNull()
  })

  /** The ordinary case, and the one that must not change under this phase. */
  it('says nothing extra about money held in the company’s own currency', () => {
    const result = comparableHoldings(
      [{ currency: 'USD', unappliedCents: 50_000, functionalUnappliedCents: 50_000 }],
      HOME,
    )

    expect(result.functionalHeldCents).toBe(50_000)
    expect(result.converted).toBe(false)
    expect(result.note).toBeNull()
  })

  it('adds several receipts in the same currency together', () => {
    const result = comparableHoldings(
      [
        { currency: 'USD', unappliedCents: 30_000, functionalUnappliedCents: 30_000 },
        { currency: 'USD', unappliedCents: 20_000, functionalUnappliedCents: 20_000 },
      ],
      HOME,
    )

    expect(result.holdings).toEqual([
      { currency: 'USD', heldCents: 50_000, functionalHeldCents: 50_000 },
    ])
  })

  /**
   * The substance. €500 is not 500 of the company's money, and the figure the
   * screen sorts on has to be the converted one or it is comparing euro against
   * dollars and calling the bigger number bigger.
   */
  it('reports a foreign holding at what it was worth when received', () => {
    const result = comparableHoldings(
      [{ currency: 'EUR', unappliedCents: 50_000, functionalUnappliedCents: 54_175 }],
      HOME,
    )

    expect(result.functionalHeldCents).toBe(54_175)
    expect(result.holdings).toEqual([
      { currency: 'EUR', heldCents: 50_000, functionalHeldCents: 54_175 },
    ])
    expect(result.converted).toBe(true)
    expect(result.note).toContain('€500.00 held')
    expect(result.note).toContain('$541.75 shown')
    expect(result.note).toContain('repayable in the currency it came in')
  })

  it('keeps two currencies apart while still totalling them once converted', () => {
    const result = comparableHoldings(
      [
        { currency: 'EUR', unappliedCents: 50_000, functionalUnappliedCents: 54_175 },
        { currency: 'USD', unappliedCents: 109_000, functionalUnappliedCents: 109_000 },
      ],
      HOME,
    )

    expect(result.functionalHeldCents).toBe(163_175)
    expect(result.holdings.map((held) => held.currency)).toEqual(['EUR', 'USD'])
    expect(result.note).toContain('€500.00 and $1,090.00 held')
    expect(result.note).toContain('$1,631.75 shown')
  })

  /**
   * Each receipt is converted at its own rate, fixed when it arrived — so a
   * holding built from two receipts a month apart is the sum of two different
   * conversions, not one conversion of the sum. Re-deriving it from any single
   * rate would restate money the business has already banked.
   */
  it('sums the receipts’ own conversions rather than reconverting the total', () => {
    const result = comparableHoldings(
      [
        { currency: 'EUR', unappliedCents: 50_000, functionalUnappliedCents: 54_175 },
        // Same currency, a month later, a different rate.
        { currency: 'EUR', unappliedCents: 50_000, functionalUnappliedCents: 55_000 },
      ],
      HOME,
    )

    expect(result.holdings).toEqual([
      { currency: 'EUR', heldCents: 100_000, functionalHeldCents: 109_175 },
    ])
    // Not 100_000 converted at either rate — those would be 108,350 and 110,000.
    expect(result.functionalHeldCents).toBe(109_175)
  })

  /** `heldByCurrency`'s rule, borrowed: a currency held at zero is not a fact. */
  it('drops a receipt with nothing left over', () => {
    const result = comparableHoldings(
      [
        { currency: 'EUR', unappliedCents: 0, functionalUnappliedCents: 0 },
        { currency: 'USD', unappliedCents: 50_000, functionalUnappliedCents: 50_000 },
      ],
      HOME,
    )

    expect(result.holdings.map((held) => held.currency)).toEqual(['USD'])
    expect(result.converted).toBe(false)
  })

  /**
   * A company whose books are in euro holds euro natively. The dollar is the
   * foreign one, and the note is about the dollars.
   */
  it('treats the home currency as home whatever it is', () => {
    const result = comparableHoldings(
      [
        { currency: 'EUR', unappliedCents: 50_000, functionalUnappliedCents: 50_000 },
        { currency: 'USD', unappliedCents: 20_000, functionalUnappliedCents: 18_500 },
      ],
      'EUR',
    )

    expect(result.functionalHeldCents).toBe(68_500)
    expect(result.converted).toBe(true)
    expect(result.note).toContain('€685.00 shown')
  })
})
