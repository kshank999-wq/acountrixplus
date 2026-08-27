import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createCustomer,
  createInvoice,
  createVendor,
  createBill,
  recordPayment,
} from '@/modules/receivables/service'
import {
  documentLineAccounts,
  openDocumentsFor,
  partiesWithOpenDocuments,
} from '@/modules/receivables/open-documents'
import { allocate } from '@/modules/receivables/allocation'
import { writeOffInvoice } from '@/modules/receivables/credits'
import { arAging } from '@/modules/ledger/reports'
import { balanceForAccount } from '@/modules/ledger/balances'

/**
 * What is still owed, and what a payment settles (Phase 41).
 *
 * The claim under test: **a business can raise a document, and a payment lands
 * on the right ones**. The services under this have existed since Phase 2 —
 * what was missing was anything that could call them, and anything that could
 * decide which open documents a round-figure receipt covers.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Documents Co' })
})

/**
 * A company as it is the minute after registering: a chart of accounts and no
 * bank account, which is the state Phase 40 made possible to leave and every
 * new company starts in.
 */
async function createCompanyFixtureWithoutBank() {
  const { registerCompany } = await import('@/modules/tenancy/onboarding')
  const { company, user } = await registerCompany({
    companyName: `Fresh Books ${Date.now()}`,
    industry: 'general',
    userName: 'Owner',
    email: `fresh-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
    password: 'correct-horse-battery',
  })

  return {
    ctx: { userId: user.id, userName: user.name, companyId: company.id, role: 'owner' as const },
  }
}

async function aCustomerOwing(amounts: Array<{ cents: number; due: string }>) {
  const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
  const sales = await fixture.account('4000')

  const raised = []
  for (const [index, amount] of amounts.entries()) {
    raised.push(
      await createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-03-01',
        dueDate: amount.due,
        lines: [
          {
            chartAccountId: sales.id,
            description: `Work ${index + 1}`,
            unitPriceCents: amount.cents,
          },
        ],
      }),
    )
  }

  return { customer, invoices: raised }
}

describe('what is still open', () => {
  it('lists an invoice that has been raised and not paid', async () => {
    const { customer } = await aCustomerOwing([{ cents: 50_000, due: '2026-03-31' }])
    const open = await openDocumentsFor(fixture.ctx, 'customer', customer.id)

    expect(open).toHaveLength(1)
    expect(open[0].balanceCents).toBe(50_000)
  })

  it('drops one once it is settled', async () => {
    const { customer, invoices: raised } = await aCustomerOwing([
      { cents: 50_000, due: '2026-03-31' },
    ])

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 50_000,
      applications: [{ invoiceId: raised[0].id, amountCents: 50_000 }],
    })

    expect(await openDocumentsFor(fixture.ctx, 'customer', customer.id)).toHaveLength(0)
  })

  it('keeps a part-paid one, at what is left', async () => {
    const { customer, invoices: raised } = await aCustomerOwing([
      { cents: 50_000, due: '2026-03-31' },
    ])

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 20_000,
      applications: [{ invoiceId: raised[0].id, amountCents: 20_000 }],
    })

    const open = await openDocumentsFor(fixture.ctx, 'customer', customer.id)
    expect(open).toHaveLength(1)
    expect(open[0].balanceCents).toBe(30_000)
  })

  /**
   * The interesting exclusion. A written-off invoice is real, owed, and given
   * up on — money arriving against it is a *recovery*, which posts differently
   * and takes the bad debt back off the P&L. Applying a receipt to it silently
   * here would make that decision for somebody.
   */
  it('leaves a written-off invoice out, because money against it is a recovery', async () => {
    const { customer, invoices: raised } = await aCustomerOwing([
      { cents: 50_000, due: '2026-03-31' },
    ])

    await writeOffInvoice(fixture.ctx, raised[0].id, {
      writtenOffOn: '2026-06-30',
      reason: 'Gone quiet',
    })

    expect(await openDocumentsFor(fixture.ctx, 'customer', customer.id)).toHaveLength(0)
  })

  it('leaves a draft out, because nobody owes it yet', async () => {
    const { customer, invoices: raised } = await aCustomerOwing([
      { cents: 50_000, due: '2026-03-31' },
    ])

    await db
      .update(invoices)
      .set({ status: 'draft' })
      .where(eq(invoices.id, raised[0].id))

    expect(await openDocumentsFor(fixture.ctx, 'customer', customer.id)).toHaveLength(0)
  })

  it('does not show another company’s documents', async () => {
    const other = await createCompanyFixture({ name: 'Not Yours' })
    const { customer } = await aCustomerOwing([{ cents: 50_000, due: '2026-03-31' }])

    expect(await openDocumentsFor(other.ctx, 'customer', customer.id)).toHaveLength(0)
  })
})

describe('who owes what', () => {
  it('totals across a party’s open documents', async () => {
    await aCustomerOwing([
      { cents: 50_000, due: '2026-03-31' },
      { cents: 30_000, due: '2026-04-30' },
    ])

    const parties = await partiesWithOpenDocuments(fixture.ctx, 'customer')
    expect(parties).toHaveLength(1)
    expect(parties[0].outstandingCents).toBe(80_000)
    expect(parties[0].documentCount).toBe(2)
  })

  it('leaves out somebody who owes nothing', async () => {
    await createCustomer(fixture.ctx, { name: 'Pays On Time Ltd' })
    expect(await partiesWithOpenDocuments(fixture.ctx, 'customer')).toHaveLength(0)
  })

  it('does the same on the supplier side', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'City Power' })
    const expense = await fixture.account('6100')

    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: expense.id, description: 'Electricity', unitPriceCents: 12_500 }],
    })

    const parties = await partiesWithOpenDocuments(fixture.ctx, 'vendor')
    expect(parties).toHaveLength(1)
    expect(parties[0].outstandingCents).toBe(12_500)
  })
})

describe('what a line may be coded to', () => {
  /**
   * Offering the whole chart is how a sale ends up in Accounts Payable.
   */
  it('offers income accounts on an invoice and never a liability', async () => {
    const accounts = await documentLineAccounts(fixture.ctx, 'customer')

    expect(accounts.length).toBeGreaterThan(0)
    expect(accounts.every((account) => ['revenue', 'other_income'].includes(account.type))).toBe(
      true,
    )
  })

  it('offers costs and assets on a bill, and never revenue', async () => {
    const accounts = await documentLineAccounts(fixture.ctx, 'vendor')

    expect(accounts.length).toBeGreaterThan(0)
    expect(accounts.some((account) => account.type === 'expense')).toBe(true)
    expect(accounts.some((account) => account.type === 'revenue')).toBe(false)

    // A van or a pallet of stock arrives on a supplier bill, so assets are on
    // the list — this is why the exclusions below have to be by name.
    expect(accounts.some((account) => account.number === '1500')).toBe(true)
    expect(accounts.some((account) => account.number === '1400')).toBe(true)
  })

  /**
   * A bill line posted straight at Accounts Receivable makes the control
   * account disagree with the sum of open invoices — which is the exact fault
   * `ledger.receivables` exists to catch, raised by the tool meant to prevent
   * it.
   */
  it('never offers a control account, on either side', async () => {
    for (const side of ['customer', 'vendor'] as const) {
      const numbers = (await documentLineAccounts(fixture.ctx, side)).map((row) => row.number)
      expect(numbers).not.toContain('1100') // Accounts Receivable
      expect(numbers).not.toContain('2000') // Accounts Payable
      expect(numbers).not.toContain('1200') // Undeposited Funds
    }
  })

  /**
   * "I owe a supplier, and the money went into my current account" is not a
   * thing that happens, and recording it puts Phase 40's tie-out permanently
   * out.
   */
  it('never offers cash, because every bank account is tied out against its feed', async () => {
    const numbers = (await documentLineAccounts(fixture.ctx, 'vendor')).map((row) => row.number)

    // The fixture's own bank account posts to 1000.
    expect(numbers).not.toContain('1000')
    expect(numbers).not.toContain('1050') // Petty cash
    expect(numbers).not.toContain('1060') // Cash drawers
  })

  it('holds back a bank account opened after the fact too', async () => {
    const { createFinancialAccount } = await import('@/modules/banking/accounts')
    await createFinancialAccount(fixture.ctx, { name: 'Deposit Account', kind: 'savings' })

    const numbers = (await documentLineAccounts(fixture.ctx, 'vendor')).map((row) => row.number)
    expect(numbers).not.toContain('1010')
  })

  /**
   * The half of the cash rule the first fix missed. Filtering only on the
   * `financial_accounts` link leaves a brand-new company's 1000 Checking
   * Account on the list, because nobody has opened one against it yet.
   */
  it('holds cash back on a company that has opened no bank account at all', async () => {
    const fresh = await createCompanyFixtureWithoutBank()
    const numbers = (await documentLineAccounts(fresh.ctx, 'vendor')).map((row) => row.number)

    expect(numbers).not.toContain('1000') // Checking
    expect(numbers).not.toContain('1010') // Savings
    expect(numbers).not.toContain('1050') // Petty cash
    // And the ordinary costs are all still there.
    expect(numbers).toContain('6400')
  })

  it('never offers accumulated depreciation, which the depreciation run owns', async () => {
    const numbers = (await documentLineAccounts(fixture.ctx, 'vendor')).map((row) => row.number)
    expect(numbers).not.toContain('1510')
    // The asset itself is fine — a van arrives on a supplier bill.
    expect(numbers).toContain('1500')
  })
})

describe('a payment across several invoices', () => {
  it('settles the oldest first and lands on the ledger', async () => {
    const { customer, invoices: raised } = await aCustomerOwing([
      { cents: 30_000, due: '2026-03-31' },
      { cents: 30_000, due: '2026-04-30' },
      { cents: 40_000, due: '2026-05-31' },
    ])

    const open = await openDocumentsFor(fixture.ctx, 'customer', customer.id)
    const allocation = allocate(60_000, open)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 60_000,
      financialAccountId: fixture.financialAccountId,
      applications: allocation.applications.map((application) => ({
        invoiceId: application.documentId,
        amountCents: application.amountCents,
      })),
    })

    const remaining = await openDocumentsFor(fixture.ctx, 'customer', customer.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].balanceCents).toBe(40_000)

    // And the two oldest are the ones that went.
    const settled = raised.slice(0, 2).map((invoice) => invoice.id)
    expect(remaining.map((row) => row.id)).not.toContain(settled[0])
    expect(remaining.map((row) => row.id)).not.toContain(settled[1])
  })

  it('leaves the receivable equal to what is still open', async () => {
    const { customer } = await aCustomerOwing([
      { cents: 30_000, due: '2026-03-31' },
      { cents: 70_000, due: '2026-04-30' },
    ])

    const open = await openDocumentsFor(fixture.ctx, 'customer', customer.id)
    const allocation = allocate(30_000, open)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
      applications: allocation.applications.map((application) => ({
        invoiceId: application.documentId,
        amountCents: application.amountCents,
      })),
    })

    const receivable = await fixture.account('1100')
    expect(await balanceForAccount(fixture.ctx, receivable.id)).toBe(70_000)
  })

  /**
   * The whole point of raising a document at all: it has to reach the report
   * somebody chases from.
   */
  it('puts what was raised on the aging report', async () => {
    await aCustomerOwing([{ cents: 50_000, due: '2026-03-31' }])

    const aged = await arAging(fixture.ctx, { asOfDate: '2026-06-30' })

    expect(aged.totals.totalCents).toBe(50_000)
    expect(aged.rows.map((row) => row.partyName)).toContain('Harborview LLC')
  })

  it('cannot be applied to more than is owed', async () => {
    const { customer } = await aCustomerOwing([{ cents: 30_000, due: '2026-03-31' }])
    const open = await openDocumentsFor(fixture.ctx, 'customer', customer.id)

    const allocation = allocate(50_000, open)
    expect(allocation.unappliedCents).toBe(20_000)

    // And recordPayment refuses the mismatch rather than half-landing it.
    await expect(
      recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: customer.id,
        paymentDate: '2026-04-01',
        amountCents: 50_000,
        financialAccountId: fixture.financialAccountId,
        applications: allocation.applications.map((application) => ({
          invoiceId: application.documentId,
          amountCents: application.amountCents,
        })),
      }),
    ).rejects.toThrow(/must match exactly/)
  })
})
