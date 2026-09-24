import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import { contractorPayments } from '@/modules/payroll/vendor-reporting'
import { createTaxCode, recordDocumentTax, salesTaxReturn, taxOn } from '@/modules/payroll/sales-tax'
import { cashBasisCaveats } from '@/modules/ledger/cash-basis'
import { BLIND_FACE_SUMS } from '@/modules/fx/comparable'

/**
 * Three sums that added two currencies (Phase 143, repaired in Phase 152).
 *
 * ## This file was skipped for nine phases, on purpose
 *
 * All three were registered in `BLIND_FACE_SUMS` with what was wrong in each,
 * and left unrepaired because the staging pass was holding live service paths.
 * Phase 151 lifted that hold. This is the test the register pointed at, and it
 * now runs.
 *
 * ## Why they were invisible rather than excused
 *
 * `FACE_COLUMNS` was seventeen column names typed by hand. The schema has
 * **fifty-four** money columns on currency-carrying tables, and all three of
 * these summed one of the thirty-seven nobody had classified — so the tripwire
 * that says "no sum adds two currencies together" never looked at them. An
 * excused site has an argument somebody can disagree with; an unseen one has
 * nothing.
 *
 * ## The three repairs are not the same repair
 *
 * - **`contractorPayments`** and **`salesTaxReturn`** convert each document at
 *   the rate it was raised at and add the results, through `functionalSumSql`.
 *   Both are filed with a tax authority.
 * - **`cashBasisCaveats`** does not convert. Its sum was read only as `> 0` —
 *   a presence test, whose message prints no figure — so it counts rows now.
 *   `faceSumStands` is the pure statement of that distinction, and the sibling
 *   query three lines above it in the same function had already reached the
 *   same answer for the same reason.
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

describe('contractorPayments, which decides whether a 1099 is filed', () => {
  it('does not count a euro paid as though it were a dollar', async () => {
    // €600 paid to a contractor is $660 at the rate it was paid at, and the
    // threshold is a US dollar figure. Before Phase 152 the report compared
    // 60,000 against 60,000 and called it exactly at the threshold; it is over
    // it, and by enough that the rounding is not what decides.
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
    // that keeps the repair from moving what already works. A domestic payment
    // carries no rate at all, so this is also the test that the `coalesce` to
    // `RATE_ONE` inside `functionalSumSql` is the identity and not a zero.
    const vendor = await createVendor(fixture.ctx, {
      name: 'Harborview Trades',
      is1099Vendor: true,
    })

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

  it('reports a vendor who was paid nothing at zero rather than dropping them', async () => {
    // The left join leaves both the amount and the rate null. `coalesce` on
    // the rate would not save a sum that then multiplied null; the outer
    // `coalesce` on the total is what does.
    await createVendor(fixture.ctx, { name: 'Quiet Partners', is1099Vendor: true })

    const report = await contractorPayments(fixture.ctx, { year: 2026, thresholdCents: 60_000 })
    const row = report.rows.find((entry) => entry.vendorName === 'Quiet Partners')

    expect(row?.paidCents).toBe(0)
    expect(row?.meetsThreshold).toBe(false)
  })
})

describe('salesTaxReturn, which is filed with a tax authority', () => {
  it('does not add a euro invoice to a dollar one', async () => {
    const stateTax = await createTaxCode(fixture.ctx, {
      code: 'STATE',
      name: 'State sales tax',
      jurisdiction: 'State',
      rateBp: 400,
    })

    const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })
    const foreign = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      currency: 'EUR',
      taxCents: taxOn(100_000, 400),
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })
    await recordDocumentTax(fixture.ctx, {
      documentType: 'invoice',
      documentId: foreign.id,
      documentDate: '2026-03-01',
      lines: [{ taxCodeId: stateTax.id, taxableCents: 100_000 }],
    })

    const domestic = await createCustomer(fixture.ctx, { name: 'Harborview Homes' })
    const home = await createInvoice(fixture.ctx, {
      customerId: domestic.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      taxCents: taxOn(100_000, 400),
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })
    await recordDocumentTax(fixture.ctx, {
      documentType: 'invoice',
      documentId: home.id,
      documentDate: '2026-03-01',
      lines: [{ taxCodeId: stateTax.id, taxableCents: 100_000 }],
    })

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })

    // €1,000 is $1,100, so taxable sales are $2,100 — not "200000".
    expect(report.totalTaxableCents).toBe(210_000)
    // And the tax collected on them: €40 is $44, plus $40.
    expect(report.totalTaxCollectedCents).toBe(8_400)
  })

  it('converts the uncoded sales printed beside the taxable ones', async () => {
    // The register named `invoices.subtotal_cents`, and this is the figure it
    // actually feeds — the one for sales carrying no tax breakdown at all. It
    // is printed next to taxable sales, so a euro invoice in one and not the
    // other is two numbers that cannot be compared.
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

    expect(report.hasUncodedSales).toBe(true)
    expect(report.uncodedSalesCents).toBe(210_000)
  })
})

describe('cashBasisCaveats, which describes rather than decides', () => {
  it('raises the sales tax caveat from a euro invoice, having added nothing', async () => {
    // The least severe of the three and the one that needed no conversion.
    // Its sum of `invoices.tax_cents` was read only as `> 0` and the message
    // prints no figure, so it counts the invoices that charged tax. A euro
    // invoice is one of those whatever the rate is.
    const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      currency: 'EUR',
      taxCents: taxOn(100_000, 400),
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })

    const caveats = await cashBasisCaveats(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(caveats.map((caveat) => caveat.area)).toContain('Sales tax')
    // And it still says nothing that would have to be in a currency.
    const salesTax = caveats.find((caveat) => caveat.area === 'Sales tax')!
    expect(salesTax.message).not.toMatch(/\d/)
  })

  it('raises no sales tax caveat when no invoice charged any', async () => {
    // A caveat computed from the data rather than printed as boilerplate is
    // only worth the claim if it can come back absent. Before Phase 152 this
    // was a sum of zeros; it is now a count of no rows, and the same sentence
    // has to hold.
    const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-04-01',
      currency: 'EUR',
      lines: [{ chartAccountId: revenueId, description: 'Goods', unitPriceCents: 100_000 }],
    })

    const caveats = await cashBasisCaveats(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(caveats.map((caveat) => caveat.area)).not.toContain('Sales tax')
  })
})

describe('the register these three were held on', () => {
  it('is empty, and this file is why', async () => {
    // Phase 139's device: an indictment points at the test that says when it
    // is spent. Emptying the register without this file running would be the
    // half of the pair that cannot be checked — ADR 0141's split, where the
    // half that could excuse a site is the half that must be measurable.
    expect(BLIND_FACE_SUMS).toHaveLength(0)
  })
})
