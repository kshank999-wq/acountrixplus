import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { listCustomerSummaries, listVendorSummaries } from '@/modules/parties/service'
import { putRate } from '@/modules/fx/service'
import { createVendorCredit } from '@/modules/receivables/vendor-credits'

/**
 * What the customers and suppliers screen says a party owes (Phase 56).
 *
 * Two claims under test, and both were live defects on the demo books:
 *
 *  1. **The figure is in the home currency.** It summed `balance_cents` — the
 *     face amount — so a customer with a €2,500 invoice was shown "$2,500.00".
 *     Phase 35 fixed this exact bug in `customersWithBalances` and left these
 *     two queries alone.
 *  2. **It nets off what is held.** Phase 53 gave an overpayment a home and
 *     Phase 54 netted it on the statement and the chase; this screen — the one
 *     somebody opens when the customer rings — still showed the gross.
 */

let fixture: Fixture
let revenueId: string
let expenseId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Parties Co' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
})

const customerNamed = async (name: string) =>
  createCustomer(fixture.ctx, { name, email: `${name.replace(/\W/g, '')}@test.test` })

async function anInvoice(
  customerId: string,
  cents: number,
  opts: { currency?: string; dueDate?: string } = {},
) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-01-01',
    dueDate: opts.dueDate ?? '2026-01-31',
    currency: opts.currency,
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
  })
}

const summaryFor = async (id: string) =>
  (await listCustomerSummaries(fixture.ctx)).find((row) => row.id === id)!

describe('what a customer owes', () => {
  it('is the home-currency amount, not the face amount', async () => {
    // €1.00 = $1.0835, the rate Phase 35 stores in millionths.
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-01-01',
      rateMillionths: 1_083_500,
      source: 'manual',
    })

    const customer = await customerNamed('Bremen Hafenbau')
    await anInvoice(customer.id, 250_000, { currency: 'EUR' })

    const summary = await summaryFor(customer.id)

    // The defect: this used to be 250_000, rendered with a dollar sign.
    expect(summary.balanceCents).toBe(270_875)
    expect(summary.hasForeignDocuments).toBe(true)
  })

  /**
   * The case that made the old number meaningless rather than merely wrong: a
   * customer billed in two currencies. Adding face amounts produced, in Phase
   * 35's words, "3,500 of nothing with a dollar sign in front of it".
   */
  it('adds two currencies through the home one', async () => {
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-01-01',
      rateMillionths: 1_083_500,
      source: 'manual',
    })

    const customer = await customerNamed('Both Currencies Ltd')
    await anInvoice(customer.id, 100_000)
    await anInvoice(customer.id, 250_000, { currency: 'EUR' })

    const summary = await summaryFor(customer.id)

    expect(summary.balanceCents).toBe(100_000 + 270_875)
    expect(summary.hasForeignDocuments).toBe(true)
  })

  it('says nothing about foreign documents when there are none', async () => {
    const customer = await customerNamed('Domestic Only')
    await anInvoice(customer.id, 90_000)

    expect((await summaryFor(customer.id)).hasForeignDocuments).toBe(false)
  })

  it('carries the oldest unpaid due date, so the figure has an age', async () => {
    const customer = await customerNamed('Old Debt Ltd')
    await anInvoice(customer.id, 50_000, { dueDate: '2026-03-31' })
    await anInvoice(customer.id, 40_000, { dueDate: '2026-01-15' })

    expect((await summaryFor(customer.id)).oldestDueDate).toBe('2026-01-15')
  })

  it('has no oldest date once everything is settled', async () => {
    const customer = await customerNamed('All Paid Ltd')
    const invoice = await anInvoice(customer.id, 50_000)
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-02-01',
      amountCents: 50_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 50_000 }],
    })

    const summary = await summaryFor(customer.id)
    expect(summary.oldestDueDate).toBeNull()
    expect(summary.balanceCents).toBe(0)
  })
})

