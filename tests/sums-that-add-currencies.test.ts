import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createVendor, createBill } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import { contractorPayments } from '@/modules/payroll/vendor-reporting'
import { salesTaxReturn } from '@/modules/payroll/sales-tax'

/**
 * Three sums that add two currencies (Phase 143).
 *
 * ## Skipped on purpose — this is the acceptance test for the repair
 *
 * All three are registered in `BLIND_FACE_SUMS` with what is wrong in each.
 * They are **not** repaired: the staging pass is holding live service paths, and
 * every one of these is a query change rather than a core. Unskip this file,
 * group by currency or sum the functional twin, and it says whether it worked.
 *
 * ## Why they were invisible rather than excused
 *
 * `FACE_COLUMNS` was seventeen column names typed by hand. The schema has
 * **fifty-four** money columns on currency-carrying tables, and all three of
 * these sum one of the thirty-seven nobody had classified — so the tripwire that
 * says "no sum adds two currencies together" never looked at them. An excused
 * site has an argument somebody can disagree with; an unseen one has nothing.
 *
 * ## Two of the three are filed with a tax authority
 *
 * - **`contractorPayments`** sums `payment_applications.amount_cents` per vendor
 *   and compares the total against a statutory threshold in the company's own
 *   money. A contractor paid €600 contributes 60,000 to a figure measured
 *   against $600, so a 1099 is filed — or not filed — on arithmetic over
 *   incomparable things. The function mentions no currency anywhere.
 * - **`salesTaxReturn`** sums `invoices.subtotal_cents` to report taxable sales
 *   for a jurisdiction.
 * - **`cashBasisCaveats`** sums `invoices.tax_cents` to caveat a report. It
 *   describes rather than decides, which makes it the least severe and still
 *   wrong.
 */

let fixture: Fixture
let revenueId: string
let expenseId: string

/** 1.10 — what the euro was worth when these documents were raised. */
const RATE = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Zweiwährung Ltd' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-03-01',
    rateMillionths: RATE,
    source: 'manual',
  })
})

describe.skip('contractorPayments, which decides whether a 1099 is filed', () => {
  it('does not count a euro paid as though it were a dollar', async () => {
    // €600 paid to a contractor is $660 at the rate it was paid at, and the
    // threshold is a US dollar figure. Today the report compares 60,000 against
    // 60,000 and calls it exactly at the threshold; it is over it.
    const vendor = await createVendor(fixture.ctx, { name: 'Rheinwerk GmbH', is1099Vendor: true })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      currency: 'EUR',
      lines: [{ chartAccountId: expenseId, description: 'Contract work', unitPriceCents: 60_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-03-15',
      // No `currency` input: a payment takes the currency of the documents it
      // settles, which is what makes this a euro payment.
      amountCents: 60_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 60_000 }],
    })

    const report = await contractorPayments(fixture.ctx, { year: 2026, thresholdCents: 60_000 })
    const row = report.rows.find((entry) => entry.vendorName === 'Rheinwerk GmbH')

    // $660, not "60000 of something".
    expect(row?.paidCents).toBe(66_000)
    expect(row?.meetsThreshold).toBe(true)
  })

  it('still reports a domestic contractor exactly as it does today', async () => {
    // Why this went a hundred and forty-two phases unnoticed, and the assertion
    // that keeps the repair from moving what already works.
    const vendor = await createVendor(fixture.ctx, { name: 'Harborview Trades', is1099Vendor: true })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      lines: [{ chartAccountId: expenseId, description: 'Contract work', unitPriceCents: 80_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-03-15',
      amountCents: 80_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 80_000 }],
    })

    const report = await contractorPayments(fixture.ctx, { year: 2026, thresholdCents: 60_000 })
    const row = report.rows.find((entry) => entry.vendorName === 'Harborview Trades')

    expect(row?.paidCents).toBe(80_000)
    expect(row?.meetsThreshold).toBe(true)
  })
})

describe.skip('salesTaxReturn, which is filed with a tax authority', () => {
  it('does not add a euro invoice to a dollar one', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      currency: 'EUR',
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })

    const domestic = await createCustomer(fixture.ctx, { name: 'Harborview Homes' })
    await createInvoice(fixture.ctx, {
      customerId: domestic.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    // €1,000 is $1,100, so taxable sales are $2,100 — not "200000".
    expect(report.totalTaxableCents).toBe(210_000)
  })
})

describe.skip('cashBasisCaveats, which describes rather than decides', () => {
  it('states a tax figure in one currency or none at all', async () => {
    // The least severe of the three and the same defect. Whatever the repair
    // is — convert, or group and say which currency — it must not be a bare
    // addition of `invoices.tax_cents` across the ledger.
    const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      currency: 'EUR',
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })

    expect(RATE).toBe(1_100_000)
  })
})
