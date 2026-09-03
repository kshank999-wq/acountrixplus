import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices, payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createCustomer,
  createInvoice,
  createVendor,
  createBill,
  recordPayment,
} from '@/modules/receivables/service'
import { applyCredit, heldCredits, refundCredit } from '@/modules/receivables/customer-credit'
import { voidPayment } from '@/modules/receivables/payment-voiding'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { arAging } from '@/modules/ledger/reports'
import { runIntegrityChecks } from '@/modules/integrity/service'

/**
 * Money the customer sent that nothing was owed for (Phase 53).
 *
 * Three claims under test:
 *
 *  1. **What goes in the books is what the bank shows.** The application used
 *     to say *"reduce it to $7,400"* — a figure the bank statement disagrees
 *     with, leaving the reconciliation out for ever.
 *  2. **The difference is a liability**, not revenue and not a negative
 *     receivable, so the aging report still names every penny it claims.
 *  3. **It has an end.** Applied to a later invoice or refunded — because a
 *     liability nothing can clear is what Phase 48 found in 2050.
 */

let fixture: Fixture
let bankId: string
/** Phase 40 gives every bank account its own ledger account, so this is not 1000. */
let bankChartId: string
let revenueId: string
let customerId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Overpay Co' })
  revenueId = (await fixture.account('4000')).id
  const bank = await createFinancialAccount(fixture.ctx, {
    name: 'Business Checking',
    kind: 'checking',
    mask: '4471',
  })
  bankId = bank.id
  bankChartId = bank.chartAccountId
  customerId = (await createCustomer(fixture.ctx, { name: 'Meridian Facilities Ltd' })).id
})

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

async function anInvoice(cents: number, issueDate = '2026-08-01') {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate,
    lines: [{ chartAccountId: revenueId, description: 'Survey', unitPriceCents: cents }],
  })
}

async function overpay(invoiceId: string, appliedCents: number, amountCents: number) {
  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-08-15',
    amountCents,
    financialAccountId: bankId,
    applications: [{ invoiceId, amountCents: appliedCents }],
  })
}

describe('a customer who sends more than they owe', () => {
  /**
   * The substance of the phase. What is recorded is what arrived, and the
   * difference becomes a liability rather than a hole in the reconciliation.
   */
  it('is recorded at what the bank shows', async () => {
    const invoice = await anInvoice(740_000)
    const payment = await overpay(invoice.id, 740_000, 800_000)

    expect(payment.amountCents).toBe(800_000)
    expect(payment.unappliedCents).toBe(60_000)

    // The bank has all of it.
    expect(await balanceForAccount(fixture.ctx, bankChartId)).toBe(800_000)
    // The invoice is settled, and nothing is owed.
    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.status).toBe('paid')
    expect(row.balanceCents).toBe(0)
    // And the difference is a liability to the customer.
    expect(await balanceOf('2520')).toBe(60_000)
  })

  /**
   * Netting it into receivables would hide it inside the aging report and
   * overstate collectable cash, which is why it is its own account.
   */
  it('does not turn up as a negative receivable', async () => {
    const invoice = await anInvoice(740_000)
    await overpay(invoice.id, 740_000, 800_000)

    expect(await balanceOf('1100')).toBe(0)

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-08-31' })
    expect(aging.totals.totalCents).toBe(0)
  })

  /**
   * Comparing the whole receipt against what the documents were relieved by
   * would read a $600 overpayment as a $600 exchange gain — inventing profit
   * out of a customer rounding up.
   */
  it('is not mistaken for an exchange gain', async () => {
    const invoice = await anInvoice(740_000)
    await overpay(invoice.id, 740_000, 800_000)

    // 7200 is the FX gain/loss account; nothing should have reached it.
    const fx = await accountByNumber(fixture.companyId, '7200')
    if (fx) expect(await balanceForAccount(fixture.ctx, fx.id)).toBe(0)
  })

  /** A customer paying before any invoice exists is the same thing. */
  it('holds the whole of an advance', async () => {
    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId,
      paymentDate: '2026-08-15',
      amountCents: 500_000,
      financialAccountId: bankId,
      applications: [],
    })

    expect(payment.unappliedCents).toBe(500_000)
    expect(await balanceOf('2520')).toBe(500_000)
    expect(await balanceOf('1100')).toBe(0)
  })

  it('says who is holding what', async () => {
    const invoice = await anInvoice(740_000)
    await overpay(invoice.id, 740_000, 800_000)

    const held = await heldCredits(fixture.ctx)
    expect(held).toHaveLength(1)
    expect(held[0].customerName).toBe('Meridian Facilities Ltd')
    expect(held[0].availableCents).toBe(60_000)
  })
})

