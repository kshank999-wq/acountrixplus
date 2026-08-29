import { describe, expect, it } from 'vitest'
import { documentQuote, offerableCurrencies } from '@/modules/fx/quoting'
import { convert } from '@/modules/fx/rates'

/**
 * The euro invoice you could not raise (Phase 64).
 *
 * ADR 0063 named this itself: every screen downstream handles a foreign
 * document correctly now, and there was no way to make one. This is the
 * composer's half — what may be chosen, and what it books at once it is.
 */

/** 1.0835 — enough decimals that line-by-line rounding is visible. */
const RATE = 1_083_500

describe('what a company may raise a document in', () => {
  it('always offers its own currency, with no rate needed', () => {
    expect(offerableCurrencies('USD', [])).toEqual(['USD'])
  })

  it('puts the home currency first, then the rest in order', () => {
    expect(offerableCurrencies('USD', ['JPY', 'EUR', 'GBP'])).toEqual([
      'USD',
      'EUR',
      'GBP',
      'JPY',
    ])
  })

  /** The rates table holds a row per date, so the same code arrives many times. */
  it('offers each currency once however many rates it has', () => {
    expect(offerableCurrencies('USD', ['EUR', 'EUR', 'EUR'])).toEqual(['USD', 'EUR'])
  })

  it('does not offer the home currency twice when it has rates of its own', () => {
    expect(offerableCurrencies('USD', ['USD', 'EUR'])).toEqual(['USD', 'EUR'])
  })

  it('is not confused by case or spacing', () => {
    expect(offerableCurrencies(' usd ', ['eur'])).toEqual(['USD', 'EUR'])
  })

  /**
   * A company whose books are in euro is not a special case: its own currency
   * leads, and the dollar is the foreign one.
   */
  it('works for a company that does not keep its books in dollars', () => {
    expect(offerableCurrencies('EUR', ['USD', 'GBP'])).toEqual(['EUR', 'GBP', 'USD'])
  })
})

describe('what a document will book at', () => {
  it('says nothing about a domestic document', () => {
    const quote = documentQuote({
      lineCents: [400_000],
      currency: 'USD',
      homeCurrency: 'USD',
      rateMillionths: 1_000_000,
      rateDate: null,
    })

    expect(quote.foreign).toBe(false)
    expect(quote.note).toBeNull()
    expect(quote.totalCents).toBe(400_000)
    expect(quote.functionalTotalCents).toBe(400_000)
  })

  it('converts a foreign document and says what it books at', () => {
    const quote = documentQuote({
      lineCents: [400_000],
      currency: 'EUR',
      homeCurrency: 'USD',
      rateMillionths: RATE,
      rateDate: '2026-08-01',
    })

    expect(quote.foreign).toBe(true)
    expect(quote.totalCents).toBe(400_000)
    expect(quote.functionalTotalCents).toBe(convert(400_000, RATE))
    expect(quote.note).toContain('€4,000.00 books as $4,334.00')
    expect(quote.note).toContain('1.083500')
  })

  /**
   * The substance. The preview has to be the arithmetic the posting will do —
   * Phase 63's rule, borrowed rather than restated. Converting the total here
   * would show a figure a cent away from the invoice that lands.
   */
  it('totals the converted lines, exactly as the posting will', () => {
    const lineCents = [33_333, 33_333, 33_333]

    const quote = documentQuote({
      lineCents,
      currency: 'EUR',
      homeCurrency: 'USD',
      rateMillionths: RATE,
      rateDate: '2026-08-01',
    })

    const sumOfConverted = lineCents.reduce((sum, cents) => sum + convert(cents, RATE), 0)
    expect(quote.functionalTotalCents).toBe(sumOfConverted)
    expect(sumOfConverted).not.toBe(convert(99_999, RATE))
  })

  it('converts tax along with the lines', () => {
    const quote = documentQuote({
      lineCents: [100_000],
      taxCents: 8_750,
      currency: 'EUR',
      homeCurrency: 'USD',
      rateMillionths: RATE,
      rateDate: '2026-08-01',
    })

    expect(quote.totalCents).toBe(108_750)
    expect(quote.functionalTotalCents).toBe(convert(100_000, RATE) + convert(8_750, RATE))
  })

  /**
   * `rateFor` walks backwards to the most recent rate on or before the issue
   * date, so an August document is often raised at June's rate. Since the rate
   * is fixed at issue and never recomputed, the composer is the only place
   * anybody will ever be told which rate it was.
   */
  it('names the rate’s own date, which is often not the document’s', () => {
    const quote = documentQuote({
      lineCents: [400_000],
      currency: 'EUR',
      homeCurrency: 'USD',
      rateMillionths: RATE,
      rateDate: '2026-06-01',
    })

    expect(quote.note).toContain('the rate of 2026-06-01')
    expect(quote.note).toContain('never recomputed')
  })

  it('leaves the date out when there is none to name', () => {
    const quote = documentQuote({
      lineCents: [400_000],
      currency: 'EUR',
      homeCurrency: 'USD',
      rateMillionths: RATE,
      rateDate: null,
    })

    expect(quote.note).toContain('books as')
    expect(quote.note).not.toContain('the rate of')
  })

  /** A company keeping its books in euro converts the dollar, not the other way. */
  it('treats the home currency as home whatever it is', () => {
    const quote = documentQuote({
      lineCents: [400_000],
      currency: 'EUR',
      homeCurrency: 'EUR',
      rateMillionths: RATE,
      rateDate: '2026-08-01',
    })

    expect(quote.foreign).toBe(false)
    expect(quote.functionalTotalCents).toBe(400_000)
    // The rate is ignored rather than applied: a euro document in a euro
    // company is not a conversion, whatever rate happens to be on file.
    expect(quote.rateMillionths).toBe(1_000_000)
  })

  it('handles a document with nothing on it yet', () => {
    const quote = documentQuote({
      lineCents: [],
      currency: 'EUR',
      homeCurrency: 'USD',
      rateMillionths: RATE,
      rateDate: '2026-08-01',
    })

    expect(quote.totalCents).toBe(0)
    expect(quote.functionalTotalCents).toBe(0)
  })
})
