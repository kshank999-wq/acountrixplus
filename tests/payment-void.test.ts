import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices, journalEntries, payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createCustomer,
  createInvoice,
  createVendor,
  createBill,
  recordPayment,
  voidDocument,
} from '@/modules/receivables/service'
import { listPayments, voidPayment } from '@/modules/receivables/payment-voiding'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { closePeriod } from '@/modules/ledger/journal'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { arAging } from '@/modules/ledger/reports'
import { cashBasisBalances } from '@/modules/ledger/cash-basis'
import { undepositedReceipts } from '@/modules/banking/deposits'

/**
 * Taking a payment back (Phase 52).
 *
 * Three claims under test:
 *
 *  1. **A payment can be taken back at all.** There was no way to — no status
 *     column, no service function, nothing. A receipt keyed at ten times its
 *     amount was permanent.
 *  2. **What it settled goes back to being owed**, and the ledger unwinds with
 *     it, so the aging report and the control account still agree afterwards.
 *  3. **A voided payment is not money.** Cash-basis reporting above all: a
 *     voided receipt left in place would report revenue never received.
 */

let fixture: Fixture
let bankId: string
let revenueId: string
let expenseId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Unwind Co' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6350')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
})

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

async function anInvoice(cents: number, issueDate = '2026-08-01') {
  const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
  return createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate,
    lines: [{ chartAccountId: revenueId, description: 'Survey', unitPriceCents: cents }],
  })
}

async function paid(invoiceId: string, cents: number, paymentDate = '2026-08-15', toBank = true) {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId))

  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId: invoice.customerId,
    paymentDate,
    amountCents: cents,
    financialAccountId: toBank ? bankId : undefined,
    applications: [{ invoiceId, amountCents: cents }],
  })
}

describe('taking a receipt back', () => {
  /**
   * The substance of the phase. Before it there was no status column on
   * `payments`, so there was nowhere to record that a payment did not happen
   * even if somebody had written the code.
   */
  it('puts the invoice back to being owed, and the ledger with it', async () => {
    const invoice = await anInvoice(120_000)
    const payment = await paid(invoice.id, 120_000)

    // Settled, and the bank has the money.
    let [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.status).toBe('paid')
    expect(row.balanceCents).toBe(0)

    const result = await voidPayment(fixture.ctx, {
      paymentId: payment.id,
      reason: 'Keyed at ten times the amount',
    })

    expect(result.amountCents).toBe(120_000)
    expect(result.ledger).toBe('void')
    expect(result.restorations.map((r) => r.number)).toEqual([invoice.number])
    ;[row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.status).toBe('open')
    expect(row.balanceCents).toBe(120_000)

    // And the books still agree, which is the point of unwinding both halves.
    const aging = await arAging(fixture.ctx, { asOfDate: '2026-08-28' })
    expect(await balanceOf('1100')).toBe(aging.totals.totalCents)
    expect(aging.totals.totalCents).toBe(120_000)
  })

  it('records the reason, and stays listed', async () => {
    const invoice = await anInvoice(50_000)
    const payment = await paid(invoice.id, 50_000)

    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Paid by the wrong customer' })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.status).toBe('void')
    expect(row.voidReason).toBe('Paid by the wrong customer')
    expect(row.voidedBy).toBe(fixture.userId)
    expect(row.voidedAt).not.toBeNull()
  })

  /** A void with no reason is a hole somebody reconstructs from dates later. */
  it('insists on a reason', async () => {
    const invoice = await anInvoice(50_000)
    const payment = await paid(invoice.id, 50_000)

    await expect(
      voidPayment(fixture.ctx, { paymentId: payment.id, reason: '   ' }),
    ).rejects.toThrow(/Say why/)
  })

  it('voids the journal entry behind it', async () => {
    const invoice = await anInvoice(50_000)
    const payment = await paid(invoice.id, 50_000)

    const [before] = await db.select().from(payments).where(eq(payments.id, payment.id))
    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Wrong' })

    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, before.journalEntryId!))

    expect(entry.status).toBe('void')
    expect(await balanceOf('1000')).toBe(0)
  })

  it('happens once, however many people press at the same moment', async () => {
    const invoice = await anInvoice(50_000)
    const payment = await paid(invoice.id, 50_000)

    const results = await Promise.allSettled([
      voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'One' }),
      voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Two' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.balanceCents).toBe(50_000)
  })

  it('is refused twice', async () => {
    const invoice = await anInvoice(50_000)
    const payment = await paid(invoice.id, 50_000)
    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Wrong' })

    await expect(
      voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Again' }),
    ).rejects.toThrow(/already been voided/)
  })

  it('only ever touches payments on these books', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const theirCustomer = await createCustomer(other.ctx, { name: 'Theirs' })
    const theirRevenue = (await other.account('4000')).id
    const theirInvoice = await createInvoice(other.ctx, {
      customerId: theirCustomer.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: theirRevenue, description: 'x', unitPriceCents: 10_000 }],
    })
    const theirBank = await createFinancialAccount(other.ctx, {
      name: 'Theirs',
      kind: 'checking',
      mask: '0001',
    })
    const theirPayment = await recordPayment(other.ctx, {
      kind: 'receipt',
      customerId: theirCustomer.id,
      paymentDate: '2026-08-15',
      amountCents: 10_000,
      financialAccountId: theirBank.id,
      applications: [{ invoiceId: theirInvoice.id, amountCents: 10_000 }],
    })

    await expect(
      voidPayment(fixture.ctx, { paymentId: theirPayment.id, reason: 'Nope' }),
    ).rejects.toThrow(/not on these books/)
  })
})

