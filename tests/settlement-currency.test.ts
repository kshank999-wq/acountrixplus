import { describe, expect, it } from 'vitest'
import {
  heldByCurrency,
  netByCurrency,
  settlementCurrency,
} from '@/modules/receivables/settlement-currency'

/**
 * The money that did not know its own currency (Phase 62).
 *
 * `recordPayment` works out what currency a payment is in, uses it to fetch the
 * rate, and never stores it — a fact the code has and does not keep, like Phase
 * 55's `sent_at` and Phase 59's discarded `paid` list.
 *
 * The cost is paid five times over: five queries sum `unapplied_cents` across a
 * customer's receipts and read the result as the company's own currency, so a
 * customer who overpaid a €4,000 invoice by €500 is recorded as holding $500.
 */

describe('what currency a payment is in', () => {
  it('is the currency of the documents it settles', () => {
    const result = settlementCurrency({
      documentCurrencies: ['EUR', 'EUR'],
      homeCurrency: 'USD',
    })

    expect(result).toEqual({ ok: true, currency: 'EUR' })
  })

  /**
   * A payment on account settles nothing, so there is no document to read a
   * currency from — and the company's own is both the only answer available
   * and the right one, because a customer paying in advance pays in the
   * currency they are billed in.
   */
  it('is the company’s own when it settles nothing', () => {
    const result = settlementCurrency({ documentCurrencies: [], homeCurrency: 'GBP' })

    expect(result).toEqual({ ok: true, currency: 'GBP' })
  })

  /** One payment is one transfer, and a transfer is in one currency. */
  it('refuses two, rather than converting to one', () => {
    const result = settlementCurrency({
      documentCurrencies: ['EUR', 'USD'],
      homeCurrency: 'USD',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.currencies).toEqual(['EUR', 'USD'])
      expect(result.reason).toContain('one payment per currency')
      expect(result.reason).toContain('no single amount of money that arrived')
    }
  })

  it('does not mind the same currency listed many times', () => {
    const result = settlementCurrency({
      documentCurrencies: ['USD', 'USD', 'USD'],
      homeCurrency: 'USD',
    })

    expect(result).toEqual({ ok: true, currency: 'USD' })
  })
})

describe('what is being held, and in what', () => {
  it('keeps each currency apart', () => {
    const held = heldByCurrency([
      { currency: 'EUR', unappliedCents: 50_000 },
      { currency: 'USD', unappliedCents: 20_000 },
      { currency: 'EUR', unappliedCents: 10_000 },
    ])

    expect(held).toEqual([
      { currency: 'EUR', heldCents: 60_000 },
      { currency: 'USD', heldCents: 20_000 },
    ])
  })

  /** "€0.00 held" invites the question of what happened to it. */
  it('drops a currency nothing is held in', () => {
    const held = heldByCurrency([
      { currency: 'EUR', unappliedCents: 0 },
      { currency: 'USD', unappliedCents: 20_000 },
    ])

    expect(held).toEqual([{ currency: 'USD', heldCents: 20_000 }])
  })

  it('holds nothing when there is nothing', () => {
    expect(heldByCurrency([])).toEqual([])
  })
})

describe('netting each currency against its own balance', () => {
  /**
   * The whole point of the phase. ADR 0061 could only net against the
   * home-currency balance, because a credit's currency was unknowable — so a
   * customer who overpaid a euro invoice was told the euro balance stood in
   * full and a dollar credit was held separately.
   */
  it('sets a euro credit against a euro balance', () => {
    const positions = netByCurrency(
      [{ currency: 'EUR', balanceCents: 400_000 }],
      [{ currency: 'EUR', heldCents: 50_000 }],
    )

    expect(positions).toHaveLength(1)
    expect(positions[0].currency).toBe('EUR')
    expect(positions[0].dueCents).toBe(350_000)
  })

  it('does not set a dollar credit against a euro balance', () => {
    const positions = netByCurrency(
      [{ currency: 'EUR', balanceCents: 400_000 }],
      [{ currency: 'USD', heldCents: 50_000 }],
    )

    const euro = positions.find((row) => row.currency === 'EUR')!
    const dollars = positions.find((row) => row.currency === 'USD')!

    expect(euro.dueCents).toBe(400_000)
    // And the dollars we hold are still money we owe back.
    expect(dollars.dueCents).toBe(0)
    expect(dollars.ourDebtCents).toBe(50_000)
  })

  /**
   * Phase 53 built the column for exactly this: money held for somebody who
   * owes nothing. Dropping the currency would hide money the business owes.
   */
  it('keeps a currency the business only holds in', () => {
    const positions = netByCurrency([], [{ currency: 'EUR', heldCents: 50_000 }])

    expect(positions.map((row) => row.currency)).toEqual(['EUR'])
    expect(positions[0].ourDebtCents).toBe(50_000)
  })

  it('keeps a currency the customer only owes in', () => {
    const positions = netByCurrency([{ currency: 'GBP', balanceCents: 90_000 }], [])

    expect(positions[0].dueCents).toBe(90_000)
    expect(positions[0].heldCents).toBe(0)
  })

  /** The single-currency answer must be exactly what Phase 54 always gave. */
  it('is unchanged for an ordinary customer', () => {
    const positions = netByCurrency(
      [{ currency: 'USD', balanceCents: 200_000 }],
      [{ currency: 'USD', heldCents: 46_000 }],
    )

    expect(positions).toHaveLength(1)
    expect(positions[0].dueCents).toBe(154_000)
    expect(positions[0].ourDebtCents).toBe(0)
    expect(positions[0].stance).toBe('owes_us')
  })

  it('has nothing to say about a customer with neither', () => {
    expect(netByCurrency([], [])).toEqual([])
  })
})
