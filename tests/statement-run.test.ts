import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customerStatements } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import {
  getStatementPolicy,
  previewStatements,
  runStatements,
  statementCandidates,
  updateStatementPolicy,
} from '@/modules/receivables/statement-run'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'

/**
 * Sending the month's statements without anybody opening a page (Phase 57).
 *
 * The decision is asserted in `statement-runs.test.ts` with no database. What is
 * under test here is the half that touches the world: that the policy is off
 * until somebody says otherwise, that the run reads the right facts, and that
 * running it twice does not send twice.
 */

let fixture: Fixture
let revenueId: string
let bankId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Statement Runs Co' })
  revenueId = (await fixture.account('4000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
})

async function aCustomerOwing(cents: number, name = 'Meridian Facilities Ltd') {
  const customer = await createCustomer(fixture.ctx, {
    name,
    email: `${name.replace(/\W/g, '').toLowerCase()}@test.test`,
  })

  if (cents > 0) {
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
    })
  }

  return customer
}

/** An advance with nothing to apply it to: the simplest held credit. */
async function anAdvance(customerId: string, cents: number) {
  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-02-01',
    amountCents: cents,
    financialAccountId: bankId,
    applications: [],
  })
}

const enable = (over: Parameters<typeof updateStatementPolicy>[1] = {}) =>
  updateStatementPolicy(fixture.ctx, { enabled: true, dayOfMonth: 1, ...over })

describe('the policy', () => {
  /**
   * The most important assertion in the phase. This emails people who are not
   * users of the system, over a company's own name, with nobody present.
   */
  it('is off for a company that has never touched it', async () => {
    const policy = await getStatementPolicy(fixture.companyId)

    expect(policy.enabled).toBe(false)
    expect(policy.updatedAt).toBeNull()
    // The rest are what they would get if they switched it on, not a
    // description of anything happening.
    expect(policy.dayOfMonth).toBe(1)
    expect(policy.kind).toBe('open_item')
  })

  it('and a run under it sends nothing at all', async () => {
    await aCustomerOwing(90_000)

    const result = await runStatements(fixture.ctx, { asOf: '2026-07-01' })

    expect(result.enabled).toBe(false)
    expect(result.sent).toBe(0)
    expect(result.saved).toBe(0)
  })

  it('refuses a day that does not exist in every month', async () => {
    await expect(enable({ dayOfMonth: 31 })).rejects.toThrow(DomainError)
    await expect(enable({ dayOfMonth: 31 })).rejects.toThrow(/1st and the 28th/)
  })

  it('refuses a run that may send nothing', async () => {
    await expect(enable({ maxPerRun: 0 })).rejects.toThrow(/at least one/)
  })

  it('is not something a reader can switch on', async () => {
    const readonly = { ...fixture.ctx, role: 'readonly' as const }
    await expect(updateStatementPolicy(readonly, { enabled: true })).rejects.toBeInstanceOf(
      PermissionError,
    )
  })
})

describe('reading the book', () => {
  it('finds a customer who owes something', async () => {
    const customer = await aCustomerOwing(90_000)

    const [candidate] = (await statementCandidates(fixture.companyId)).filter(
      (row) => row.customerId === customer.id,
    )

    expect(candidate.balanceCents).toBe(90_000)
    expect(candidate.heldCreditCents).toBe(0)
    expect(candidate.lastSentDate).toBeNull()
  })

  /**
   * Phase 54's rule, reaching the schedule: a customer who owes nothing but
   * whose money the business is holding is owed a refund or an application, and
   * only the business knows it.
   */
  it('finds a customer who owes nothing but whose money is held', async () => {
    const customer = await aCustomerOwing(0, 'Credit Only Ltd')
    await anAdvance(customer.id, 60_000)

    const [candidate] = (await statementCandidates(fixture.companyId)).filter(
      (row) => row.customerId === customer.id,
    )

    expect(candidate.balanceCents).toBe(0)
    expect(candidate.heldCreditCents).toBe(60_000)
  })

  it('leaves an archived customer out of it', async () => {
    // Owing nothing, because Phase 45 refuses to archive somebody with a
    // balance — "hiding them would leave a balance nobody is watching".
    const customer = await aCustomerOwing(0, 'Archived Ltd')
    const { setCustomerActive } = await import('@/modules/parties/service')
    await setCustomerActive(fixture.ctx, customer.id, false)

    const found = (await statementCandidates(fixture.companyId)).some(
      (row) => row.customerId === customer.id,
    )
    expect(found).toBe(false)
  })
})

