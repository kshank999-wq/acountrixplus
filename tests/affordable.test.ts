import { describe, expect, it } from 'vitest'
import { affords, costOf, type Affordable } from '@/modules/fx/affordable'
import { RATE_ONE, convert } from '@/modules/fx/rates'
import { relieveFunctional } from '@/modules/fx/documents'

/**
 * How much of a foreign document a home-money holding can settle (Phase 142).
 *
 * No database, no clock. A gift card holds the company's own money and is spent
 * against an invoice that may be in any currency at all, and `redeemGiftCard`
 * decides how much by taking `min(card.balanceCents, bill.balanceCents)` — a
 * dollar against a euro.
 */

/** A €1,000 invoice carried at 1.10, which is $1,100 on the books. */
const EURO_INVOICE = {
  balanceCents: 100_000,
  functionalBalanceCents: 110_000,
  rateMillionths: 1_100_000,
  documentCurrency: 'EUR',
  homeCurrency: 'USD',
} as const

const on = (
  heldCents: number,
  document: Omit<Affordable, 'heldCents'> = EURO_INVOICE,
): Affordable => ({ heldCents, ...document })

describe('what a card can buy of a foreign invoice', () => {
  it('takes as much as it covers, never more than it holds', () => {
    // **The measurement the phase exists for.** A $600 card against a €1,000
    // invoice at 1.10 buys €545.45, which costs exactly $600.
    //
    // Today it applies €600 — the `min` compares a dollar with a euro — which
    // credits Accounts Receivable $600 while relieving the invoice's functional
    // twin by $660. The control account and the subledger part company by $60
    // and the customer gets $660 of debt forgiven for a $600 card.
    const verdict = affords(on(60_000))

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return

    expect(verdict.faceCents).toBe(54_545)
    expect(verdict.settlesInFull).toBe(false)
    expect(verdict.converted).toBe(true)

    // What it costs the card, and it is the whole card to the cent.
    expect(costOf(verdict.faceCents, EURO_INVOICE.rateMillionths)).toBe(60_000)
  })

  it('clears the invoice outright when it can, landing both columns on zero', () => {
    // The case that decides the design. A $1,200 card covers the $1,100 the
    // invoice is carried at, so the face amount is the whole balance — and
    // `relieveFunctional` then relieves the **carried** figure rather than a
    // fresh conversion, which is the only way both columns reach zero together.
    const verdict = affords(on(120_000))

    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.faceCents).toBe(100_000)
    expect(verdict.settlesInFull).toBe(true)

    const relieved = relieveFunctional(
      {
        balanceCents: EURO_INVOICE.balanceCents,
        exchangeRateMillionths: EURO_INVOICE.rateMillionths,
        functionalBalanceCents: EURO_INVOICE.functionalBalanceCents,
      },
      verdict.faceCents,
    )

    expect(relieved.functionalCents).toBe(110_000)
    expect(relieved.functionalBalanceCents).toBe(0)
  })

  it('leaves the invoice owing the rest, in its own currency', () => {
    const verdict = affords(on(60_000))
    if (!verdict.ok) return

    const relieved = relieveFunctional(
      {
        balanceCents: EURO_INVOICE.balanceCents,
        exchangeRateMillionths: EURO_INVOICE.rateMillionths,
        functionalBalanceCents: EURO_INVOICE.functionalBalanceCents,
      },
      verdict.faceCents,
    )

    // €454.55 still owed, carried at $500.
    expect(EURO_INVOICE.balanceCents - verdict.faceCents).toBe(45_455)
    expect(relieved.functionalBalanceCents).toBe(50_000)
    expect(relieved.functionalCents).toBe(60_000)
  })

  it('never lets the holding go overdrawn, at any rate or balance', () => {
    // The property that matters, and the reason the arithmetic floors rather
    // than rounds. Rounding to nearest buys one cent more of the document than
    // the card holds — a liability account going the wrong way for a penny.
    const rates = [1, 500_000, 999_999, RATE_ONE, 1_000_001, 1_083_500, 1_100_000, 7_654_321]
    const holdings = [1, 2, 7, 99, 100, 4_999, 60_000, 1_234_567]

    for (const rateMillionths of rates) {
      for (const heldCents of holdings) {
        const verdict = affords({
          heldCents,
          // Deliberately far more than any holding can cover, so every case
          // takes the partial branch.
          balanceCents: 100_000_000,
          functionalBalanceCents: convert(100_000_000, rateMillionths),
          rateMillionths,
          documentCurrency: 'EUR',
          homeCurrency: 'USD',
        })

        if (!verdict.ok) continue
        expect(
          costOf(verdict.faceCents, rateMillionths),
          `held ${heldCents} at ${rateMillionths}`,
        ).toBeLessThanOrEqual(heldCents)
      }
    }
  })

  it('buys as much as it honestly can, not obviously less', () => {
    // The other half of the property, so that flooring cannot be satisfied by
    // returning nothing. One cent more of the document would always cost more
    // than the holding has.
    for (const rateMillionths of [1_083_500, 1_100_000, 3_141_592]) {
      const verdict = affords({
        heldCents: 60_000,
        balanceCents: 100_000_000,
        functionalBalanceCents: convert(100_000_000, rateMillionths),
        rateMillionths,
        documentCurrency: 'EUR',
        homeCurrency: 'USD',
      })

      if (!verdict.ok) return
      expect(costOf(verdict.faceCents + 1, rateMillionths), `${rateMillionths}`).toBeGreaterThan(
        60_000,
      )
    }
  })
})

