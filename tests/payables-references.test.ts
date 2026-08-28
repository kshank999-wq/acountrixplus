import { describe, expect, it } from 'vitest'
import {
  NEAR_DATE_DAYS,
  daysBetween,
  describeDuplicate,
  duplicateVerdict,
  mayProceed,
  normaliseReference,
  type ComparableBill,
} from '@/modules/payables/references'

/**
 * The supplier's reference, and the bill entered twice (Phase 47).
 *
 * The claim under test: **a reference identifies a document within a
 * supplier.** Two suppliers sharing a number is routine and must not be an
 * error; one supplier repeating a number is the same document and must not be
 * enterable twice.
 */

const bill = (over: Partial<ComparableBill> = {}): ComparableBill => ({
  id: 'bill-1',
  number: 'BILL-1001',
  vendorId: 'vendor-a',
  referenceKey: 'INV4471',
  issueDate: '2026-08-01',
  totalCents: 120_000,
  ...over,
})

describe('normaliseReference', () => {
  /**
   * The same invoice comes off three systems and a rubber stamp. Case, spaces
   * and punctuation are noise; the letters and digits are the reference.
   */
  it('reduces a reference to what it identifies', () => {
    expect(normaliseReference('INV-4471')).toBe('INV4471')
    expect(normaliseReference('inv 4471')).toBe('INV4471')
    expect(normaliseReference('  INV/4471 ')).toBe('INV4471')
    expect(normaliseReference('#INV-4471')).toBe('INV4471')
  })

  it('keeps genuinely different references apart', () => {
    expect(normaliseReference('INV-4471')).not.toBe(normaliseReference('INV-4472'))
    expect(normaliseReference('2026-001')).toBe('2026001')
    expect(normaliseReference('2026-010')).toBe('2026010')
  })

  /**
   * A reference of "-" identifies nothing. Treating it as a key would make two
   * unrelated bills collide and refuse the second, which is the exact failure
   * this phase exists to end.
   */
  it('is null when there is nothing to identify', () => {
    expect(normaliseReference(null)).toBeNull()
    expect(normaliseReference(undefined)).toBeNull()
    expect(normaliseReference('')).toBeNull()
    expect(normaliseReference('   ')).toBeNull()
    expect(normaliseReference('---')).toBeNull()
    expect(normaliseReference('/')).toBeNull()
  })
})

