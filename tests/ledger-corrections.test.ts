import { describe, expect, it } from 'vitest'
import {
  correctionFor,
  documentAdvice,
  isClosed,
  isDerived,
  mayUse,
  reversalDateFor,
  type ClosedPeriod,
  type CorrectableEntry,
} from '@/modules/ledger/corrections'

/**
 * Correcting a journal entry (Phase 51).
 *
 * The claim under test: **an entry that is the ledger half of a document is
 * never corrected by touching the ledger.** Voiding the entry behind an
 * invoice leaves the invoice claiming money that Accounts Receivable no longer
 * carries — the one disagreement Phase 31 went to the trouble of proving never
 * happens.
 */

const entry = (over: Partial<CorrectableEntry> = {}): CorrectableEntry => ({
  id: 'entry-1',
  entryNumber: 412,
  entryDate: '2026-08-15',
  status: 'posted',
  source: 'manual',
  sourceType: null,
  reversalOfId: null,
  ...over,
})

const CLOSED: ClosedPeriod[] = [{ periodStart: '2026-01-01', periodEnd: '2026-06-30' }]

describe('whether an entry belongs to a document', () => {
  it('leaves a hand-posted entry alone', () => {
    expect(isDerived(entry())).toBe(false)
  })

  it('recognises one raised by a document', () => {
    expect(isDerived(entry({ source: 'invoice' }))).toBe(true)
    expect(isDerived(entry({ source: 'payroll' }))).toBe(true)
    expect(isDerived(entry({ source: 'bank_transaction' }))).toBe(true)
  })

  /**
   * The case the source enum alone misses. `reverseEntry` posts its reversal
   * with source `adjusting` while copying the original's `sourceType`, so
   * unwinding a deposit produces an `adjusting` entry that is still tied to a
   * document. Testing the source alone would have let that one through.
   */
  it('recognises an adjusting entry still tied to a document', () => {
    expect(isDerived(entry({ source: 'adjusting', sourceType: 'deposits' }))).toBe(true)
  })

  it('leaves a hand-posted adjusting entry alone', () => {
    expect(isDerived(entry({ source: 'adjusting', sourceType: null }))).toBe(false)
  })
})

describe('what to correct instead', () => {
  it('names the document, not the ledger', () => {
    expect(documentAdvice(entry({ source: 'invoice' }))).toContain('Void the invoice')
    expect(documentAdvice(entry({ source: 'bill' }))).toContain('Void the bill')
    expect(documentAdvice(entry({ source: 'payroll' }))).toContain('payroll run')
    expect(documentAdvice(entry({ source: 'bank_transaction' }))).toContain('Re-categorise')
  })

  /** A closing entry is undone by reopening the year, not by any of this. */
  it('sends a closing entry to the year-end controls', () => {
    expect(documentAdvice(entry({ source: 'closing' }))).toContain('Reopen the year')
  })

  it('has something to say about a source it has never seen', () => {
    expect(documentAdvice(entry({ source: 'something_new' }))).toContain('Correct the document')
  })
})

describe('closed periods', () => {
  it('includes both ends', () => {
    expect(isClosed('2026-01-01', CLOSED)).toBe(true)
    expect(isClosed('2026-06-30', CLOSED)).toBe(true)
    expect(isClosed('2026-07-01', CLOSED)).toBe(false)
    expect(isClosed('2025-12-31', CLOSED)).toBe(false)
  })

  it('says nothing is closed when nothing is', () => {
    expect(isClosed('2026-03-01', [])).toBe(false)
  })
})

describe('the date a reversal carries', () => {
  /**
   * Beside what it corrects, when that is allowed. Somebody reading the ledger
   * expects a correction to an August entry to sit in August.
   */
  it('is the entry’s own date while that period is open', () => {
    expect(reversalDateFor(entry({ entryDate: '2026-08-15' }), CLOSED, '2026-08-28')).toBe(
      '2026-08-15',
    )
  })

  it('is today when the entry’s period has been closed', () => {
    expect(reversalDateFor(entry({ entryDate: '2026-03-15' }), CLOSED, '2026-08-28')).toBe(
      '2026-08-28',
    )
  })

  /**
   * Both closed is a state a company resolves by reopening something, not one
   * this module can post its way out of.
   */
  it('is nothing at all when today is closed too', () => {
    const everything: ClosedPeriod[] = [{ periodStart: '2026-01-01', periodEnd: '2026-12-31' }]
    expect(reversalDateFor(entry({ entryDate: '2026-03-15' }), everything, '2026-08-28')).toBeNull()
  })
})

