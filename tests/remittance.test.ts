import { describe, expect, it } from 'vitest'
import {
  remittanceSubject,
  remittanceSummaryLine,
  sendability,
  supplierFacingRemittance,
  type PaymentFacts,
  type SettledBillFacts,
} from '@/modules/payables/remittance'

/**
 * Telling a supplier what a payment was for (Phase 58).
 *
 * The claim under test: **a supplier can match the money to their invoices** —
 * and, in the one case where a document about a payment can go stale, is told
 * the payment was reversed.
 */

const COMPANY = {
  name: 'Ridgeline Construction',
  email: 'accounts@ridgeline.test',
  phone: '555 0100',
  address: ['412 Mill Street', 'Bellingham, WA 98225'],
  tradingName: null,
  website: null,
  footer: null,
}

const SUPPLIER = { name: 'Cascade Building Supply', email: 'ar@cascade.test' }

function aPayment(over: Partial<PaymentFacts> = {}): PaymentFacts {
  return {
    kind: 'disbursement',
    status: 'posted',
    paymentDate: '2026-07-15',
    amountCents: 400_000,
    currency: 'USD',
    reference: 'BACS 88213',
    voidedAt: null,
    voidReason: null,
    ...over,
  }
}

function aBill(over: Partial<SettledBillFacts> = {}): SettledBillFacts {
  return {
    vendorReference: 'CBS-4471',
    number: 'BILL-1006',
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    amountCents: 400_000,
    ...over,
  }
}