describe('a payment that settled part of something', () => {
  /**
   * `partial`, not `open` — and never back to `draft`. A document that was
   * issued and part-paid was still issued, and rewinding it to draft would take
   * it off the aging report a business works from every Friday.
   */
  it('leaves the document partial when another payment still stands', async () => {
    const invoice = await anInvoice(100_000)
    const first = await paid(invoice.id, 40_000)
    await paid(invoice.id, 30_000)

    await voidPayment(fixture.ctx, { paymentId: first.id, reason: 'Duplicated' })

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.balanceCents).toBe(70_000)
    expect(row.status).toBe('partial')
  })
})

describe('money somebody else has already counted', () => {
  /**
   * A banked receipt is money the deposit claims. Removing it underneath leaves
   * the deposit adding up to more than it contains, and the bank reconciliation
   * is where somebody finds out.
   */
  it('refuses a receipt that has been banked on a deposit', async () => {
    const invoice = await anInvoice(80_000)
    const payment = await paid(invoice.id, 80_000, '2026-08-15', false)

    const { createDeposit } = await import('@/modules/banking/deposits')
    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: bankId,
      depositDate: '2026-08-16',
      items: [{ paymentId: payment.id }],
    })

    await expect(
      voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Wrong' }),
    ).rejects.toThrow(/banked on deposit/)

    expect(deposit.number).toBeTruthy()
  })

  /** A cancelled document must not come back owing money. */
  it('refuses when a document it settled has since been voided', async () => {
    const invoice = await anInvoice(60_000)
    const payment = await paid(invoice.id, 60_000)

    // Voiding a paid invoice is its own decision; what matters here is that
    // once it is void, the payment cannot put a balance back onto it.
    await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invoice.id))

    await expect(
      voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Wrong' }),
    ).rejects.toThrow(/cancelled document/)
  })
})

describe('a payment in a closed period', () => {
  /**
   * Phase 51's rule, applied rather than re-decided. Voiding an entry inside a
   * closed period silently changes numbers somebody has already reported.
   */
  it('is reversed in the ledger rather than voided', async () => {
    const invoice = await anInvoice(90_000, '2026-03-01')
    const payment = await paid(invoice.id, 90_000, '2026-03-15')
    await closePeriod(fixture.ctx, { periodStart: '2026-01-01', periodEnd: '2026-06-30' })

    const result = await voidPayment(fixture.ctx, {
      paymentId: payment.id,
      reason: 'Applied to the wrong invoice',
    })

    expect(result.ledger).toBe('reverse')
    expect(result.reversalNumber).toBeGreaterThan(0)

    const [before] = await db.select().from(payments).where(eq(payments.id, payment.id))
    const [original] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, before.journalEntryId!))

    // The original stands; the correction is a second entry in an open period.
    expect(original.status).toBe('posted')

    const [reversal] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.reversalOfId, original.id))
    expect(reversal.entryDate > '2026-06-30').toBe(true)

    // Either way the money is off the bank and back on the invoice.
    expect(await balanceOf('1000')).toBe(0)
    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.balanceCents).toBe(90_000)
  })
})

