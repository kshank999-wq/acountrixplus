import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, createVendor, createBill } from '@/modules/receivables/service'
import { createCreditNote } from '@/modules/receivables/credits'
import { arAging, apAging } from '@/modules/ledger/reports'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { foreignNote } from '@/modules/ledger/aging'
import { db } from '@/db'
import { exchangeRates } from '@/db/schema'

/**
 * The aging report against the books it summarises (Phase 107).
 *
 * The measured failure: on the development database, Bremen Hafenbau GmbH is
 * invoiced €2,500.00 — worth $2,708.75 — and their aging row read 250000,
 * rendered by a `formatCents` with no currency as **$2,500.00**. The report
 * total was 4,979,194 where the receivables control account said 4,940,069.
 *
 * The claim at the bottom of this file is the one worth having: once aging uses
 * the same figure the ledger does, the two reports differ by exactly the
 * unapplied credits — which is a difference between two questions, and is now
 * stated on the report rather than left for somebody to discover.
 */

describe('against the database', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Aging Report Co' })
    // 1 EUR = 1.0835 USD, the rate the development seed uses.
    await db.insert(exchangeRates).values({
      companyId: fixture.companyId,
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rateDate: '2026-03-01',
      rateMillionths: 1_083_500,
      source: 'manual',
    })
  })

  const invoiceFor = async (opts: {
    name: string
    cents: number
    currency?: string
    dueDate?: string
  }) => {
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: opts.name })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: opts.dueDate ?? '2026-03-31',
      currency: opts.currency,
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: opts.cents }],
    })
    return { revenue, customer, invoice }
  }

  it('ages what a euro invoice is worth, not what it says', async () => {
    await invoiceFor({ name: 'Bremen Hafenbau GmbH', cents: 250_000, currency: 'EUR' })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })

    // 250000 * 1.0835. The old report said 250000.
    expect(aging.totals.totalCents).toBe(270_875)
    expect(aging.rows[0].totalCents).toBe(270_875)
  })

  it('says what that customer was actually invoiced', async () => {
    // Without this, fixing the arithmetic sets a new trap: somebody reads
    // $2,708.75 off the report and asks Bremen for it.
    await invoiceFor({ name: 'Bremen Hafenbau GmbH', cents: 250_000, currency: 'EUR' })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })

    expect(foreignNote(aging.rows[0])).toBe('Invoiced €2,500.00')
  })

  it('names the currency the report is in', async () => {
    await invoiceFor({ name: 'Harborview LLC', cents: 100_000 })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })
    expect(aging.currency).toBe('USD')
  })

  it('leaves a home-currency customer with nothing extra to say', async () => {
    await invoiceFor({ name: 'Harborview LLC', cents: 100_000 })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })

    expect(aging.rows[0].foreign).toEqual([])
    expect(foreignNote(aging.rows[0])).toBeUndefined()
  })

  it('adds a euro invoice and a dollar one into one honest total', async () => {
    await invoiceFor({ name: 'Harborview LLC', cents: 100_000 })
    await invoiceFor({ name: 'Bremen Hafenbau GmbH', cents: 250_000, currency: 'EUR' })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })

    // The old sum was 100000 + 250000 = 350000: a number in no currency.
    expect(aging.totals.totalCents).toBe(370_875)
  })

  it('ages bills the same way', async () => {
    const expense = await fixture.account('6000')
    const vendor = await createVendor(fixture.ctx, { name: 'Bremen Werkzeug GmbH' })
    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      currency: 'EUR',
      lines: [{ chartAccountId: expense.id, description: 'Parts', unitPriceCents: 200_000 }],
    })

    const aging = await apAging(fixture.ctx, { asOfDate: '2026-04-15' })

    expect(aging.totals.totalCents).toBe(216_700)
    expect(foreignNote(aging.rows[0])).toBe('Invoiced €2,000.00')
  })

  it('puts an overdue foreign invoice in the right bucket, at the right value', async () => {
    await invoiceFor({
      name: 'Bremen Hafenbau GmbH',
      cents: 250_000,
      currency: 'EUR',
      dueDate: '2026-01-01',
    })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })

    expect(aging.totals.d90_plus).toBe(270_875)
    expect(aging.totals.current).toBe(0)
  })
})

describe('the aging report and the balance sheet', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Reconciling Co' })
  })

  const openInvoice = async (name: string, cents: number) => {
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: cents }],
    })
    return { revenue, customer, invoice }
  }

  it('tie exactly when nothing is outstanding as a credit', async () => {
    await openInvoice('Harborview LLC', 100_000)

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })
    const { receivables } = await controlAccounts(fixture.ctx)

    expect(aging.totals.totalCents).toBe(receivables.subledgerCents)
    expect(aging.credits.count).toBe(0)
    expect(aging.controlAccountCents).toBe(aging.totals.totalCents)
  })

  it('differ by exactly the unapplied credits, and the report says so', async () => {
    // ADR 0106 left this gap open and named closing it a separate question.
    // A credit note reduces 1100 when it is issued but has no age, so the two
    // reports legitimately differ — and now the difference is on the page.
    const { revenue, customer, invoice } = await openInvoice('Harborview LLC', 100_000)
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill, not yet applied',
    })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })
    const { receivables } = await controlAccounts(fixture.ctx)

    // Aging still ages the whole invoice: the credit belongs to no invoice yet.
    expect(aging.totals.totalCents).toBe(100_000)
    expect(aging.credits).toEqual({ count: 1, functionalCents: 30_000 })

    // And the figure it predicts for the balance sheet is the one the control
    // account actually reports.
    expect(aging.controlAccountCents).toBe(70_000)
    expect(aging.controlAccountCents).toBe(receivables.subledgerCents)
    expect(receivables.agrees).toBe(true)
  })

  it('counts no credit issued after the date asked about', async () => {
    const { revenue, customer, invoice } = await openInvoice('Harborview LLC', 100_000)
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Later', unitPriceCents: 30_000 }],
      reason: 'Issued after the report date',
    })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })
    expect(aging.credits.count).toBe(0)
  })

  it('keeps one company’s credits out of another’s reconciliation', async () => {
    await openInvoice('Harborview LLC', 100_000)

    const other = await createCompanyFixture({ name: 'Somebody Else Ltd' })
    const otherRevenue = await other.account('4100')
    const otherCustomer = await createCustomer(other.ctx, { name: 'Their Customer' })
    await createCreditNote(other.ctx, {
      customerId: otherCustomer.id,
      issueDate: '2026-03-15',
      lines: [{ chartAccountId: otherRevenue.id, description: 'Theirs', unitPriceCents: 90_000 }],
      reason: 'Not ours',
    })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-15' })
    expect(aging.credits.count).toBe(0)
  })
})