describe('a domestic invoice, which is every one so far', () => {
  it('answers exactly what redeemFor answers today', () => {
    // Why this went a hundred and forty-one phases unnoticed: at a rate of one
    // the face amount and the functional amount are the same number, so `min`
    // over two currencies gives the right answer for the wrong reason.
    const domestic = {
      balanceCents: 100_000,
      functionalBalanceCents: 100_000,
      rateMillionths: RATE_ONE,
      documentCurrency: 'USD',
      homeCurrency: 'USD',
    } as const

    const partial = affords(on(60_000, domestic))
    expect(partial.ok && partial.faceCents).toBe(60_000)
    expect(partial.ok && partial.converted).toBe(false)

    const full = affords(on(150_000, domestic))
    expect(full.ok && full.faceCents).toBe(100_000)
    expect(full.ok && full.settlesInFull).toBe(true)
  })
})

describe('what affords refuses', () => {
  it('says the card is empty rather than applying nothing', () => {
    const verdict = affords(on(0))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('nothing left on it')
  })

  it('says the invoice is settled rather than applying nothing', () => {
    const verdict = affords(on(60_000, { ...EURO_INVOICE, balanceCents: 0 }))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('nothing owing on it')
  })

  it('refuses a document carrying no rate, and says what to do', () => {
    // Phase 119's standard. An invoice with a zero rate is a data defect, and
    // guessing a rate here would put a figure on the books nobody can trace.
    const verdict = affords(on(60_000, { ...EURO_INVOICE, rateMillionths: 0 }))

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('no exchange rate recorded')
    expect(verdict.why).toContain('Put the rate on the document first')
  })

  it('refuses when the holding does not buy one cent of the document', () => {
    // A card with a penny on it against a currency worth far more. Applying
    // zero would be a journal entry of nothing and a redemption row claiming
    // something happened.
    const verdict = affords(on(1, { ...EURO_INVOICE, rateMillionths: 7_654_321 }))

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('does not buy a single cent')
    expect(verdict.why).toContain('EUR')
  })
})

describe('the two holdings that carry no currency', () => {
  it('asks a different question from spends, which is why it is separate', () => {
    // `gift_cards` and `deposit_movements` are the only tables holding the
    // company's own money that settle a document with it. Phase 138 built
    // `spends` for the deposit — *this much: can it?* — and this answers *as
    // much as it can: how much?*.
    //
    // The distinction is not stylistic. A card that cannot cover the bill is
    // the ordinary case and must not refuse; a deposit application that cannot
    // cover the amount somebody typed must (Phase 130: argue a new value rather
    // than bending the nearest).
    const short = affords(on(60_000))
    expect(short.ok).toBe(true)
    if (!short.ok) return
    expect(short.settlesInFull).toBe(false)
  })
})