describe('what is held against a customer', () => {
  it('reports their overpayment', async () => {
    const customer = await customerNamed('Overpayer Ltd')
    await anInvoice(customer.id, 90_000)
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-02-01',
      amountCents: 60_000,
      financialAccountId: bankId,
      applications: [],
    })

    const summary = await summaryFor(customer.id)

    // The gross stays, so the row can still be tied to the invoices.
    expect(summary.balanceCents).toBe(90_000)
    expect(summary.heldCreditCents).toBe(60_000)
  })

  /**
   * Counted once, not once per open invoice. A join onto the same grouped rows
   * as `invoices` would multiply it — the reason this is a subquery.
   */
  it('counts a credit once however many invoices are open', async () => {
    const customer = await customerNamed('Many Invoices Ltd')
    await anInvoice(customer.id, 30_000)
    await anInvoice(customer.id, 40_000)
    await anInvoice(customer.id, 50_000)
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-02-01',
      amountCents: 200_000,
      financialAccountId: bankId,
      applications: [],
    })

    const summary = await summaryFor(customer.id)

    expect(summary.heldCreditCents).toBe(200_000)
    expect(summary.balanceCents).toBe(120_000)
  })

  it('is nothing for a customer who has not overpaid', async () => {
    const customer = await customerNamed('Straightforward Ltd')
    await anInvoice(customer.id, 90_000)

    expect((await summaryFor(customer.id)).heldCreditCents).toBe(0)
  })

  it('does not leak one customer’s credit onto another', async () => {
    const payer = await customerNamed('Payer Ltd')
    const other = await customerNamed('Other Ltd')
    await anInvoice(payer.id, 10_000)
    await anInvoice(other.id, 90_000)
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: payer.id,
      paymentDate: '2026-02-01',
      amountCents: 50_000,
      financialAccountId: bankId,
      applications: [],
    })

    // The whole receipt is held, because naming no applications applies it to
    // nothing — their own $100 invoice stays open beside it.
    const payerSummary = await summaryFor(payer.id)
    expect(payerSummary.heldCreditCents).toBe(50_000)
    expect(payerSummary.balanceCents).toBe(10_000)

    expect((await summaryFor(other.id)).heldCreditCents).toBe(0)
    expect((await summaryFor(other.id)).balanceCents).toBe(90_000)
  })
})

describe('the supplier side', () => {
  const vendorSummaryFor = async (id: string) =>
    (await listVendorSummaries(fixture.ctx)).find((row) => row.id === id)!

  it('is also the home-currency amount', async () => {
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-01-01',
      rateMillionths: 1_083_500,
      source: 'manual',
    })

    const vendor = await createVendor(fixture.ctx, { name: 'Hamburg Supplies GmbH' })
    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      currency: 'EUR',
      vendorReference: 'HS-1',
      lines: [{ chartAccountId: expenseId, description: 'Steel', unitPriceCents: 100_000 }],
    })

    const summary = await vendorSummaryFor(vendor.id)

    expect(summary.balanceCents).toBe(108_350)
    expect(summary.hasForeignDocuments).toBe(true)
  })

  /**
   * The mirror of a customer's held credit. An unspent vendor credit reduces
   * what the next pay run sends, so the gross overstates what is about to leave
   * the bank — the same untruth, pointing the other way.
   */
  it('reports an unspent vendor credit as held against them', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Cascade Supply' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      vendorReference: 'CS-1',
      lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 100_000 }],
    })

    await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      billId: bill.id,
      issueDate: '2026-01-15',
      reason: 'Short delivery',
      lines: [{ chartAccountId: expenseId, description: 'Short', unitPriceCents: 25_000 }],
    })

    const summary = await vendorSummaryFor(vendor.id)

    expect(summary.balanceCents).toBe(100_000)
    expect(summary.heldCreditCents).toBe(25_000)
  })

  it('is nothing held for a supplier with no credit', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Plain Supplier' })
    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      vendorReference: 'PS-1',
      lines: [{ chartAccountId: expenseId, description: 'Nails', unitPriceCents: 10_000 }],
    })

    expect((await vendorSummaryFor(vendor.id)).heldCreditCents).toBe(0)
  })
})