describe('duplicateVerdict', () => {
  /**
   * The defect this phase fixes. `bills.number` was unique per *company* while
   * the composer wrote the supplier's own reference into it, so two suppliers
   * both numbering an invoice INV-4471 — not a coincidence, it is how invoice
   * numbering works — could not both be entered.
   */
  it('lets two suppliers use the same number', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-b',
        referenceKey: 'INV4471',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ vendorId: 'vendor-a' })],
    })

    expect(verdict.action).toBe('allow')
    expect(verdict.matches).toHaveLength(0)
  })

  it('refuses one supplier repeating their own reference', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: 'INV4471',
        // A different date and a different amount. Still the same document:
        // the supplier does not issue two invoices under one number, so one of
        // these two was keyed wrong.
        issueDate: '2026-08-14',
        totalCents: 95_000,
      },
      existing: [bill()],
    })

    expect(verdict.action).toBe('refuse')
    expect(verdict.matches[0].number).toBe('BILL-1001')
    expect(verdict.matches[0].why).toContain('already on BILL-1001')
  })

  it('names the bill it clashes with, so nobody has to search a list', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: 'INV4471',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ number: 'BILL-1099' })],
    })

    const sentence = describeDuplicate(verdict)
    expect(sentence).toContain('BILL-1099')
    expect(sentence).toContain('2026-08-01')
  })

  /**
   * The emailed PDF and the posted copy, entered by two people, neither of whom
   * typed the reference. Nothing here is certain, so nothing here is refused.
   */
  it('warns about the same amount on the same day with no reference', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null })],
    })

    expect(verdict.action).toBe('warn')
    expect(verdict.matches[0].why).toContain('same amount, dated the same day')
  })

  it('warns about the same amount within a fortnight', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-13',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null, issueDate: '2026-08-01' })],
    })

    expect(verdict.action).toBe('warn')
    expect(verdict.matches).toHaveLength(1)
  })

  /**
   * Rent, a retainer, a standing order. A monthly charge of the same amount is
   * outside the window on purpose: a warning that fires every month is one
   * nobody reads by the third month, and the one that matters goes with it.
   */
  it('says nothing about the same amount a month later', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-09-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null, issueDate: '2026-08-01' })],
    })

    expect(verdict.action).toBe('allow')
  })

  it('says nothing about a different amount on the same day', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-01',
        totalCents: 119_999,
      },
      existing: [bill({ referenceKey: null })],
    })

    expect(verdict.action).toBe('allow')
  })

  /** A bill that matched on amount and date must not be listed twice. */
  it('reports each resemblance once', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null })],
    })

    expect(verdict.matches).toHaveLength(1)
  })

  it('has nothing to say about the first bill a supplier ever sends', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-new',
        referenceKey: 'INV4471',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [],
    })

    expect(verdict.action).toBe('allow')
    expect(describeDuplicate(verdict)).toBeNull()
  })

  it('uses the fortnight the constant names', () => {
    const inside = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-15',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null, issueDate: '2026-08-01' })],
    })
    const outside = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-16',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null, issueDate: '2026-08-01' })],
    })

    expect(NEAR_DATE_DAYS).toBe(14)
    expect(inside.action).toBe('warn')
    expect(outside.action).toBe('allow')
  })
})

describe('mayProceed', () => {
  /**
   * The machine is certain about exactly one thing. Everywhere else the person
   * entering the bill is holding it and the machine is not, so a warning is
   * always overridable and a refusal never is.
   */
  it('never lets a refusal through, acknowledged or not', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: 'INV4471',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill()],
    })

    expect(mayProceed(verdict, false)).toBe(false)
    expect(mayProceed(verdict, true)).toBe(false)
  })

  it('lets a warning through once somebody has looked', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null })],
    })

    expect(mayProceed(verdict, false)).toBe(false)
    expect(mayProceed(verdict, true)).toBe(true)
  })

  it('does not ask about a bill nothing resembles', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: 'INV9999',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill()],
    })

    expect(mayProceed(verdict, false)).toBe(true)
  })
})

describe('two references that differ', () => {
  /**
   * Found by a test written before the rule was right. A builder invoicing two
   * sites for the same amount on the same day, under INV-4471 and INV-4472, is
   * ordinary — and the supplier has already said these are two documents by
   * numbering them differently. Warning about it every time is how a warning
   * stops being read, and the one that matters goes with it.
   */
  it('are two documents, not a resemblance', () => {
    const verdict = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: 'INV4472',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: 'INV4471' })],
    })

    expect(verdict.action).toBe('allow')
  })

  /**
   * But one side having no reference leaves nothing to distinguish them by, so
   * the resemblance stands and a person decides.
   */
  it('still warn when only one side carries a reference', () => {
    const noneOnTheNew = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: null,
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: 'INV4471' })],
    })
    const noneOnTheOld = duplicateVerdict({
      candidate: {
        vendorId: 'vendor-a',
        referenceKey: 'INV4471',
        issueDate: '2026-08-01',
        totalCents: 120_000,
      },
      existing: [bill({ referenceKey: null })],
    })

    expect(noneOnTheNew.action).toBe('warn')
    expect(noneOnTheOld.action).toBe('warn')
  })
})

describe('daysBetween', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-08-01', '2026-08-15')).toBe(14)
    expect(daysBetween('2026-08-15', '2026-08-01')).toBe(-14)
    expect(daysBetween('2026-08-01', '2026-08-01')).toBe(0)
  })

  /** Across a month end and a leap day, where naive arithmetic goes wrong. */
  it('is right across boundaries', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
  })
})
