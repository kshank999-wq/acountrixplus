import { describe, expect, it } from 'vitest'
import { creditableAgainst, functionalAmounts } from '@/modules/fx/denomination'
import { convert } from '@/modules/fx/rates'

/**
 * The euro invoice you could not credit (Phase 63).
 *
 * `refuseForeign` has stopped four operations dead since Phase 35 — crediting
 * an invoice, crediting a bill, applying a credit, and drawing a retainer —
 * because a credit note carried no currency and nobody had decided how to
 * convert a multi-line document:
 *
 * > that amount is the *sum of the converted lines*, not the conversion of the
 * > sum. The two differ by a cent often enough to matter.
 *
 * Nobody had to decide. The document engine decided it when it raised the
 * invoice, and a credit note that reverses a document by different arithmetic
 * than raised it *is* the drift. So the rule moves here, where the invoice, the
 * bill and the credit note can all use one of it.
 */

/** 1.0835 — a rate with enough decimals to make rounding visible. */
const RATE = 1_083_500

describe('converting a document', () => {
  it('leaves a domestic document exactly as it was', () => {
    const result = functionalAmounts({
      lineCents: [120_000, 50_000],
      taxCents: 8_500,
      rateMillionths: 1_000_000,
    })

    expect(result.lineCents).toEqual([120_000, 50_000])
    expect(result.functionalTaxCents).toBe(8_500)
    expect(result.functionalTotalCents).toBe(178_500)
  })

  it('converts each line on its own', () => {
    const result = functionalAmounts({ lineCents: [33_333, 33_333], rateMillionths: RATE })

    expect(result.lineCents).toEqual([convert(33_333, RATE), convert(33_333, RATE)])
  })

  /**
   * The substance. Converting the total instead would leave the document's
   * stored functional amount a cent away from the journal entry derived from
   * it — and the two are supposed to be the same number seen twice.
   */
  it('totals the converted lines rather than converting the total', () => {
    const lineCents = [33_333, 33_333, 33_333]
    const result = functionalAmounts({ lineCents, rateMillionths: RATE })

    const sumOfConverted = lineCents.reduce((sum, cents) => sum + convert(cents, RATE), 0)
    const conversionOfSum = convert(
      lineCents.reduce((sum, cents) => sum + cents, 0),
      RATE,
    )

    expect(result.functionalTotalCents).toBe(sumOfConverted)
    // And the two really do differ, which is why the rule had to be picked.
    expect(sumOfConverted).not.toBe(conversionOfSum)
  })

  it('converts tax on its own too, and adds it in', () => {
    const result = functionalAmounts({
      lineCents: [100_000],
      taxCents: 8_750,
      rateMillionths: RATE,
    })

    expect(result.functionalTaxCents).toBe(convert(8_750, RATE))
    expect(result.functionalTotalCents).toBe(
      convert(100_000, RATE) + convert(8_750, RATE),
    )
  })

  it('handles a document with no lines at all', () => {
    const result = functionalAmounts({ lineCents: [], rateMillionths: RATE })

    expect(result.lineCents).toEqual([])
    expect(result.functionalTotalCents).toBe(0)
  })

  it('treats missing tax as none', () => {
    const result = functionalAmounts({ lineCents: [100_000], rateMillionths: 1_000_000 })

    expect(result.functionalTaxCents).toBe(0)
    expect(result.functionalTotalCents).toBe(100_000)
  })
})

describe('what a credit may be applied to', () => {
  it('allows a credit against a document in its own currency', () => {
    expect(
      creditableAgainst({
        creditNumber: 'CN-1001',
        creditCurrency: 'EUR',
        documentNumber: 'INV-1013',
        documentCurrency: 'EUR',
      }),
    ).toEqual({ ok: true })
  })

  it('allows the ordinary domestic case', () => {
    expect(
      creditableAgainst({
        creditNumber: 'CN-1001',
        creditCurrency: 'USD',
        documentNumber: 'INV-1001',
        documentCurrency: 'USD',
      }).ok,
    ).toBe(true)
  })

  /**
   * Phase 62's rule again, one document over: money in one currency has not
   * discharged a demand in another. A €500 credit does not reduce a $500
   * invoice by $500, and pretending it does puts a figure in the books the
   * customer's own ledger disagrees with.
   */
  it('refuses one raised in another currency', () => {
    const verdict = creditableAgainst({
      creditNumber: 'CN-1001',
      creditCurrency: 'EUR',
      documentNumber: 'INV-1001',
      documentCurrency: 'USD',
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toContain('CN-1001 is in EUR')
      expect(verdict.reason).toContain('INV-1001 is in USD')
      // The fix, named: somebody has to know which document to raise it against.
      expect(verdict.reason).toContain('raise the credit against a document')
    }
  })
})
