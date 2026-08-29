import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { creditNotes, journalEntries, refunds, retainers } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createBill, createVendor, createCustomer } from '@/modules/receivables/service'
import { createVendorCredit, refundVendorCredit } from '@/modules/receivables/vendor-credits'
import { receiveRetainer, refundRetainer } from '@/modules/timebilling/billing'
import { listRefunds, voidRefund } from '@/modules/receivables/refund-voiding'
import { setModuleEnabled } from '@/modules/industry/modules'
import { putRate } from '@/modules/fx/service'
import { convert } from '@/modules/fx/rates'
import { trialBalance } from '@/modules/ledger/balances'
import { DomainError } from '@/modules/errors'

/**
 * Taking a refund back (Phase 69).
 *
 * One function for all three, which is the payoff of Phase 68 collapsing three
 * records into one table. The decision is a refusal to look anything up: a
 * reversal puts back the amounts the row already carries, so the realised gain
 * unwinds to the cent instead of being recomputed into a second figure.
 */

let fixture: Fixture
let expenseId: string

const RAISED = 1_083_500
const RETURNED = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Unwind Co', industry: 'professional_services' })
  await setModuleEnabled(fixture.ctx, 'time_billing', true)
  expenseId = (await fixture.account('6000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-04-01',
    rateMillionths: RAISED,
    source: 'manual',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: RETURNED,
    source: 'manual',
  })
})

/** A euro vendor credit, recovered in cash — money in, a realised gain. */
async function recoveredCredit(amountCents = 50_000) {
  const vendor = await createVendor(fixture.ctx, { name: 'Hafen Logistik GmbH' })
  const bill = await createBill(fixture.ctx, {
    vendorId: vendor.id,
    issueDate: '2026-04-01',
    dueDate: '2026-05-01',
    currency: 'EUR',
    lines: [{ chartAccountId: expenseId, description: 'Freight', unitPriceCents: 300_000 }],
  })
  const credit = await createVendorCredit(fixture.ctx, {
    vendorId: vendor.id,
    issueDate: '2026-04-01',
    billId: bill.id,
    lines: [{ chartAccountId: expenseId, description: 'Overcharge', unitPriceCents: 200_000 }],
  })

  await refundVendorCredit(fixture.ctx, {
    creditNoteId: credit.id,
    amountCents,
    financialAccountId: fixture.financialAccountId,
    refundedOn: '2026-06-15',
  })

  const [row] = await db.select().from(refunds).where(eq(refunds.subjectId, credit.id))
  return { credit, refundId: row.id }
}

/** A euro retainer, given back — money out, a realised loss. */
async function refundedRetainer(amountCents = 50_000) {
  const customer = await createCustomer(fixture.ctx, { name: 'Bremen Beratung GmbH' })
  const retainer = await receiveRetainer(fixture.ctx, {
    customerId: customer.id,
    receivedOn: '2026-04-01',
    amountCents: 200_000,
    currency: 'EUR',
    financialAccountId: fixture.financialAccountId,
  })

  await refundRetainer(fixture.ctx, {
    retainerId: retainer.id,
    amountCents,
    financialAccountId: fixture.financialAccountId,
    refundedOn: '2026-06-15',
  })

  const [row] = await db.select().from(refunds).where(eq(refunds.subjectId, retainer.id))
  return { retainer, refundId: row.id }
}

describe('one function for all three refunds', () => {
  it('takes a recovery back', async () => {
    const { refundId } = await recoveredCredit()
    const result = await voidRefund(fixture.ctx, { refundId })

    expect(result.balanceCents).toBe(50_000)
    expect(result.currency).toBe('EUR')
    expect(result.message).toContain('€500.00 is available again')
  })

  it('takes a retainer refund back, with the opposite wording', async () => {
    const { refundId } = await refundedRetainer()
    const result = await voidRefund(fixture.ctx, { refundId })

    expect(result.message).toContain('€500.00 is owed again')
  })
})

