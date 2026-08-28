import { describe, expect, it } from 'vitest'
import {
  SOON_DAYS,
  applicationOrder,
  bucketFor,
  bucketTotals,
  daysBetween,
  groupBySupplier,
  planRun,
  type PayableBill,
} from '@/modules/payables/run'

/**
 * What you owe, and choosing what to pay (Phase 49).
 *
 * The claim under test: **the choice is the person's and is respected
 * absolutely.** `recordPaymentAction` has accepted `documentIds` since Phase 41
 * and no screen ever sent them, so money always landed oldest-first — onto the
 * very bill a business was deliberately holding back.
 */

const bill = (over: Partial<PayableBill> = {}): PayableBill => ({
  id: 'bill-1',
  number: 'BILL-1001',
  vendorId: 'vendor-a',
  vendorName: 'Northern Supplies',
  dueDate: '2026-08-28',
  balanceCents: 120_000,
  ...over,
})

describe('how late a bill is', () => {
  const asOf = '2026-08-28'

  it('is overdue only once the day has passed', () => {
    expect(bucketFor('2026-08-27', asOf)).toBe('overdue')
    expect(bucketFor('2026-08-28', asOf)).toBe('due_now')
  })

  /**
   * Due today is its own bucket rather than folded into overdue. A bill due
   * today is not late, and telling somebody it is makes them distrust the ones
   * that are.
   */
  it('does not call a bill due today late', () => {
    expect(bucketFor(asOf, asOf)).toBe('due_now')
  })

  it('looks a week ahead, and no further', () => {
    expect(SOON_DAYS).toBe(7)
    expect(bucketFor('2026-09-04', asOf)).toBe('due_soon')
    expect(bucketFor('2026-09-05', asOf)).toBe('later')
  })

  it('splits what is owed into the buckets', () => {
    const totals = bucketTotals(
      [
        bill({ id: 'a', dueDate: '2026-08-01', balanceCents: 50_000 }),
        bill({ id: 'b', dueDate: '2026-08-20', balanceCents: 30_000 }),
        bill({ id: 'c', dueDate: '2026-08-28', balanceCents: 20_000 }),
        bill({ id: 'd', dueDate: '2026-09-02', balanceCents: 10_000 }),
        bill({ id: 'e', dueDate: '2026-12-01', balanceCents: 5_000 }),
      ],
      asOf,
    )

    expect(totals.overdue).toEqual({ count: 2, totalCents: 80_000 })
    expect(totals.due_now).toEqual({ count: 1, totalCents: 20_000 })
    expect(totals.due_soon).toEqual({ count: 1, totalCents: 10_000 })
    expect(totals.later).toEqual({ count: 1, totalCents: 5_000 })
  })

  it('reports nothing owed as nothing owed', () => {
    const totals = bucketTotals([], asOf)
    expect(totals.overdue).toEqual({ count: 0, totalCents: 0 })
  })
})

describe('grouping a run', () => {
  /**
   * One payment per supplier, not one per bill. A business paying four of a
   * supplier's invoices writes one cheque and the bank statement shows one
   * line — the correspondence a reconciliation needs.
   */
  it('is one payment per supplier', () => {
    const groups = groupBySupplier([
      bill({ id: 'a', number: 'BILL-1001', balanceCents: 50_000 }),
      bill({ id: 'b', number: 'BILL-1002', balanceCents: 30_000 }),
      bill({
        id: 'c',
        number: 'BILL-1003',
        vendorId: 'vendor-b',
        vendorName: 'Harbour Plant Hire',
        balanceCents: 20_000,
      }),
    ])

    expect(groups).toHaveLength(2)
    const northern = groups.find((group) => group.vendorId === 'vendor-a')!
    expect(northern.totalCents).toBe(80_000)
    expect(northern.billIds).toEqual(['a', 'b'])
    expect(northern.numbers).toEqual(['BILL-1001', 'BILL-1002'])
  })

  it('orders suppliers by their oldest bill, so the most pressing is first', () => {
    const groups = groupBySupplier([
      bill({ id: 'a', vendorId: 'vendor-a', vendorName: 'A', dueDate: '2026-09-01' }),
      bill({ id: 'b', vendorId: 'vendor-b', vendorName: 'B', dueDate: '2026-07-01' }),
    ])

    expect(groups.map((group) => group.vendorId)).toEqual(['vendor-b', 'vendor-a'])
    expect(groups[0].earliestDue).toBe('2026-07-01')
  })

  it('takes the earliest due date across a supplier’s bills', () => {
    const [group] = groupBySupplier([
      bill({ id: 'a', dueDate: '2026-09-01' }),
      bill({ id: 'b', dueDate: '2026-07-15' }),
    ])

    expect(group.earliestDue).toBe('2026-07-15')
  })

  it('has nothing to group when nothing is chosen', () => {
    expect(groupBySupplier([])).toEqual([])
  })
})

