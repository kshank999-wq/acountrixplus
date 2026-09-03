import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { financialAccounts } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { applyCredit } from '@/modules/receivables/customer-credit'
import { profitAndLoss } from '@/modules/ledger/reports'

/**
 * The credit spent in July that cash basis reported in March (Phase 113).
 *
 * This codebase's cash-basis rule is its own, stated in its own caveat:
 *
 * > Cash basis recognizes **through the document a payment settles**, so these
 * > move the bank balance and appear in no revenue or expense account.
 *
 * So an application is the moment revenue becomes recognisable, and the period
 * it belongs to is the period the application happened in. But
 * `payment_applications` has no date column at all — it carries a payment, a
 * document and an amount — so `cashBasisBalances` dates every application by
 * `payments.payment_date`, the day the *money* arrived.
 *
 * For an application made when the payment was recorded those are the same day.
 * For **held credit spent later** they are months apart, and two things go
 * wrong at once: the later period never sees the revenue, and the earlier one
 * gains it retrospectively — a closed period whose profit changes because of
 * something somebody did today.
 */

describe('held credit spent in a later period', () => {
  let fixture: Fixture
  let bankId: string
  let customerId: string
  let revenueId: string

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Longacre Joinery' })
    const [bank] = await db
      .select()
      .from(financialAccounts)
      .where(eq(financialAccounts.companyId, fixture.companyId))
      .limit(1)
    bankId = bank.id
    customerId = (await createCustomer(fixture.ctx, { name: 'Ferrers Estate' })).id
    revenueId = (await fixture.account('4100')).id
  })

  const anInvoice = (cents: number, issueDate: string, dueDate: string) =>
    createInvoice(fixture.ctx, {
      customerId,
      issueDate,
      dueDate,
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
    })

  const cashRevenue = async (startDate: string, endDate: string) =>
    (await profitAndLoss(fixture.ctx, { startDate, endDate, basis: 'cash' })).revenue.totalCents

  /** $5,000 arrives in March against a $3,000 invoice: $2,000 held over. */
  const overpaidInMarch = async () => {
    const march = await anInvoice(300_000, '2026-03-02', '2026-03-31')
    const payment = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId,
      financialAccountId: bankId,
      paymentDate: '2026-03-10',
      amountCents: 500_000,
      applications: [{ invoiceId: march.id, amountCents: 300_000 }],
    })
    return payment
  }

  it('reports the March work in March, before any of this', async () => {
    await overpaidInMarch()

    expect(await cashRevenue('2026-03-01', '2026-03-31')).toBe(300_000)
    expect(await cashRevenue('2026-07-01', '2026-07-31')).toBe(0)
  })

  it('reports the July work in July, not in March', async () => {
    const payment = await overpaidInMarch()
    const july = await anInvoice(200_000, '2026-07-05', '2026-08-05')
    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: july.id,
      appliedOn: '2026-07-08',
    })

    expect(await cashRevenue('2026-07-01', '2026-07-31')).toBe(200_000)
  })

  it('leaves March alone when a March credit is spent in July', async () => {
    // The half that matters most: March is a period somebody may have closed,
    // filed and reported on. Applying a credit today must not change what it
    // said.
    const payment = await overpaidInMarch()
    const before = await cashRevenue('2026-03-01', '2026-03-31')

    const july = await anInvoice(200_000, '2026-07-05', '2026-08-05')
    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: july.id,
      appliedOn: '2026-07-08',
    })

    expect(await cashRevenue('2026-03-01', '2026-03-31')).toBe(before)
    expect(await cashRevenue('2026-03-01', '2026-03-31')).toBe(300_000)
  })

  it('still puts an application made on the day of payment in that day’s period', async () => {
    // The common case, asserted so the repair is shown not to have moved it:
    // when the application happens with the payment, the two dates agree and
    // nothing about the answer changes.
    await overpaidInMarch()

    expect(await cashRevenue('2026-01-01', '2026-12-31')).toBe(300_000)
    expect(await cashRevenue('2026-03-01', '2026-03-31')).toBe(300_000)
  })

  it('adds up to the same money over a window covering both', async () => {
    // Whatever the periods say individually, the year has to hold $5,000 of
    // revenue against $5,000 of cash — a repair that moved money into the right
    // month but changed the total would be a worse defect than the one it fixed.
    const payment = await overpaidInMarch()
    const july = await anInvoice(200_000, '2026-07-05', '2026-08-05')
    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: july.id,
      appliedOn: '2026-07-08',
    })

    expect(await cashRevenue('2026-01-01', '2026-12-31')).toBe(500_000)
  })
})