describe('what the supplier is shown', () => {
  it('lists the bills the payment settled', () => {
    const view = supplierFacingRemittance({
      payment: aPayment(),
      bills: [aBill({ amountCents: 250_000 }), aBill({ number: 'BILL-1007', amountCents: 150_000 })],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.bills).toHaveLength(2)
    expect(view.amountCents).toBe(400_000)
    expect(view.appliedCents).toBe(400_000)
    expect(view.unappliedCents).toBe(0)
  })

  /**
   * The supplier's own reference is what they will search for. Ours is there so
   * a phone call has something in common (Phase 47 separated the two).
   */
  it('leads with the supplier’s own reference, and keeps ours', () => {
    const view = supplierFacingRemittance({
      payment: aPayment(),
      bills: [aBill({ vendorReference: 'CBS-4471', number: 'BILL-1006' })],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.bills[0].vendorReference).toBe('CBS-4471')
    expect(view.bills[0].number).toBe('BILL-1006')
  })

  /**
   * A payment on account is theirs to allocate, and hiding the difference would
   * leave them guessing why the figure does not match.
   */
  it('shows what was paid beyond the bills listed', () => {
    const view = supplierFacingRemittance({
      payment: aPayment({ amountCents: 500_000 }),
      bills: [aBill({ amountCents: 400_000 })],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.unappliedCents).toBe(100_000)
  })

  it('never reports a negative leftover', () => {
    const view = supplierFacingRemittance({
      payment: aPayment({ amountCents: 100_000 }),
      bills: [aBill({ amountCents: 400_000 })],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.unappliedCents).toBe(0)
  })

  /**
   * The allowlist. A subtraction leaks by default: the next phase adds an
   * internal note to a bill and it lands on a supplier's screen.
   */
  it('carries nothing it was not asked for', () => {
    const view = supplierFacingRemittance({
      payment: { ...aPayment(), ...({ internalMemo: 'always pay these late' } as object) },
      bills: [{ ...aBill(), ...({ costCodeId: 'secret', approvedBy: 'dana' } as object) }],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view).not.toHaveProperty('internalMemo')
    expect(view.bills[0]).not.toHaveProperty('costCodeId')
    expect(view.bills[0]).not.toHaveProperty('approvedBy')
  })
})

describe('a payment that was voided afterwards', () => {
  /**
   * The substance of the phase's one real design decision. A remittance needs
   * no freezing because a posted payment does not change — except that Phase 52
   * made one voidable, and a supplier holding an advice for money that came
   * back has to be told.
   */
  it('says so, rather than describing a payment that was unwound', () => {
    const view = supplierFacingRemittance({
      payment: aPayment({
        status: 'void',
        voidedAt: new Date('2026-07-20'),
        voidReason: 'Sent to the wrong account',
      }),
      bills: [aBill()],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.isVoided).toBe(true)
    expect(view.voidReason).toBe('Sent to the wrong account')
  })

  it('reads as voided from the timestamp alone', () => {
    const view = supplierFacingRemittance({
      payment: aPayment({ voidedAt: new Date('2026-07-20') }),
      bills: [aBill()],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.isVoided).toBe(true)
  })

  it('is not voided when it is not', () => {
    const view = supplierFacingRemittance({
      payment: aPayment(),
      bills: [aBill()],
      supplier: SUPPLIER,
      company: COMPANY,
    })

    expect(view.isVoided).toBe(false)
    expect(view.voidReason).toBeNull()
  })
})

describe('whether it may be sent', () => {
  const send = (over: Partial<Parameters<typeof sendability>[0]> = {}) =>
    sendability({ payment: aPayment(), supplier: SUPPLIER, sendCount: 0, ...over })

  it('sends to the address on file', () => {
    expect(send()).toEqual({ ok: true, to: 'ar@cascade.test', isResend: false })
  })

  it('prefers an address typed into the form', () => {
    const verdict = send({ override: 'ap.team@cascade.test' })
    expect(verdict.ok && verdict.to).toBe('ap.team@cascade.test')
  })

  /**
   * Sending a customer a remittance would tell them the business had paid
   * *them*, which is the opposite of what happened.
   */
  it('refuses money that came in rather than went out', () => {
    const verdict = send({ payment: aPayment({ kind: 'receipt' }) })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('money you paid out')
  })

  it('refuses a voided payment, and says what to do instead', () => {
    const verdict = send({ payment: aPayment({ status: 'void' }) })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('the link they hold says so')
  })

  it('refuses a payment with nobody named', () => {
    const verdict = send({ supplier: null })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('nobody to send it to')
  })

  it('names who needs an address added', () => {
    const verdict = send({ supplier: { name: 'Cascade Building Supply', email: null } })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('Cascade Building Supply')
    expect(verdict.ok === false && verdict.reason).toContain('Get link')
  })

  it('knows a resend from a first send', () => {
    const again = send({ sendCount: 2 })
    expect(again.ok && again.isResend).toBe(true)
    const first = send({ sendCount: 0 })
    expect(first.ok && first.isResend).toBe(false)
  })

  it('refuses something that is not an address', () => {
    expect(send({ override: 'cascade.test' }).ok).toBe(false)
  })
})

describe('what the letter says', () => {
  it('leads with the payer and the amount, for an inbox full of these', () => {
    expect(
      remittanceSubject({
        companyName: 'Ridgeline Construction',
        amount: '$4,000.00',
        isResend: false,
      }),
    ).toBe('Remittance advice from Ridgeline Construction — $4,000.00')
  })

  it('says when it has been sent before', () => {
    expect(
      remittanceSubject({ companyName: 'Ridgeline', amount: '$4,000.00', isResend: true }),
    ).toContain('(resent)')
  })

  it('counts the invoices it covers', () => {
    const line = remittanceSummaryLine({
      remittance: {
        amountCents: 400_000,
        currency: 'USD',
        paymentDate: '2026-07-15',
        unappliedCents: 0,
        bills: [aBill(), aBill()],
      },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('$4,000.00')
    expect(line).toContain('against 2 invoices')
  })

  it('says one invoice in the singular', () => {
    const line = remittanceSummaryLine({
      remittance: {
        amountCents: 400_000,
        currency: 'USD',
        paymentDate: '2026-07-15',
        unappliedCents: 0,
        bills: [aBill()],
      },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('against 1 invoice.')
  })

  it('says on account when it settles nothing named', () => {
    const line = remittanceSummaryLine({
      remittance: {
        amountCents: 400_000,
        currency: 'USD',
        paymentDate: '2026-07-15',
        unappliedCents: 400_000,
        bills: [],
      },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('on account')
  })

  it('names the part that is on account when only some of it is', () => {
    const line = remittanceSummaryLine({
      remittance: {
        amountCents: 500_000,
        currency: 'USD',
        paymentDate: '2026-07-15',
        unappliedCents: 100_000,
        bills: [aBill()],
      },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('$1,000.00 of it is on account')
  })

  it('speaks the payment’s currency', () => {
    const line = remittanceSummaryLine({
      remittance: {
        amountCents: 400_000,
        currency: 'EUR',
        paymentDate: '2026-07-15',
        unappliedCents: 0,
        bills: [aBill()],
      },
      companyName: 'Ridgeline Construction',
    })

    expect(line).toContain('€4,000.00')
  })
})