describe('planning a run', () => {
  it('totals what the run costs and what is left', () => {
    const verdict = planRun({
      chosen: [bill({ id: 'a', balanceCents: 50_000 }), bill({ id: 'b', balanceCents: 30_000 })],
      availableCents: 200_000,
    })

    expect(verdict.totalCents).toBe(80_000)
    expect(verdict.remainingCents).toBe(120_000)
    expect(verdict.covered).toBe(true)
    expect(verdict.warning).toBeNull()
  })

  /**
   * A shortfall is a warning, never a refusal. The ledger balance is not the
   * bank's — a cheque written last week may not have cleared — and refusing on
   * it would stop a business paying its suppliers over a timing difference.
   */
  it('warns about a shortfall rather than refusing', () => {
    const verdict = planRun({
      chosen: [bill({ balanceCents: 500_000 })],
      availableCents: 200_000,
    })

    expect(verdict.covered).toBe(false)
    expect(verdict.remainingCents).toBe(-300_000)
    expect(verdict.warning).toContain('not the bank')
  })

  it('says nothing about coverage when no account has been chosen yet', () => {
    const verdict = planRun({ chosen: [bill()], availableCents: null })

    expect(verdict.covered).toBe(true)
    expect(verdict.warning).toBeNull()
    expect(verdict.totalCents).toBe(120_000)
  })

  it('is exactly covered without complaining', () => {
    const verdict = planRun({
      chosen: [bill({ balanceCents: 200_000 })],
      availableCents: 200_000,
    })

    expect(verdict.covered).toBe(true)
    expect(verdict.remainingCents).toBe(0)
    expect(verdict.warning).toBeNull()
  })
})

describe('the order a payment applies in', () => {
  /**
   * The whole point of the phase. Within what somebody chose, oldest first is
   * what a supplier expects — but a bill nobody ticked is never touched, which
   * is what the old oldest-first-across-everything could not promise.
   */
  it('is oldest first, among the ones chosen', () => {
    const ordered = applicationOrder([
      bill({ id: 'c', number: 'BILL-1003', dueDate: '2026-09-01' }),
      bill({ id: 'a', number: 'BILL-1001', dueDate: '2026-07-01' }),
      bill({ id: 'b', number: 'BILL-1002', dueDate: '2026-08-01' }),
    ])

    expect(ordered.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a tie on the number, so the order is stable', () => {
    const ordered = applicationOrder([
      bill({ id: 'b', number: 'BILL-1002', dueDate: '2026-08-01' }),
      bill({ id: 'a', number: 'BILL-1001', dueDate: '2026-08-01' }),
    ])

    expect(ordered.map((row) => row.number)).toEqual(['BILL-1001', 'BILL-1002'])
  })

  it('leaves the caller’s array alone', () => {
    const input = [bill({ id: 'b', dueDate: '2026-09-01' }), bill({ id: 'a', dueDate: '2026-07-01' })]
    applicationOrder(input)
    expect(input.map((row) => row.id)).toEqual(['b', 'a'])
  })
})

describe('daysBetween', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-08-01', '2026-08-15')).toBe(14)
    expect(daysBetween('2026-08-15', '2026-08-01')).toBe(-14)
  })

  it('is right across a month end and a leap day', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)
  })
})
