import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { applyCredit, refundCredit } from '@/modules/receivables/customer-credit'
import { listCustomerSummaries } from '@/modules/parties/service'
import { putRate } from '@/modules/fx/service'
import { convert } from '@/modules/fx/rates'

/**
 * The credit netted against a converted balance (Phase 65).
 *
 * The customers screen summed `invoices.functional_balance_cents` — converted —
 * and `payments.unapplied_cents` — not — and Phase 54 netted one against the
 * other. `recordPayment` had what closes it all along: the rate on the line
 * after the currency Phase 62 kept, and the functional held amount computed
 * outright and thrown away.
 */

let fixture: Fixture
let revenueId: string
let bankId: string

/** 1.0835 — enough decimals that a face amount and a converted one differ. */
const RATE = 1_083_500

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Holdings Co' })
  revenueId = (await fixture.account('4000')).id
  bankId = fixture.financialAccountId

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: RATE,
    source: 'manual',
  })
})

async function euroInvoice(customerId: string, cents: number) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
  })
}

describe('what a receipt keeps', () => {
  it('stores the rate it was taken at', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await euroInvoice(customer.id, 400_000)

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 450_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.currency).toBe('EUR')
    expect(row.exchangeRateMillionths).toBe(RATE)
  })

  /**
   * The substance. €500 held is $541.75 of the company's money, and the screens
   * that net it against a converted balance need the second number.
   */
  it('stores what the leftover is worth in the company’s own money', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await euroInvoice(customer.id, 400_000)

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 450_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.unappliedCents).toBe(50_000)
    // `received - applied`, not a conversion of the difference: the receipt's
    // entry splits the money that arrived, so the halves must add back to it.
    expect(row.functionalUnappliedCents).toBe(
      convert(450_000, RATE) - convert(400_000, RATE),
    )
  })

  it('leaves a domestic receipt with the two the same number', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 100_000 }],
    })

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 130_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.exchangeRateMillionths).toBe(1_000_000)
    expect(row.functionalUnappliedCents).toBe(row.unappliedCents)
  })
})

describe('spending and refunding what is held', () => {
  async function heldEuroReceipt() {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await euroInvoice(customer.id, 400_000)

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 450_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    return { customer, payment }
  }

  /**
   * Both halves move together, or the screen offers credit the business does
   * not have — the defect Phase 63's browser check found on credit notes, one
   * table over.
   */
  it('takes both halves down when the credit is spent', async () => {
    const { customer, payment } = await heldEuroReceipt()
    const next = await euroInvoice(customer.id, 30_000)

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: next.id,
      amountCents: 30_000,
      appliedOn: '2026-06-20',
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.unappliedCents).toBe(20_000)
    expect(row.functionalUnappliedCents).toBeGreaterThan(20_000)
    expect(row.functionalUnappliedCents).toBeLessThan(30_000)
  })

  it('reaches zero on both halves on the last draw', async () => {
    const { customer, payment } = await heldEuroReceipt()
    const next = await euroInvoice(customer.id, 50_000)

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: next.id,
      amountCents: 50_000,
      appliedOn: '2026-06-20',
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.unappliedCents).toBe(0)
    // Nothing stranded: the last draw takes whatever functional remainder is
    // left, which is the rule the invoice and the credit note already use.
    expect(row.functionalUnappliedCents).toBe(0)
  })

  it('releases both halves on a refund', async () => {
    const { payment } = await heldEuroReceipt()

    await refundCredit(fixture.ctx, {
      paymentId: payment.id,
      amountCents: 50_000,
      refundedOn: '2026-06-20',
      financialAccountId: bankId,
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.unappliedCents).toBe(0)
    expect(row.functionalUnappliedCents).toBe(0)
  })
})

describe('the customers screen', () => {
  /**
   * ADR 0062's example, end to end. A €500 overpayment on a €4,000 invoice was
   * shown as 500 against a converted $4,334.00 — subtracting euro from dollars.
   */
  it('nets a euro overpayment against the balance in one currency', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await euroInvoice(customer.id, 400_000)
    const second = await euroInvoice(customer.id, 200_000)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 450_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    const [row] = (await listCustomerSummaries(fixture.ctx)).filter(
      (party) => party.id === customer.id,
    )

    // The second invoice is what is still open, carried at its own rate.
    expect(row.balanceCents).toBe(convert(200_000, RATE))
    // And the held credit is the converted €500, not a bare 50_000.
    expect(row.heldCreditCents).toBe(convert(450_000, RATE) - convert(400_000, RATE))
    expect(row.heldCreditCents).not.toBe(50_000)
    expect(second.currency).toBe('EUR')
  })

  it('says what the converted figure stands for', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await euroInvoice(customer.id, 400_000)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 450_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    const [row] = (await listCustomerSummaries(fixture.ctx)).filter(
      (party) => party.id === customer.id,
    )

    expect(row.heldCreditNote).toContain('€500.00 held')
    expect(row.heldCreditNote).toContain('repayable in the currency it came in')
  })

  /** Nothing to explain when it is all in the company's own money. */
  it('says nothing extra about a domestic overpayment', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 100_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-15',
      amountCents: 130_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const [row] = (await listCustomerSummaries(fixture.ctx)).filter(
      (party) => party.id === customer.id,
    )

    expect(row.heldCreditCents).toBe(30_000)
    expect(row.heldCreditNote).toBeNull()
  })
})
