import { describe, expect, it } from 'vitest'
import {
  allocate,
  byOldest,
  unappliedNote,
  type OpenDocument,
} from '@/modules/receivables/allocation'

/**
 * Deciding what a payment settles (Phase 41).
 *
 * The pure half. No database, no clock — an amount and a set of open documents
 * go in, and applications that sum to what was actually placed come out.
 */

const doc = (
  number: string,
  balanceCents: number,
  dueDate: string,
  issueDate = dueDate,
): OpenDocument => ({ id: `id-${number}`, number, balanceCents, dueDate, issueDate })

describe('allocate', () => {
  it('settles one invoice exactly', () => {
    const result = allocate(50_000, [doc('1001', 50_000, '2026-03-31')])

    expect(result.applications).toEqual([
      { documentId: 'id-1001', number: '1001', amountCents: 50_000 },
    ])
    expect(result.appliedCents).toBe(50_000)
    expect(result.unappliedCents).toBe(0)
  })

  it('fills the oldest first when the customer did not say', () => {
    const result = allocate(60_000, [
      doc('1003', 40_000, '2026-05-31'),
      doc('1001', 30_000, '2026-03-31'),
      doc('1002', 30_000, '2026-04-30'),
    ])

    expect(result.applications).toEqual([
      { documentId: 'id-1001', number: '1001', amountCents: 30_000 },
      { documentId: 'id-1002', number: '1002', amountCents: 30_000 },
    ])
    expect(result.unappliedCents).toBe(0)
  })

  it('part-pays the last one it reaches', () => {
    const result = allocate(45_000, [
      doc('1001', 30_000, '2026-03-31'),
      doc('1002', 30_000, '2026-04-30'),
    ])

    expect(result.applications.map((a) => a.amountCents)).toEqual([30_000, 15_000])
    expect(result.appliedCents).toBe(45_000)
  })

  /**
   * The wrong answer that leaves a negative balance, an invoice that looks
   * overpaid, and a control account that no longer equals the sum of open
   * balances.
   */
  it('never applies more than a document owes', () => {
    const result = allocate(100_000, [doc('1001', 30_000, '2026-03-31')])

    expect(result.applications).toEqual([
      { documentId: 'id-1001', number: '1001', amountCents: 30_000 },
    ])
    expect(result.appliedCents).toBe(30_000)
  })

  /**
   * The other wrong answer. Cash recorded against nothing: the bank agrees,
   * the customer's statement does not, and nobody finds out until they ask why
   * they are still being chased.
   */
  it('hands back what it could not place rather than absorbing it', () => {
    const result = allocate(100_000, [doc('1001', 30_000, '2026-03-31')])
    expect(result.unappliedCents).toBe(70_000)
    expect(result.appliedCents + result.unappliedCents).toBe(100_000)
  })

  it('skips a settled document rather than writing a zero application', () => {
    // A payment row against an invoice it did not touch is noise on that
    // invoice's history for ever.
    const result = allocate(20_000, [
      doc('1001', 0, '2026-03-31'),
      doc('1002', 20_000, '2026-04-30'),
    ])

    expect(result.applications).toEqual([
      { documentId: 'id-1002', number: '1002', amountCents: 20_000 },
    ])
  })

  it('is not tricked into taking money off by a negative balance', () => {
    const result = allocate(20_000, [
      doc('1001', -5_000, '2026-03-31'),
      doc('1002', 20_000, '2026-04-30'),
    ])

    expect(result.applications).toEqual([
      { documentId: 'id-1002', number: '1002', amountCents: 20_000 },
    ])
    expect(result.appliedCents).toBe(20_000)
  })

  it('honours the order given when somebody names the invoice', () => {
    // "This cheque is for 1003" — the newest, deliberately.
    const result = allocate(
      40_000,
      [doc('1003', 40_000, '2026-05-31'), doc('1001', 30_000, '2026-03-31')],
      { respectOrder: true },
    )

    expect(result.applications).toEqual([
      { documentId: 'id-1003', number: '1003', amountCents: 40_000 },
    ])
  })

  it('places nothing when there is nothing open', () => {
    const result = allocate(20_000, [])
    expect(result.applications).toEqual([])
    expect(result.unappliedCents).toBe(20_000)
  })

  it('refuses an amount that is not a positive whole number of cents', () => {
    expect(allocate(0, [doc('1001', 100, '2026-03-31')]).applications).toEqual([])
    expect(allocate(-500, [doc('1001', 100, '2026-03-31')]).applications).toEqual([])
    expect(allocate(12.5, [doc('1001', 100, '2026-03-31')]).applications).toEqual([])
  })

  it('applies every cent it says it applied', () => {
    const documents = [
      doc('1001', 33_333, '2026-03-31'),
      doc('1002', 33_333, '2026-04-30'),
      doc('1003', 33_334, '2026-05-31'),
    ]
    const result = allocate(100_000, documents)

    const summed = result.applications.reduce((sum, a) => sum + a.amountCents, 0)
    expect(summed).toBe(result.appliedCents)
    expect(summed).toBe(100_000)
  })
})

describe('byOldest', () => {
  it('sorts by due date first', () => {
    expect(byOldest(doc('1001', 1, '2026-04-30'), doc('1002', 1, '2026-03-31'))).toBeGreaterThan(0)
  })

  it('falls back to the issue date when two fall due together', () => {
    const later = doc('1001', 1, '2026-04-30', '2026-04-01')
    const earlier = doc('1002', 1, '2026-04-30', '2026-03-01')
    expect(byOldest(later, earlier)).toBeGreaterThan(0)
  })

  /**
   * Two invoices raised on one day for one customer are distinguished by
   * nothing else, and an ordering that flips between runs would make the same
   * payment settle different invoices each time.
   */
  it('is total, so the same payment always settles the same invoices', () => {
    const a = doc('1001', 1, '2026-04-30', '2026-04-01')
    const b = doc('1002', 1, '2026-04-30', '2026-04-01')
    expect(byOldest(a, b)).toBeLessThan(0)
    expect(byOldest(b, a)).toBeGreaterThan(0)
    expect(byOldest(a, a)).toBe(0)
  })
})

describe('unappliedNote', () => {
  it('says nothing when the payment landed in full', () => {
    expect(unappliedNote(allocate(100, [doc('1001', 100, '2026-03-31')]), 'receipt')).toBeNull()
  })

  it('says which way round the overpayment is', () => {
    const over = allocate(200, [doc('1001', 100, '2026-03-31')])
    expect(unappliedNote(over, 'receipt')).toContain('customer has paid')
    expect(unappliedNote(over, 'disbursement')).toContain('This pays')
  })
})
