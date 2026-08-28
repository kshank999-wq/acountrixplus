import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bills, invoices } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  lineAmountCents,
  recordPayment,
  voidDocument,
} from '@/modules/receivables/service'
import { trialBalance } from '@/modules/ledger/balances'
import { agingBucket, apAging, arAging, balanceSheet } from '@/modules/ledger/reports'

/** Accounts receivable and payable (spec §13, §20). */
describe('line arithmetic', () => {
  it('extends quantity by unit price in exact cents', () => {
    expect(lineAmountCents(1000, 12_500)).toBe(12_500)
    // 1.5 hours at $125.00
    expect(lineAmountCents(1500, 12_500)).toBe(18_750)
    // 2.25 units at $33.33
    expect(lineAmountCents(2250, 3_333)).toBe(7_499)
  })

  it('rounds half-up rather than truncating', () => {
    // 0.005 units at $1.00 = 0.5 cents
    expect(lineAmountCents(5, 100)).toBe(1)
  })
})

describe('invoices', () => {
  it('posts Dr accounts receivable and Cr revenue', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')

    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [
        { chartAccountId: revenue.id, description: 'Consulting', unitPriceCents: 250_000 },
      ],
    })

    expect(invoice.totalCents).toBe(250_000)
    expect(invoice.balanceCents).toBe(250_000)
    expect(invoice.status).toBe('open')

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '1100')?.balanceCents).toBe(250_000)
    expect(balances.rows.find((r) => r.number === '4100')?.balanceCents).toBe(250_000)
    expect(balances.isBalanced).toBe(true)
  })

  it('derives a due date from the customer\'s terms', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')

    const customer = await createCustomer(fixture.ctx, {
      name: 'Net 15 Co',
      paymentTermsDays: 15,
    })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 10_000 }],
    })

    expect(invoice.dueDate).toBe('2026-08-16')
  })

  it('posts sales tax to the tax payable account', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4000')

    const customer = await createCustomer(fixture.ctx, { name: 'Taxed Co' })
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Goods', unitPriceCents: 100_000 }],
      taxCents: 8_250,
    })

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '2200')?.balanceCents).toBe(8_250)
    expect(balances.rows.find((r) => r.number === '1100')?.balanceCents).toBe(108_250)
    expect(balances.isBalanced).toBe(true)
  })

  it('numbers invoices sequentially', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Repeat Co' })

    const first = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'A', unitPriceCents: 1_000 }],
    })
    const second = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-02',
      lines: [{ chartAccountId: revenue.id, description: 'B', unitPriceCents: 1_000 }],
    })

    expect(first.number).toBe('INV-1001')
    expect(second.number).toBe('INV-1002')
  })

  it('refuses a customer from another company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const betaCustomer = await createCustomer(beta.ctx, { name: 'Beta Client' })
    const alphaRevenue = await alpha.account('4100')

    await expect(
      createInvoice(alpha.ctx, {
        customerId: betaCustomer.id,
        issueDate: '2026-08-01',
        lines: [{ chartAccountId: alphaRevenue.id, description: 'X', unitPriceCents: 1_000 }],
      }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('bills', () => {
  it('posts Dr expense and Cr accounts payable', async () => {
    const fixture = await createCompanyFixture()
    const materials = await fixture.account('5100')

    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: materials.id, description: 'Lumber', unitPriceCents: 84_000 }],
    })

    expect(bill.totalCents).toBe(84_000)

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '2000')?.balanceCents).toBe(84_000)
    expect(balances.rows.find((r) => r.number === '5100')?.balanceCents).toBe(84_000)
    expect(balances.isBalanced).toBe(true)
  })
})

describe('payments', () => {
  it('clears an invoice balance and moves AR to cash', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')

    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 250_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-08-20',
      amountCents: 250_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 250_000 }],
    })

    const [settled] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(settled.balanceCents).toBe(0)
    expect(settled.status).toBe('paid')

    const balances = await trialBalance(fixture.ctx)
    // AR is cleared, cash is up, revenue is untouched by the payment.
    expect(balances.rows.find((r) => r.number === '1100')?.balanceCents).toBe(0)
    expect(balances.rows.find((r) => r.number === '1000')?.balanceCents).toBe(250_000)
    expect(balances.rows.find((r) => r.number === '4100')?.balanceCents).toBe(250_000)
    expect(balances.isBalanced).toBe(true)
  })

  it('marks an invoice partial on a partial payment', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')

    const customer = await createCustomer(fixture.ctx, { name: 'Slow Payer' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-08-20',
      amountCents: 40_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 40_000 }],
    })

    const [partial] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(partial.balanceCents).toBe(60_000)
    expect(partial.status).toBe('partial')
  })

  it('settles several invoices with one payment', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Bulk Payer' })

    const first = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'A', unitPriceCents: 30_000 }],
    })
    const second = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-02',
      lines: [{ chartAccountId: revenue.id, description: 'B', unitPriceCents: 20_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-08-20',
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      applications: [
        { invoiceId: first.id, amountCents: 30_000 },
        { invoiceId: second.id, amountCents: 20_000 },
      ],
    })

    const rows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(rows.every((row) => row.status === 'paid')).toBe(true)
  })

  /**
   * Rewritten in Phase 53. This used to assert that `recordPayment` refused
   * any receipt whose applications did not sum to it exactly — and that
   * refusal was the defect: the screen above it told a business whose customer
   * had sent more than was owed to *"reduce it"*, putting a figure in the
   * books the bank statement disagrees with.
   *
   * What the applications do not cover is now **held** as credit for the
   * customer, so what is recorded is what arrived.
   */
  it('holds what the applications do not cover, rather than refusing it', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Mismatch Co' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-08-20',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 90_000 }],
    })

    expect(payment.amountCents).toBe(100_000)
    expect(payment.unappliedCents).toBe(10_000)
  })

  it('refuses to overpay a document', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Overpayer' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 10_000 }],
    })

    await expect(
      recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: customer.id,
        paymentDate: '2026-08-20',
        amountCents: 15_000,
        financialAccountId: fixture.financialAccountId,
        applications: [{ invoiceId: invoice.id, amountCents: 15_000 }],
      }),
    ).rejects.toThrow(/balance of 10000/i)
  })

  it('pays a bill, moving AP to cash', async () => {
    const fixture = await createCompanyFixture()
    const materials = await fixture.account('5100')

    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: materials.id, description: 'Lumber', unitPriceCents: 84_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-08-25',
      amountCents: 84_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 84_000 }],
    })

    const [settled] = await db.select().from(bills).where(eq(bills.id, bill.id))
    expect(settled.status).toBe('paid')

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '2000')?.balanceCents).toBe(0)
    // Cash went negative because the account started empty.
    expect(balances.rows.find((r) => r.number === '1000')?.balanceCents).toBe(-84_000)
    expect(balances.isBalanced).toBe(true)
  })
})