describe('what cannot be held', () => {
  /**
   * Paying a supplier more than is owed leaves *them* owing *us*, which is an
   * asset and what vendor credits are for.
   */
  it('refuses an overpayment to a supplier', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Northern Supplies' })
    const expenseId = (await fixture.account('6350')).id
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-08-01',
      lines: [{ chartAccountId: expenseId, description: 'Supplies', unitPriceCents: 30_000 }],
    })

    await expect(
      recordPayment(fixture.ctx, {
        kind: 'disbursement',
        vendorId: vendor.id,
        paymentDate: '2026-08-15',
        amountCents: 50_000,
        financialAccountId: bankId,
        applications: [{ billId: bill.id, amountCents: 30_000 }],
      }),
    ).rejects.toThrow(/vendor credit/)
  })

  /** You cannot owe money to no one. */
  it('refuses a leftover with nobody named', async () => {
    await expect(
      recordPayment(fixture.ctx, {
        kind: 'receipt',
        paymentDate: '2026-08-15',
        amountCents: 50_000,
        financialAccountId: bankId,
        applications: [],
      }),
    ).rejects.toThrow(/nobody to hold the difference for/)
  })
})

describe('spending held credit', () => {
  /**
   * The end Phase 49 taught this system to build at the same time as the
   * balance. A liability nothing can clear is what Phase 48 found in 2050.
   */
  it('settles a later invoice, and clears the liability by that much', async () => {
    const first = await anInvoice(740_000)
    const payment = await overpay(first.id, 740_000, 800_000)

    const second = await anInvoice(100_000, '2026-09-01')

    const result = await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: second.id,
      appliedOn: '2026-09-02',
    })

    expect(result.appliedCents).toBe(60_000)
    expect(result.remainingCents).toBe(0)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, second.id))
    expect(row.balanceCents).toBe(40_000)
    expect(row.status).toBe('partial')

    expect(await balanceOf('2520')).toBe(0)
    // What is still owed on the second invoice, and nothing else.
    expect(await balanceOf('1100')).toBe(40_000)
  })

  it('takes only what fits', async () => {
    const first = await anInvoice(740_000)
    const payment = await overpay(first.id, 740_000, 800_000)

    const small = await anInvoice(20_000, '2026-09-01')
    const result = await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: small.id,
      appliedOn: '2026-09-02',
    })

    expect(result.appliedCents).toBe(20_000)
    expect(result.remainingCents).toBe(40_000)
    expect(await balanceOf('2520')).toBe(40_000)
  })

  /** A credit from one customer cannot settle another's invoice. */
  it('refuses another customer’s invoice', async () => {
    const first = await anInvoice(740_000)
    const payment = await overpay(first.id, 740_000, 800_000)

    const other = await createCustomer(fixture.ctx, { name: 'Somebody Else Ltd' })
    const theirs = await createInvoice(fixture.ctx, {
      customerId: other.id,
      issueDate: '2026-09-01',
      lines: [{ chartAccountId: revenueId, description: 'x', unitPriceCents: 10_000 }],
    })

    await expect(
      applyCredit(fixture.ctx, {
        paymentId: payment.id,
        invoiceId: theirs.id,
        appliedOn: '2026-09-02',
      }),
    ).rejects.toThrow(/different customer/)
  })

  it('happens once, however many people press at the same moment', async () => {
    const first = await anInvoice(740_000)
    const payment = await overpay(first.id, 740_000, 800_000)
    const second = await anInvoice(200_000, '2026-09-01')

    const results = await Promise.allSettled([
      applyCredit(fixture.ctx, {
        paymentId: payment.id,
        invoiceId: second.id,
        amountCents: 60_000,
        appliedOn: '2026-09-02',
      }),
      applyCredit(fixture.ctx, {
        paymentId: payment.id,
        invoiceId: second.id,
        amountCents: 60_000,
        appliedOn: '2026-09-02',
      }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await balanceOf('2520')).toBe(0)
  })

  it('refuses once nothing is left', async () => {
    const first = await anInvoice(740_000)
    const payment = await overpay(first.id, 740_000, 800_000)
    const second = await anInvoice(200_000, '2026-09-01')

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: second.id,
      appliedOn: '2026-09-02',
    })

    await expect(
      applyCredit(fixture.ctx, {
        paymentId: payment.id,
        invoiceId: second.id,
        appliedOn: '2026-09-03',
      }),
    ).rejects.toThrow(/nothing left over/)
  })

  /** A voided receipt holds nothing: the money never arrived (Phase 52). */
  it('is gone once the receipt is voided', async () => {
    const first = await anInvoice(740_000)
    const payment = await overpay(first.id, 740_000, 800_000)

    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Never cleared' })

    expect(await heldCredits(fixture.ctx)).toHaveLength(0)
  })
})