describe('how an entry may be corrected', () => {
  /**
   * The substance of the phase. `voidEntry` checks a permission and an open
   * period and nothing else, so wiring the button up naively would let
   * somebody void the entry behind INV-1002 and leave the invoice claiming
   * $24,000 that Accounts Receivable no longer carries.
   */
  it('refuses the ledger half of a document outright', () => {
    const verdict = correctionFor({
      entry: entry({ source: 'invoice', sourceType: 'invoices' }),
      closedPeriods: [],
      today: '2026-08-28',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('ledger half of a document')
    expect(verdict.ok === false && verdict.why).toContain('Void the invoice')
  })

  it('voids a hand-posted entry in an open period', () => {
    const verdict = correctionFor({ entry: entry(), closedPeriods: CLOSED, today: '2026-08-28' })

    expect(verdict.ok && verdict.method).toBe('void')
    expect(verdict.ok && verdict.why).toContain('stays listed as void')
  })

  /**
   * The accounting rule that makes this phase more than a button. Voiding an
   * entry in a closed period silently changes numbers somebody has already
   * given to a bank or a tax authority; a reversal shows the correction where
   * it can be seen.
   */
  it('reverses a hand-posted entry in a closed period', () => {
    const verdict = correctionFor({
      entry: entry({ entryDate: '2026-03-15' }),
      closedPeriods: CLOSED,
      today: '2026-08-28',
    })

    expect(verdict.ok && verdict.method).toBe('reverse')
    expect(verdict.ok && verdict.method === 'reverse' && verdict.reversalDate).toBe('2026-08-28')
    expect(verdict.ok && verdict.why).toContain('silently changing a period already reported on')
  })

  it('refuses one that is already void', () => {
    const verdict = correctionFor({
      entry: entry({ status: 'void' }),
      closedPeriods: [],
      today: '2026-08-28',
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('already void')
  })

  /** Reversing a reversal puts the original amount straight back on the books. */
  it('refuses one that has already been reversed', () => {
    const verdict = correctionFor({
      entry: entry(),
      closedPeriods: [],
      today: '2026-08-28',
      reversedBy: 500,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('already been reversed by #500')
  })

  it('refuses when there is nowhere open to post the correction', () => {
    const everything: ClosedPeriod[] = [{ periodStart: '2026-01-01', periodEnd: '2026-12-31' }]
    const verdict = correctionFor({
      entry: entry({ entryDate: '2026-03-15' }),
      closedPeriods: everything,
      today: '2026-08-28',
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('Reopen a period first')
  })
})

describe('a method somebody asked for explicitly', () => {
  const ask = (method: 'void' | 'reverse', over: Partial<CorrectableEntry> = {}) =>
    mayUse({ entry: entry(over), method, closedPeriods: CLOSED, today: '2026-08-28' })

  /**
   * Reversing is allowed wherever voiding is. An accountant may have given
   * last month's numbers to the bank on a Tuesday while the period is still
   * open, and a reversal is the honest correction for that.
   */
  it('allows reversing an entry it would have voided', () => {
    expect(ask('reverse').ok).toBe(true)
  })

  /** The opposite is not true, and that is the whole point of the rule. */
  it('refuses voiding an entry in a closed period', () => {
    const verdict = ask('void', { entryDate: '2026-03-15' })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('closed period')
  })

  it('refuses either method on the ledger half of a document', () => {
    expect(ask('void', { source: 'invoice', sourceType: 'invoices' }).ok).toBe(false)
    expect(ask('reverse', { source: 'invoice', sourceType: 'invoices' }).ok).toBe(false)
  })
})