describe('a voided payment is not money', () => {
  /**
   * The worst place for a void to be forgotten. Cash-basis reporting reads
   * `payment_applications` to link cash to the revenue accounts on the document
   * it paid — so a voided receipt left in place reports revenue that was never
   * received.
   */
  it('is gone from the cash-basis profit and loss', async () => {
    const invoice = await anInvoice(200_000)
    const payment = await paid(invoice.id, 200_000)

    const revenueOn = async () => {
      const rows = await cashBasisBalances(fixture.ctx, {
        startDate: '2026-08-01',
        endDate: '2026-08-31',
      })
      return rows.find((row) => row.number === '4000')?.balanceCents ?? 0
    }

    expect(await revenueOn()).toBe(200_000)

    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Never arrived' })

    expect(await revenueOn()).toBe(0)
  })

  /** And is never offered for banking. */
  it('is gone from the undeposited funds list', async () => {
    const invoice = await anInvoice(70_000)
    const payment = await paid(invoice.id, 70_000, '2026-08-15', false)

    expect((await undepositedReceipts(fixture.ctx)).map((r) => r.id)).toContain(payment.id)

    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Cheque bounced' })

    expect((await undepositedReceipts(fixture.ctx)).map((r) => r.id)).not.toContain(payment.id)
  })
})

describe('the payments screen', () => {
  /**
   * Payments have never been listed anywhere: recorded from the invoices screen
   * and the payables screen, then gone into balances. "Did that $1,500 go in
   * twice?" was a question with no screen behind it.
   */
  it('lists what has been received and paid, with what each may be undone to', async () => {
    const invoice = await anInvoice(45_000)
    const payment = await paid(invoice.id, 45_000)

    const rows = await listPayments(fixture.ctx, { today: '2026-08-28' })
    const row = rows.find((r) => r.id === payment.id)!

    expect(row.kind).toBe('receipt')
    expect(row.partyName).toBe('Harborview LLC')
    expect(row.amountCents).toBe(45_000)
    expect(row.verdict.ok).toBe(true)
    expect(row.restorations.map((r) => r.number)).toEqual([invoice.number])
  })

  it('says why a void is refused, on the row', async () => {
    const invoice = await anInvoice(45_000)
    const payment = await paid(invoice.id, 45_000)
    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Wrong' })

    const rows = await listPayments(fixture.ctx, { today: '2026-08-28' })
    const row = rows.find((r) => r.id === payment.id)!

    expect(row.status).toBe('void')
    expect(row.voidReason).toBe('Wrong')
    expect(row.verdict.ok).toBe(false)
  })
})

describe('taking a supplier payment back', () => {
  it('puts the bill back to being owed', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Northern Supplies' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: expenseId, description: 'Supplies', unitPriceCents: 65_000 }],
    })

    const payment = await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-08-15',
      amountCents: 65_000,
      financialAccountId: bankId,
      applications: [{ billId: bill.id, amountCents: 65_000 }],
    })

    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Paid the wrong supplier' })

    const { bills } = await import('@/db/schema')
    const [row] = await db.select().from(bills).where(eq(bills.id, bill.id))

    expect(row.balanceCents).toBe(65_000)
    expect(row.status).toBe('open')
    expect(await balanceOf('2000')).toBe(65_000)
  })

  /** Voiding a document is still a separate decision from voiding a payment. */
  it('leaves voidDocument alone', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Northern Supplies' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: expenseId, description: 'Supplies', unitPriceCents: 30_000 }],
    })

    await voidDocument(fixture.ctx, 'bill', bill.id)
    expect(await balanceOf('2000')).toBe(0)
  })
})
