import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createBill, createVendor } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { putRate } from '@/modules/fx/service'
import {
  adviseRun,
  executePayRun,
  listPayRuns,
  PayRunError,
} from '@/modules/payables/pay-runs'
import { voidPayment } from '@/modules/receivables/payment-voiding'

/**
 * The pay run that half-happened (Phase 59).
 *
 * Phase 49 pays one supplier at a time in a loop with no transaction around it.
 * Its own doc comment promised *"the message says how far it got"* — and the
 * `catch` threw away the list of who had already been paid and returned
 * *"That pay run could not be completed."*
 *
 * So the case under test here is the one that used to be unreportable: a run
 * where one supplier fails and the others are paid. It is provoked with a
 * supplier who has invoiced in two currencies — deterministic, and the way it
 * actually happens on a Friday, because one payment per supplier is how the
 * money leaves and there is no single amount of money that arrives.
 */

let fixture: Fixture
let expenseId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Runs Co' })
  expenseId = (await fixture.account('6000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
})

async function aVendor(name: string, email?: string) {
  return (await createVendor(fixture.ctx, { name, email })).id
}

async function aBill(vendorId: string, cents: number, currency?: string) {
  return createBill(fixture.ctx, {
    vendorId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    currency,
    lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: cents }],
  })
}

describe('a run that worked', () => {
  it('records what went out, and ties the payments to it', async () => {
    const cascade = await aVendor('Cascade Building Supply', 'ar@cascade.test')
    const delta = await aVendor('Delta Electrical', 'ap@delta.test')

    const first = await aBill(cascade, 250_000)
    const second = await aBill(cascade, 150_000)
    const third = await aBill(delta, 71_800)

    const { payRunId, outcome } = await executePayRun(fixture.ctx, {
      billIds: [first.id, second.id, third.id],
      paymentDate: '2026-07-15',
      financialAccountId: bankId,
      reference: 'BACS 88213',
    })

    expect(outcome.status).toBe('complete')
    expect(outcome.paidCents).toBe(471_800)
    expect(outcome.billsSettled).toBe(3)
    // One payment per supplier, not one per bill.
    expect(outcome.paid).toHaveLength(2)

    const [run] = await listPayRuns(fixture.ctx)
    expect(run.id).toBe(payRunId)
    expect(run.status).toBe('complete')
    expect(run.suppliersAttempted).toBe(2)
    expect(run.suppliersPaid).toBe(2)
    expect(run.paidCents).toBe(471_800)
    expect(run.reference).toBe('BACS 88213')
    expect(run.accountName).toBe('Business Checking')
    expect(run.failures).toBeNull()
  })

  it('stamps the run onto every payment it made', async () => {
    const vendorId = await aVendor('Cascade Building Supply')
    const bill = await aBill(vendorId, 250_000)

    const { payRunId } = await executePayRun(fixture.ctx, {
      billIds: [bill.id],
      paymentDate: '2026-07-15',
      financialAccountId: bankId,
    })

    const rows = await db.select().from(payments).where(eq(payments.payRunId, payRunId))
    expect(rows).toHaveLength(1)
    expect(rows[0].amountCents).toBe(250_000)
  })

  it('refuses a run of nothing, before opening one', async () => {
    await expect(
      executePayRun(fixture.ctx, {
        billIds: ['00000000-0000-0000-0000-000000000000'],
        paymentDate: '2026-07-15',
        financialAccountId: bankId,
      }),
    ).rejects.toThrow(PayRunError)

    // Nothing was attempted, so nothing is recorded. A run row here would be a
    // claim that somebody tried to pay something.
    expect(await listPayRuns(fixture.ctx)).toHaveLength(0)
  })
})

