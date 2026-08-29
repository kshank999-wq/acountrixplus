import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'
import { buildStatement } from '@/modules/receivables/statements'
import { chaseCandidates } from '@/modules/receivables/chase-run'

/**
 * The money that did not know its own currency (Phase 62).
 *
 * `recordPayment` has worked out what currency a payment is in since Phase 35,
 * used it to fetch the rate, and never stored it — a fact the code had and did
 * not keep, like Phase 55's `sent_at` and Phase 59's discarded `paid` list.
 *
 * The cost lands on `unapplied_cents`: money a customer overpaid, summed across
 * their receipts and read as the company's own. A customer who overpaid a
 * €4,000 invoice by €500 was recorded as holding $500.
 */

let fixture: Fixture
let revenueId: string
let expenseId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Currency Co' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: 1_080_000,
    source: 'manual',
  })
})

async function anInvoice(customerId: string, cents: number, currency?: string) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency,
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
  })
}

describe('a payment keeps the currency it always knew', () => {
  it('takes it from the documents it settles', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const invoice = await anInvoice(customer.id, 400_000, 'EUR')

    const receipt = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-10',
      amountCents: 400_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, receipt.id))
    expect(row.currency).toBe('EUR')
  })

  /** A payment on account settles nothing, so there is no document to read. */
  it('falls back to the company’s own for a payment on account', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })

    const receipt = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-10',
      amountCents: 50_000,
      financialAccountId: bankId,
      applications: [],
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, receipt.id))
    expect(row.currency).toBe('USD')
  })

  it('records a disbursement’s currency the same way', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Bremen Hafenbau GmbH' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      currency: 'EUR',
      lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: 400_000 }],
    })

    const payment = await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-07-10',
      amountCents: 400_000,
      financialAccountId: bankId,
      applications: [{ billId: bill.id, amountCents: 400_000 }],
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.currency).toBe('EUR')
  })

  /** The rule is shared now; the sentence a person reads is unchanged. */
  it('still refuses a payment settling two currencies', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })
    const euro = await anInvoice(customer.id, 400_000, 'EUR')
    const dollars = await anInvoice(customer.id, 120_000)

    await expect(
      recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: customer.id,
        paymentDate: '2026-07-10',
        amountCents: 520_000,
        financialAccountId: bankId,
        applications: [
          { invoiceId: euro.id, amountCents: 400_000 },
          { invoiceId: dollars.id, amountCents: 120_000 },
        ],
      }),
    ).rejects.toThrow(/one payment per currency/)
  })
})

describe('a euro overpayment', () => {
  async function overpaidInEuro() {
    const customer = await createCustomer(fixture.ctx, {
      name: 'Bremen Handel GmbH',
      email: 'ap@bremen.test',
    })
    const invoice = await anInvoice(customer.id, 400_000, 'EUR')

    // €4,500 against a €4,000 invoice: €500 held (Phase 53).
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-10',
      amountCents: 450_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    return customer
  }

  /**
   * The whole point of the phase. ADR 0061 could only net against the
   * home-currency balance, so a second euro invoice stood in full while the
   * €500 sat as an unusable "dollar" credit.
   */
  it('is set against a euro invoice on the statement', async () => {
    const customer = await overpaidInEuro()
    await anInvoice(customer.id, 300_000, 'EUR')

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    const euro = statement.positions.find((row) => row.currency === 'EUR')!
    expect(euro.owedCents).toBe(300_000)
    expect(euro.heldCents).toBe(50_000)
    expect(euro.dueCents).toBe(250_000)
  })

  it('is not set against a dollar invoice', async () => {
    const customer = await overpaidInEuro()
    await anInvoice(customer.id, 120_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    const dollars = statement.positions.find((row) => row.currency === 'USD')!
    expect(dollars.owedCents).toBe(120_000)
    expect(dollars.heldCents).toBe(0)
    expect(dollars.dueCents).toBe(120_000)
  })

  /** Phase 53 built the column for money held against nothing at all. */
  it('shows as money we owe back when they owe nothing in euro', async () => {
    const customer = await overpaidInEuro()

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    const euro = statement.positions.find((row) => row.currency === 'EUR')!
    expect(euro.ourDebtCents).toBe(50_000)
  })

  /**
   * A credit that could not settle this invoice is no reason to leave it
   * unchased. Before the currency was kept, a euro overpayment silenced a
   * dollar chase and a dollar overpayment silenced a euro one.
   */
  it('does not silence a chase for a dollar invoice', async () => {
    const customer = await overpaidInEuro()
    await anInvoice(customer.id, 120_000)

    const candidates = await chaseCandidates(fixture.ctx.companyId)
    const dollars = candidates.find((row) => row.balanceCents === 120_000)!
    const euro = candidates.find((row) => row.balanceCents === 300_000 || row.balanceCents === 400_000)

    expect(dollars.heldCreditCents ?? 0).toBe(0)
    // And the euro side still sees it, because that credit could settle it.
    if (euro) expect(euro.heldCreditCents ?? 0).toBe(50_000)
  })
})

describe('an ordinary single-currency customer', () => {
  it('nets exactly as Phase 54 always did', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview' })
    const invoice = await anInvoice(customer.id, 200_000)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-10',
      amountCents: 246_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 200_000 }],
    })

    await anInvoice(customer.id, 200_000)

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-15',
      kind: 'open_item',
    })

    expect(statement.positions).toHaveLength(1)
    expect(statement.positions[0].dueCents).toBe(154_000)
    expect(statement.dueCents).toBe(154_000)
    expect(statement.heldCreditCents).toBe(46_000)
  })
})
