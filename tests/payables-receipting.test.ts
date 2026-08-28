import { describe, expect, it } from 'vitest'
import {
  VARIANCE_TOLERANCE_BP,
  describeMatch,
  matchVerdict,
  toleranceCents,
  worthMentioning,
  type BillableReceipt,
} from '@/modules/payables/receipting'

/**
 * The bill for goods you already have (Phase 48).
 *
 * The claim under test: **what comes out of the clearing account is what went
 * in.** Goods Received Not Invoiced was credited with the receipt's own value,
 * so that is the figure that has to come back out — clearing the *invoice's*
 * amount instead leaves a residue indistinguishable from a delivery nobody has
 * billed, which is how the demo grew $28,700 in an account nothing could clear.
 */

const receipt = (over: Partial<BillableReceipt> = {}): BillableReceipt => ({
  id: 'receipt-1',
  number: 'GRN-1001',
  vendorId: 'vendor-a',
  totalCents: 120_000,
  billId: null,
  ...over,
})

describe('matchVerdict', () => {
  it('clears the receipt when the invoice agrees with it', () => {
    const verdict = matchVerdict({
      receipts: [receipt()],
      billedCents: 120_000,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('clear')
    expect(verdict.clearedCents).toBe(120_000)
    expect(verdict.varianceCents).toBe(0)
  })

  /**
   * The heart of the phase. 2050 was credited 120,000 when the goods arrived,
   * so 120,000 is what comes out — not the 123,000 the supplier is asking for.
   * The 3,000 is a cost of buying and goes on the profit and loss.
   */
  it('clears what went in, not what was billed', () => {
    const verdict = matchVerdict({
      receipts: [receipt()],
      billedCents: 123_000,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('clear_with_variance')
    expect(verdict.clearedCents).toBe(120_000)
    expect(verdict.varianceCents).toBe(3_000)
  })

  it('handles an undercharge as the other direction of the same thing', () => {
    const verdict = matchVerdict({
      receipts: [receipt()],
      billedCents: 117_000,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('clear_with_variance')
    expect(verdict.clearedCents).toBe(120_000)
    expect(verdict.varianceCents).toBe(-3_000)
    expect(verdict.why).toContain('less than')
  })

  it('adds up several deliveries on one invoice', () => {
    const verdict = matchVerdict({
      receipts: [
        receipt({ id: 'a', number: 'GRN-1001', totalCents: 120_000 }),
        receipt({ id: 'b', number: 'GRN-1002', totalCents: 45_500 }),
      ],
      billedCents: 165_500,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('clear')
    expect(verdict.clearedCents).toBe(165_500)
  })

  /**
   * Billing one supplier's delivery on another's invoice would clear the wrong
   * balance and leave both suppliers wrong. Checked here rather than trusted to
   * the screen, because the screen is not the only caller.
   */
  it('refuses a delivery from a different supplier', () => {
    const verdict = matchVerdict({
      receipts: [receipt(), receipt({ id: 'b', number: 'GRN-1002', vendorId: 'vendor-b' })],
      billedCents: 240_000,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('refuse')
    expect(verdict.clearedCents).toBe(0)
    expect(verdict.why).toContain('GRN-1002')
    expect(verdict.why).toContain('different supplier')
  })

  it('refuses a delivery already billed, and says why it matters', () => {
    const verdict = matchVerdict({
      receipts: [receipt({ billId: 'bill-9' })],
      billedCents: 120_000,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('refuse')
    expect(verdict.why).toContain('pay for it twice')
  })

  it('refuses when nothing was chosen', () => {
    const verdict = matchVerdict({ receipts: [], billedCents: 120_000, vendorId: 'vendor-a' })

    expect(verdict.action).toBe('refuse')
    expect(verdict.why).toContain('nothing to clear')
  })

  it('refuses a bill for nothing', () => {
    expect(
      matchVerdict({ receipts: [receipt()], billedCents: 0, vendorId: 'vendor-a' }).action,
    ).toBe('refuse')
    expect(
      matchVerdict({ receipts: [receipt()], billedCents: -1, vendorId: 'vendor-a' }).action,
    ).toBe('refuse')
  })
})

describe('the tolerance', () => {
  it('is half a percent', () => {
    expect(VARIANCE_TOLERANCE_BP).toBe(50)
    expect(toleranceCents(120_000)).toBe(600)
  })

  it('is never negative, whichever way the variance went', () => {
    expect(toleranceCents(-120_000)).toBe(600)
  })

  /**
   * A rounded freight charge, or a rate that moved between order and delivery.
   * The variance is posted either way — the tolerance only decides whether
   * anybody is told, and a notice that fires on every delivery is one nobody
   * reads by the end of the week.
   */
  it('says nothing about a rounding difference', () => {
    const verdict = matchVerdict({
      receipts: [receipt()],
      billedCents: 120_400,
      vendorId: 'vendor-a',
    })

    expect(verdict.action).toBe('clear_with_variance')
    expect(verdict.varianceCents).toBe(400)
    expect(worthMentioning(verdict)).toBe(false)
    expect(describeMatch(verdict)).toBeNull()
  })

  it('speaks up about a supplier quietly repricing', () => {
    const verdict = matchVerdict({
      receipts: [receipt()],
      billedCents: 123_000,
      vendorId: 'vendor-a',
    })

    expect(worthMentioning(verdict)).toBe(true)
    const sentence = describeMatch(verdict)
    expect(sentence).toContain('30.00 more')
    expect(sentence).toContain('1200.00')
    expect(sentence).toContain('purchase price variance')
  })

  it('speaks up in both directions', () => {
    const under = matchVerdict({
      receipts: [receipt()],
      billedCents: 117_000,
      vendorId: 'vendor-a',
    })

    expect(worthMentioning(under)).toBe(true)
    expect(describeMatch(under)).toContain('30.00 less')
  })

  it('has nothing to say when the invoice matched exactly', () => {
    const verdict = matchVerdict({
      receipts: [receipt()],
      billedCents: 120_000,
      vendorId: 'vendor-a',
    })

    expect(worthMentioning(verdict)).toBe(false)
    expect(describeMatch(verdict)).toBeNull()
  })

  /** A refusal is always said out loud, tolerance or not. */
  it('always reports a refusal', () => {
    const verdict = matchVerdict({ receipts: [], billedCents: 1, vendorId: 'vendor-a' })
    expect(describeMatch(verdict)).toBe(verdict.why)
  })
})