describe('what goes back', () => {
  it('restores both halves of the credit together', async () => {
    const { credit, refundId } = await recoveredCredit()

    const [before] = await db.select().from(creditNotes).where(eq(creditNotes.id, credit.id))
    expect(before.remainingCents).toBe(150_000)

    await voidRefund(fixture.ctx, { refundId })

    const [after] = await db.select().from(creditNotes).where(eq(creditNotes.id, credit.id))
    expect(after.remainingCents).toBe(200_000)
    expect(after.functionalRemainingCents).toBe(convert(200_000, RAISED))
    // Money is available again, so the credit is open again.
    expect(after.status).toBe('open')
  })

  it('restores both halves of the retainer together', async () => {
    const { retainer, refundId } = await refundedRetainer()
    await voidRefund(fixture.ctx, { refundId })

    const [after] = await db.select().from(retainers).where(eq(retainers.id, retainer.id))
    expect(after.remainingCents).toBe(200_000)
    expect(after.functionalRemainingCents).toBe(convert(200_000, RAISED))
  })

  /**
   * The substance. The recovery realised an $8.25 gain; taking it back leaves
   * `7100` exactly where it started rather than a cent or two away, because
   * nothing was recomputed.
   */
  it('unwinds the realised gain to the cent', async () => {
    const { refundId } = await recoveredCredit()

    const during = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(
      during.rows.find((r: { number: string; balanceCents: number }) => r.number === '7100')
        ?.balanceCents,
    ).toBe(825)

    await voidRefund(fixture.ctx, { refundId })

    const after = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(
      after.rows.find((r: { number: string; balanceCents: number }) => r.number === '7100')
        ?.balanceCents ?? 0,
    ).toBe(0)
    expect(after.isBalanced).toBe(true)
  })

  it('voids the entry rather than posting a mirror of it', async () => {
    const { refundId } = await recoveredCredit()

    const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId))
    const before = await db.select().from(journalEntries).where(eq(journalEntries.companyId, fixture.ctx.companyId))

    await voidRefund(fixture.ctx, { refundId })

    const after = await db.select().from(journalEntries).where(eq(journalEntries.companyId, fixture.ctx.companyId))
    // No new entry: the original is marked void, which is the ledger's way.
    expect(after.length).toBe(before.length)

    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, row.journalEntryId!))
    expect(entry.status).toBe('void')
  })

  it('marks the refund taken back rather than deleting it', async () => {
    const { refundId } = await recoveredCredit()
    await voidRefund(fixture.ctx, { refundId })

    const [row] = await db.select().from(refunds).where(eq(refunds.id, refundId))
    expect(row).toBeTruthy()
    expect(row.voidedAt).not.toBeNull()
    expect(row.voidedBy).toBe(fixture.ctx.userId)
  })
})

describe('what it refuses', () => {
  it('refuses the same refund twice', async () => {
    const { refundId } = await recoveredCredit()
    await voidRefund(fixture.ctx, { refundId })

    await expect(voidRefund(fixture.ctx, { refundId })).rejects.toThrow(/already been taken back/)
  })

  it('refuses when the credit it came from has been voided since', async () => {
    const { credit, refundId } = await recoveredCredit()
    await db.update(creditNotes).set({ status: 'void' }).where(eq(creditNotes.id, credit.id))

    await expect(voidRefund(fixture.ctx, { refundId })).rejects.toThrow(/cancelled record/)
  })

  /** Every refusal has to reach the screen, which Phase 68 learned the hard way. */
  it('refuses in a way the screen can print', async () => {
    const { refundId } = await recoveredCredit()
    await voidRefund(fixture.ctx, { refundId })

    await expect(voidRefund(fixture.ctx, { refundId })).rejects.toBeInstanceOf(DomainError)
  })

  it('refuses a refund that is not on these books', async () => {
    await expect(
      voidRefund(fixture.ctx, { refundId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow(/not on these books/)
  })
})

describe('seeing them at all', () => {
  /** Refunds were recorded and then vanished into balances — Phase 52's gap. */
  it('lists what has been refunded, with what each is against', async () => {
    await recoveredCredit()
    await refundedRetainer()

    const rows = await listRefunds(fixture.ctx)
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.subjectType).sort()).toEqual(['credit_note', 'retainer'])
    expect(rows.some((r) => r.subjectLabel.startsWith('Vendor credit VC-'))).toBe(true)
    expect(rows.some((r) => r.subjectLabel === 'The retainer')).toBe(true)
  })

  it('keeps showing one that has been taken back', async () => {
    const { refundId } = await recoveredCredit()
    await voidRefund(fixture.ctx, { refundId })

    const rows = await listRefunds(fixture.ctx)
    expect(rows.length).toBe(1)
    expect(rows[0].voidedAt).not.toBeNull()
  })
})