describe('giving held credit back', () => {
  /**
   * Phase 52's named follow-up, and deliberately not a void: a void says the
   * payment never happened, a refund says it happened and then went back.
   */
  it('takes it out of the bank and clears the liability', async () => {
    const invoice = await anInvoice(740_000)
    const payment = await overpay(invoice.id, 740_000, 800_000)

    const result = await refundCredit(fixture.ctx, {
      paymentId: payment.id,
      amountCents: 60_000,
      financialAccountId: bankId,
      refundedOn: '2026-08-20',
      reference: 'BACS refund',
    })

    expect(result.refundedCents).toBe(60_000)
    expect(result.remainingCents).toBe(0)
    expect(result.customerName).toBe('Meridian Facilities Ltd')

    expect(await balanceOf('2520')).toBe(0)
    // 800,000 in, 60,000 back out.
    expect(await balanceForAccount(fixture.ctx, bankChartId)).toBe(740_000)
  })

  it('refuses more than is held', async () => {
    const invoice = await anInvoice(740_000)
    const payment = await overpay(invoice.id, 740_000, 800_000)

    await expect(
      refundCredit(fixture.ctx, {
        paymentId: payment.id,
        amountCents: 100_000,
        financialAccountId: bankId,
        refundedOn: '2026-08-20',
      }),
    ).rejects.toThrow(/600.00 is held/)
  })

  /**
   * A refund is not a `payments` row. Recording it as a negative receipt would
   * break the constraint keeping amounts positive, and make every report that
   * sums receipts wrong by twice the refund.
   */
  it('does not invent a second payment', async () => {
    const invoice = await anInvoice(740_000)
    const payment = await overpay(invoice.id, 740_000, 800_000)

    await refundCredit(fixture.ctx, {
      paymentId: payment.id,
      amountCents: 60_000,
      financialAccountId: bankId,
      refundedOn: '2026-08-20',
    })

    const rows = await db.select().from(payments).where(eq(payments.companyId, fixture.companyId))
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(payment.id)
  })
})

describe('the account nobody would otherwise watch', () => {
  /**
   * The date is today's rather than a fixed one, and that is a consequence
   * rather than a preference (Phase 110).
   *
   * `receivables.customer_credit` is declared `today_only`: held credit is a
   * running column on the payment with no dated record of its consumption, so
   * a past date would compare a ledger walked back against a figure as it
   * stands now. Since Phase 109 the register **skips** such a check rather than
   * answering it wrongly, so asking about 2026-08-31 produces no finding at
   * all — which is the register working, and these two assertions failing on it
   * is how a declaration that switches a check off gets noticed.
   */
  const today = () => new Date().toISOString().slice(0, 10)

  /**
   * Added with the account rather than after it. Phase 48 found a clearing
   * account with no check on it and $28,700 in it that nothing could clear.
   */
  it('agrees with what the receipts say is held', async () => {
    const invoice = await anInvoice(740_000)
    await overpay(invoice.id, 740_000, 800_000)

    const run = await runIntegrityChecks(fixture.ctx, { asOf: today() })
    const finding = run.findings.find((row) => row.key === 'receivables.customer_credit')!

    expect(finding.agrees).toBe(true)
    expect(finding.leftCents).toBe(60_000)
    expect(finding.rightCents).toBe(60_000)
  })

  /** And notices when the two disagree. */
  it('catches a held amount the ledger does not carry', async () => {
    const invoice = await anInvoice(740_000)
    const payment = await overpay(invoice.id, 740_000, 800_000)

    /**
     * Somebody edits the subledger behind the ledger's back.
     *
     * Both columns, because since Phase 115 the check reads the functional one:
     * the ledger balance it is compared against is in the company's own money,
     * and the face amount can be euros. On these books the rate is one and the
     * two figures coincide, so moving them together is what a tamper on a
     * single-currency company looks like anyway.
     */
    await db
      .update(payments)
      .set({ unappliedCents: 90_000, functionalUnappliedCents: 90_000 })
      .where(eq(payments.id, payment.id))

    const run = await runIntegrityChecks(fixture.ctx, { asOf: today() })
    const finding = run.findings.find((row) => row.key === 'receivables.customer_credit')!

    expect(finding.agrees).toBe(false)
    expect(finding.detail).toContain('900.00')
  })

  /**
   * What this check stopped being able to see (Phase 115), recorded rather than
   * left for somebody to discover.
   *
   * Moving the face column alone leaves the functional column agreeing with the
   * ledger, so the check — which asks *does the subledger total match `2520`* —
   * correctly answers yes. The books are still consistent; what is broken is
   * the relationship between a payment's own two columns, which is a different
   * question and cannot be asked by subtracting one currency from another.
   *
   * Nothing asks it yet. ADR 0115 nominates the exact form it takes: the two
   * columns must reach zero together, so a receipt holding a face amount with
   * no functional amount behind it — or the reverse — is a stranded cent.
   */
  it('does not see a face amount moved on its own', async () => {
    const invoice = await anInvoice(740_000)
    const payment = await overpay(invoice.id, 740_000, 800_000)

    await db.update(payments).set({ unappliedCents: 90_000 }).where(eq(payments.id, payment.id))

    const run = await runIntegrityChecks(fixture.ctx, { asOf: today() })
    const finding = run.findings.find((row) => row.key === 'receivables.customer_credit')!

    expect(finding.agrees).toBe(true)
    expect(finding.leftCents).toBe(60_000)
  })
})
