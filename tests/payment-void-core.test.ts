import { describe, expect, it } from 'vitest'
import {
  NO_TIES,
  describeUnwind,
  restorationsFor,
  voidability,
  type ClosedPeriod,
  type PaymentTies,
  type VoidablePayment,
} from '@/modules/receivables/payment-void'

/**
 * Taking a payment back (Phase 52).
 *
 * The claim under test: **a payment whose money somebody else has already
 * counted is not ours to unwind.** Banked on a deposit, counted into a closed
 * till, settled at a card processor — each of those is a second record that
 * claims the same money, and putting it back silently breaks whichever one
 * nobody looks at first.
 */

const payment = (over: Partial<VoidablePayment> = {}): VoidablePayment => ({
  id: 'pay-1',
  kind: 'receipt',
  paymentDate: '2026-08-15',
  amountCents: 150_000,
  status: 'posted',
  reference: 'BACS 15 Aug',
  ...over,
})

const ties = (over: Partial<PaymentTies> = {}): PaymentTies => ({ ...NO_TIES, ...over })

const CLOSED: ClosedPeriod[] = [{ periodStart: '2026-01-01', periodEnd: '2026-06-30' }]

const ask = (
  over: Partial<VoidablePayment> = {},
  t: Partial<PaymentTies> = {},
  closedPeriods: ClosedPeriod[] = [],
) => voidability({ payment: payment(over), ties: ties(t), closedPeriods, today: '2026-08-28' })

describe('a payment nothing else has claimed', () => {
  it('goes void, and the ledger entry with it', () => {
    const verdict = ask()

    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.ledger).toBe('void')
    expect(verdict.ok && verdict.why).toContain('goes back to being owed')
  })

  it('is refused twice', () => {
    const verdict = ask({ status: 'void' })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('already been voided')
  })
})

describe('money somebody else has already counted', () => {
  /**
   * The substance of the phase. A banked receipt is money the deposit claims;
   * removing it underneath leaves the deposit adding up to more than it
   * contains, and the bank reconciliation is where somebody finds out.
   */
  it('is refused when the receipt has been banked', () => {
    const verdict = ask({}, { depositNumber: 'DEP-1004' })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('DEP-1004')
    expect(verdict.ok === false && verdict.why).toContain('Void that deposit on the Deposits screen')
  })

  /**
   * A count somebody signed is a statement about a physical drawer. It cannot
   * become retrospectively untrue, so the correction is an adjustment rather
   * than an edit.
   */
  it('is refused when the cash was counted into a closed shift', () => {
    const verdict = ask({}, { shift: { label: 'the Friday evening shift', closed: true } })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('the Friday evening shift')
    expect(verdict.ok === false && verdict.why).toContain('post an adjustment')
  })

  /** An open shift has not been counted yet, so there is nothing to contradict. */
  it('is allowed while that shift is still open', () => {
    expect(ask({}, { shift: { label: 'the Friday evening shift', closed: false } }).ok).toBe(true)
  })

  it('is refused when the card processor has settled it', () => {
    const verdict = ask({}, { settledAtProcessor: true })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('Refund it through the processor')
  })

  /**
   * The other direction of Phase 51's rule: a cancelled document must not come
   * back owing money.
   */
  it('is refused when a document it settled has since been voided', () => {
    const verdict = ask({}, { voidedDocuments: ['INV-1002'] })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('INV-1002')
    expect(verdict.ok === false && verdict.why).toContain('cancelled document')
  })

  it('stops listing voided documents after three', () => {
    const verdict = ask({}, { voidedDocuments: ['A', 'B', 'C', 'D', 'E'] })
    expect(verdict.ok === false && verdict.why).toContain('A, B, C and 2 more')
  })
})

describe('a payment in a closed period', () => {
  /**
   * Phase 51's rule, applied rather than re-decided. Voiding an entry inside a
   * closed period silently changes numbers somebody has already given to a
   * bank; the reversal shows the correction where it can be seen.
   */
  it('is reversed in the ledger rather than voided', () => {
    const verdict = ask({ paymentDate: '2026-03-15' }, {}, CLOSED)

    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.ledger).toBe('reverse')
    expect(verdict.ok && verdict.ledger === 'reverse' && verdict.reversalDate).toBe('2026-08-28')
    expect(verdict.ok && verdict.why).toContain('does not change quietly')
  })

  it('is refused outright when today is closed too', () => {
    const everything: ClosedPeriod[] = [{ periodStart: '2026-01-01', periodEnd: '2026-12-31' }]
    const verdict = ask({ paymentDate: '2026-03-15' }, {}, everything)

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('Reopen a period first')
  })

  /**
   * A deposit outranks a closed period. Both are true, and "the bank has this
   * money" is the more useful thing to be told first.
   */
  it('reports the deposit rather than the closed period when both apply', () => {
    const verdict = ask({ paymentDate: '2026-03-15' }, { depositNumber: 'DEP-1004' }, CLOSED)
    expect(verdict.ok === false && verdict.why).toContain('DEP-1004')
  })
})

describe('what goes back onto each document', () => {
  it('puts the whole of it back when nothing else was paid', () => {
    const [row] = restorationsFor([
      { documentId: 'i1', number: 'INV-1002', amountCents: 90_000, balanceCents: 0, totalCents: 90_000 },
    ])

    expect(row.balanceAfterCents).toBe(90_000)
    expect(row.status).toBe('open')
  })

  /**
   * `partial`, not `open`, when another payment is still against it — and never
   * back to `draft`. A document that was issued and part-paid was still issued,
   * and rewinding it to draft would take it off the aging report a business
   * works from every Friday.
   */
  it('leaves a document that another payment also settled as partial', () => {
    const [row] = restorationsFor([
      { documentId: 'i1', number: 'INV-1002', amountCents: 40_000, balanceCents: 0, totalCents: 90_000 },
    ])

    expect(row.balanceAfterCents).toBe(40_000)
    expect(row.status).toBe('partial')
  })

  it('reads back as open when the restored balance is the whole total', () => {
    const [row] = restorationsFor([
      { documentId: 'i1', number: 'INV-1002', amountCents: 50_000, balanceCents: 40_000, totalCents: 90_000 },
    ])

    expect(row.balanceAfterCents).toBe(90_000)
    expect(row.status).toBe('open')
  })
})

describe('telling somebody what the void will do', () => {
  it('names the documents and the total', () => {
    const sentence = describeUnwind(
      restorationsFor([
        { documentId: 'a', number: 'INV-1002', amountCents: 90_000, balanceCents: 0, totalCents: 90_000 },
        { documentId: 'b', number: 'INV-1003', amountCents: 60_000, balanceCents: 0, totalCents: 60_000 },
      ]),
    )

    expect(sentence).toContain('1500.00')
    expect(sentence).toContain('2 documents')
    expect(sentence).toContain('INV-1002, INV-1003')
  })

  it('reads correctly for one', () => {
    const sentence = describeUnwind(
      restorationsFor([
        { documentId: 'a', number: 'INV-1002', amountCents: 90_000, balanceCents: 0, totalCents: 90_000 },
      ]),
    )
    expect(sentence).toContain('1 document ')
  })

  it('has something to say about a payment that settled nothing', () => {
    expect(describeUnwind([])).toContain('settled nothing')
  })
})