describe('the run', () => {
  it('saves a statement and sends it', async () => {
    const customer = await aCustomerOwing(90_000)
    await enable()

    const result = await runStatements(fixture.ctx, { asOf: '2026-07-01' })

    expect(result.saved).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)

    const [statement] = await db
      .select()
      .from(customerStatements)
      .where(eq(customerStatements.customerId, customer.id))

    expect(statement.asOfDate).toBe('2026-07-01')
    expect(statement.sentAt).not.toBeNull()
    expect(statement.sentTo).toBe('meridianfacilitiesltd@test.test')
  })

  it('does nothing on a day that is not the run day', async () => {
    await aCustomerOwing(90_000)
    await enable({ dayOfMonth: 1 })

    const result = await runStatements(fixture.ctx, { asOf: '2026-07-02' })

    expect(result.saved).toBe(0)
    expect(result.sent).toBe(0)
  })

  /**
   * The idempotence claim. The scheduler guarantees at least once, and what
   * stops the repeat is the same state that records the first send.
   */
  it('running twice on the same day sends once', async () => {
    await aCustomerOwing(90_000)
    await enable()

    const first = await runStatements(fixture.ctx, { asOf: '2026-07-01' })
    const second = await runStatements(fixture.ctx, { asOf: '2026-07-01' })

    expect(first.sent).toBe(1)
    expect(second.sent).toBe(0)
    expect(second.saved).toBe(0)

    const saved = await db.select().from(customerStatements)
    expect(saved).toHaveLength(1)
  })

  it('sends again once the quiet window has passed', async () => {
    await aCustomerOwing(90_000)
    await enable({ quietDays: 20 })

    expect((await runStatements(fixture.ctx, { asOf: '2026-07-01' })).sent).toBe(1)

    /**
     * `sendStatement` stamps `sent_at` from the wall clock, which is right —
     * it records when the message actually left, and back-dating it would make
     * the delivery log lie. The consequence is that a run replayed for a past
     * date sees a send stamped in the future, so the quiet window never opens.
     * Phase 43's chase tests hit exactly this and solve it the same way.
     */
    await db
      .update(customerStatements)
      .set({ sentAt: new Date('2026-07-01T09:00:00Z') })
      .where(eq(customerStatements.companyId, fixture.companyId))

    expect((await runStatements(fixture.ctx, { asOf: '2026-08-01' })).sent).toBe(1)

    const saved = await db.select().from(customerStatements)
    expect(saved).toHaveLength(2)
  })

  it('skips a customer with nothing to say', async () => {
    await aCustomerOwing(0, 'Clean Account Ltd')
    await enable()

    const result = await runStatements(fixture.ctx, { asOf: '2026-07-01' })
    expect(result.sent).toBe(0)
  })

  it('sends to a customer who owes nothing but is owed money back', async () => {
    const customer = await aCustomerOwing(0, 'Credit Only Ltd')
    await anAdvance(customer.id, 60_000)
    await enable()

    const result = await runStatements(fixture.ctx, { asOf: '2026-07-01' })
    expect(result.sent).toBe(1)
  })

  /**
   * A failure leaves the saved statement behind. That is right rather than
   * untidy: the saved row is the evidence of what was about to go out.
   */
  it('holds the per-run cap, and says how many it held', async () => {
    await aCustomerOwing(90_000, 'First Ltd')
    await aCustomerOwing(80_000, 'Second Ltd')
    await aCustomerOwing(70_000, 'Third Ltd')
    await enable({ maxPerRun: 2 })

    const result = await runStatements(fixture.ctx, { asOf: '2026-07-01' })

    expect(result.sent).toBe(2)
    expect(result.notes.join(' ')).toContain('1 more were due')
  })

  /** Biggest first, because the cap is about to cut the list. */
  it('sends the biggest debts first when the cap bites', async () => {
    await aCustomerOwing(10_000, 'Small Ltd')
    await aCustomerOwing(900_000, 'Big Ltd')
    await enable({ maxPerRun: 1 })

    await runStatements(fixture.ctx, { asOf: '2026-07-01' })

    const saved = await db.select().from(customerStatements)
    expect(saved).toHaveLength(1)
    expect(saved[0].closingBalanceCents).toBe(900_000)
  })
})

describe('the preview', () => {
  /**
   * Phase 43's lesson, transferred: asked against the real policy, every row on
   * a company that has not switched this on reads "switched off" — and on the
   * other 27 days of the month, "not the day". The preview would be empty at
   * exactly the moment it is the whole point.
   */
  it('shows what would go out even while it is switched off', async () => {
    await aCustomerOwing(90_000)

    const preview = await previewStatements(fixture.companyId, '2026-07-14')

    expect(preview.policy.enabled).toBe(false)
    expect(preview.due).toHaveLength(1)
  })

  it('says why the others are not going', async () => {
    await aCustomerOwing(90_000, 'Owes Ltd')
    await aCustomerOwing(0, 'Owes Nothing Ltd')
    await aCustomerOwing(100, 'Trivial Ltd')

    const preview = await previewStatements(fixture.companyId, '2026-07-01')

    expect(preview.heldCounts.nothing_to_say).toBe(1)
    expect(preview.heldCounts.too_small).toBe(1)
    expect(preview.due).toHaveLength(1)
  })

  it('never claims the policy is on when it is not', async () => {
    await aCustomerOwing(90_000)

    const preview = await previewStatements(fixture.companyId, '2026-07-01')
    expect(preview.policy.enabled).toBe(false)
  })
})