describe('voiding documents', () => {
  it('reverses the ledger effect of a voided invoice', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Cancelled Co' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    await voidDocument(fixture.ctx, 'invoice', invoice.id)

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '1100')).toBeUndefined()
    expect(balances.rows.find((r) => r.number === '4100')).toBeUndefined()
  })

  it('refuses to void a document with payments applied', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Partly Paid' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-08-20',
      amountCents: 25_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 25_000 }],
    })

    await expect(voidDocument(fixture.ctx, 'invoice', invoice.id)).rejects.toThrow(
      /reverse the payments/i,
    )
  })
})

describe('aging', () => {
  it('buckets by days past due', () => {
    expect(agingBucket('2026-09-01', '2026-08-15')).toBe('current')
    expect(agingBucket('2026-08-15', '2026-08-15')).toBe('current')
    expect(agingBucket('2026-08-01', '2026-08-15')).toBe('d1_30')
    expect(agingBucket('2026-07-01', '2026-08-15')).toBe('d31_60')
    expect(agingBucket('2026-06-01', '2026-08-15')).toBe('d61_90')
    expect(agingBucket('2026-01-01', '2026-08-15')).toBe('d90_plus')
  })

  it('reports outstanding receivables by customer and bucket', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')

    const current = await createCustomer(fixture.ctx, { name: 'Aardvark Co' })
    const late = await createCustomer(fixture.ctx, { name: 'Zebra Co' })

    await createInvoice(fixture.ctx, {
      customerId: current.id,
      issueDate: '2026-08-10',
      dueDate: '2026-09-10',
      lines: [{ chartAccountId: revenue.id, description: 'Recent', unitPriceCents: 40_000 }],
    })
    await createInvoice(fixture.ctx, {
      customerId: late.id,
      issueDate: '2026-06-01',
      dueDate: '2026-06-15',
      lines: [{ chartAccountId: revenue.id, description: 'Overdue', unitPriceCents: 90_000 }],
    })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-08-15' })

    expect(aging.rows).toHaveLength(2)
    // Sorted by name.
    expect(aging.rows[0].partyName).toBe('Aardvark Co')
    expect(aging.rows[0].current).toBe(40_000)
    // Due 15 June, as of 15 August — 61 days past due.
    expect(aging.rows[1].d61_90).toBe(90_000)
    expect(aging.totals.totalCents).toBe(130_000)
  })

  it('drops a paid invoice out of aging', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Prompt Co' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 50_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-08-05',
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 50_000 }],
    })

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-08-31' })
    expect(aging.rows).toHaveLength(0)
    expect(aging.totals.totalCents).toBe(0)
  })

  it('reports payables aging', async () => {
    const fixture = await createCompanyFixture()
    const materials = await fixture.account('5100')
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-01',
      dueDate: '2026-06-15',
      lines: [{ chartAccountId: materials.id, description: 'Lumber', unitPriceCents: 84_000 }],
    })

    const aging = await apAging(fixture.ctx, { asOfDate: '2026-08-15' })
    expect(aging.rows[0].partyName).toBe('Supply Depot')
    // Due 15 June, as of 15 August — 61 days past due.
    expect(aging.rows[0].d61_90).toBe(84_000)
  })

  it('scopes aging to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const revenue = await alpha.account('4100')
    const customer = await createCustomer(alpha.ctx, { name: 'Alpha Client' })
    await createInvoice(alpha.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 10_000 }],
    })

    expect((await arAging(alpha.ctx, { asOfDate: '2026-08-31' })).rows).toHaveLength(1)
    expect((await arAging(beta.ctx, { asOfDate: '2026-08-31' })).rows).toHaveLength(0)
  })
})

describe('statements including AR and AP', () => {
  it('keeps the balance sheet balanced with receivables and payables', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const materials = await fixture.account('5100')

    const customer = await createCustomer(fixture.ctx, { name: 'Client' })
    const vendor = await createVendor(fixture.ctx, { name: 'Supplier' })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 250_000 }],
    })
    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-08-02',
      lines: [{ chartAccountId: materials.id, description: 'Lumber', unitPriceCents: 84_000 }],
    })

    const bs = await balanceSheet(fixture.ctx, { asOfDate: '2026-08-31' })

    expect(bs.isBalanced).toBe(true)
    expect(bs.assets.totalCents).toBe(250_000)
    expect(bs.liabilities.totalCents).toBe(84_000)
    expect(bs.netIncomeCents).toBe(166_000)
  })
})