describe('a run where one supplier failed', () => {
  /**
   * The substance of the phase.
   *
   * Cascade is paid. Bremen cannot be: they have invoiced in both euro and
   * dollars, one payment per supplier is how the money leaves, and there is no
   * single amount of money that arrives — so Phase 35 refuses and says to
   * record one payment per currency.
   *
   * The old code let that exception out of the loop, so the caller was told
   * *"That pay run could not be completed"* and never learned that $2,500 had
   * already left the bank for Cascade.
   */
  async function aMixedRun() {
    const cascade = await aVendor('Cascade Building Supply', 'ar@cascade.test')
    const bremen = await aVendor('Bremen Hafenbau GmbH', 'buchhaltung@bremen.test')

    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-06-01',
      rateMillionths: 1_080_000,
      source: 'manual',
    })

    const domestic = await aBill(cascade, 250_000)
    const euro = await aBill(bremen, 400_000, 'EUR')
    const dollars = await aBill(bremen, 50_000)

    return executePayRun(fixture.ctx, {
      billIds: [domestic.id, euro.id, dollars.id],
      paymentDate: '2026-07-15',
      financialAccountId: bankId,
      reference: 'BACS 88213',
    })
  }

  it('pays the ones it can', async () => {
    const { outcome } = await aMixedRun()

    expect(outcome.status).toBe('partial')
    expect(outcome.paidCents).toBe(250_000)
    expect(outcome.paid.map((row) => row.vendorName)).toEqual(['Cascade Building Supply'])
  })

  it('says who was not paid, and why, in the domain’s own words', async () => {
    const { outcome } = await aMixedRun()

    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0].vendorName).toBe('Bremen Hafenbau GmbH')
    expect(outcome.failed[0].error).toMatch(/one payment per currency/)
  })

  /** The message is the fix: it used to say the run failed and nothing else. */
  it('leads with the money that went', async () => {
    const { outcome } = await aMixedRun()

    expect(outcome.message.startsWith('$2,500.00 paid')).toBe(true)
    expect(outcome.message).toContain('Bremen Hafenbau GmbH')
    expect(outcome.message).toContain('do not send it again')
  })

  it('keeps the failure on the run, for somebody reading it a week later', async () => {
    await aMixedRun()

    const [run] = await listPayRuns(fixture.ctx)
    expect(run.status).toBe('partial')
    expect(run.suppliersAttempted).toBe(2)
    expect(run.suppliersPaid).toBe(1)
    /**
     * €4,000 + $500 added together, which is meaningless — and is precisely
     * why the payment was refused. Phase 56 named the same defect on the
     * customers screen; `planRun` still sums document amounts across
     * currencies, and this test pins the figure the run recorded rather than
     * pretending it is a real quantity of money.
     */
    expect(run.unpaidCents).toBe(450_000)
    expect(run.failures).toContain('Bremen Hafenbau GmbH:')
    expect(run.failures).toMatch(/one payment per currency/)
  })

  /**
   * The safety property behind reporting a partial run as a success: pressing
   * Pay again cannot double-pay, because `payableQueue` only ever returns bills
   * with a balance and Cascade's no longer has one.
   */
  it('cannot pay the same supplier twice on a retry', async () => {
    const cascade = await aVendor('Cascade Building Supply')
    const bill = await aBill(cascade, 250_000)

    await executePayRun(fixture.ctx, {
      billIds: [bill.id],
      paymentDate: '2026-07-15',
      financialAccountId: bankId,
    })

    await expect(
      executePayRun(fixture.ctx, {
        billIds: [bill.id],
        paymentDate: '2026-07-15',
        financialAccountId: bankId,
      }),
    ).rejects.toThrow(/still outstanding/)
  })
})

describe('telling the run’s suppliers', () => {
  async function aPaidRun() {
    const cascade = await aVendor('Cascade Building Supply', 'ar@cascade.test')
    const delta = await aVendor('Delta Electrical', 'ap@delta.test')

    const first = await aBill(cascade, 250_000)
    const second = await aBill(delta, 71_800)

    return executePayRun(fixture.ctx, {
      billIds: [first.id, second.id],
      paymentDate: '2026-07-15',
      financialAccountId: bankId,
      reference: 'BACS 88213',
    })
  }

  it('advises everybody in it, in one act', async () => {
    const { payRunId } = await aPaidRun()

    const outcome = await adviseRun(fixture.ctx, payRunId)

    expect(outcome.status).toBe('complete')
    expect(outcome.sent).toHaveLength(2)
    expect(outcome.message).toContain('Advice sent to 2 suppliers')

    const [run] = await listPayRuns(fixture.ctx)
    expect(run.advisedSuppliers).toBe(2)
    expect(run.adviseCount).toBe(1)
    expect(run.advisedAt).not.toBeNull()
  })

  /**
   * A supplier with no address on file is ordinary, and Phase 58 refuses it
   * with an instruction. A loop that threw on the first one would leave the
   * rest of the run silently unadvised — the same failure this phase is about,
   * one level up.
   */
  it('does not stop at the supplier it cannot reach', async () => {
    const reachable = await aVendor('Cascade Building Supply', 'ar@cascade.test')
    const quiet = await aVendor('No Email Supply')

    const first = await aBill(reachable, 250_000)
    const second = await aBill(quiet, 10_000)

    const { payRunId } = await executePayRun(fixture.ctx, {
      billIds: [first.id, second.id],
      paymentDate: '2026-07-15',
      financialAccountId: bankId,
    })

    const outcome = await adviseRun(fixture.ctx, payRunId)

    expect(outcome.status).toBe('partial')
    expect(outcome.sent.map((row) => row.vendorName)).toEqual(['Cascade Building Supply'])
    expect(outcome.failed[0].vendorName).toBe('No Email Supply')
    expect(outcome.message).toContain('Get link')
  })

  /**
   * Phase 58 will not send a fresh advice for a payment taken back, and it is
   * right not to — the advice would describe money the supplier does not have.
   * Inside a batch that is not a failure worth reporting: nobody asked for that
   * supplier to be told, and their existing link already says it was reversed.
   */
  it('passes over a payment somebody took back', async () => {
    const { payRunId } = await aPaidRun()

    const [voidable] = await db
      .select()
      .from(payments)
      .where(eq(payments.payRunId, payRunId))
      .limit(1)

    await voidPayment(fixture.ctx, {
      paymentId: voidable.id,
      reason: 'Paid the wrong supplier',
    })

    const outcome = await adviseRun(fixture.ctx, payRunId)

    expect(outcome.sent).toHaveLength(1)
    expect(outcome.failed).toHaveLength(0)
    expect(outcome.status).toBe('complete')

    // The board counts what still stands, not what the run once did.
    const [run] = await listPayRuns(fixture.ctx)
    expect(run.liveSuppliers).toBe(1)
    expect(run.suppliersPaid).toBe(2)
  })

  it('refuses a run that is not on these books', async () => {
    await expect(
      adviseRun(fixture.ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/not on these books/)
  })
})
