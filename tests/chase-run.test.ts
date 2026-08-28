import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, invoices, transactionalMessages } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { sendInvoice } from '@/modules/receivables/send'
import { getChasePolicy, updateChasePolicy } from '@/modules/receivables/chase-policy'
import { chaseCandidates, previewChases, runChases } from '@/modules/receivables/chase-run'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'

/**
 * Chasing overdue invoices without anybody opening a page (Phase 43).
 *
 * The decision itself is asserted in `chasing.test.ts` with no database. What
 * is under test here is the half that touches the world: that the policy is
 * off until somebody says otherwise, that the run reads the right facts, and
 * that a chase is an ordinary send — recorded, counted, and visible.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Chasing Co' })
})

async function anInvoice(
  opts: { email?: string | null; cents?: number; due?: string; number?: string } = {},
) {
  const customer = await createCustomer(fixture.ctx, {
    name: `Harborview ${opts.number ?? '1'}`,
    email: opts.email === null ? undefined : (opts.email ?? 'ap@harborview.test'),
  })
  const sales = await fixture.account('4000')

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: opts.due ?? '2026-03-31',
    lines: [
      { chartAccountId: sales.id, description: 'Kitchen refit', unitPriceCents: opts.cents ?? 120_000 },
    ],
  })

  return { customer, invoice }
}

/** Turns chasing on with whatever the test needs changed. */
async function enable(over: Parameters<typeof updateChasePolicy>[1] = {}) {
  return updateChasePolicy(fixture.ctx, { enabled: true, ...over })
}

/**
 * Sends an invoice and puts the stamp on the day the test means.
 *
 * `sendInvoice` uses the real clock, which is later than every `asOf` these
 * tests reason about — so without this every invoice looks as though its last
 * letter went out in the future, and the gap rule correctly refuses to chase
 * anything at all.
 */
async function sendOn(invoiceId: string, on: string) {
  const result = await sendInvoice(fixture.ctx, invoiceId)
  await db
    .update(invoices)
    .set({ sentAt: new Date(`${on}T00:00:00Z`) })
    .where(eq(invoices.id, invoiceId))
  return result
}

/** A chase run for a date, with the sends it made stamped on that date too. */
async function runOn(asOf: string) {
  const result = await runChases(fixture.ctx, { asOf })
  const on = new Date(`${asOf}T00:00:00Z`)
  await db
    .update(invoices)
    .set({ sentAt: on })
    .where(and(eq(invoices.companyId, fixture.companyId), gt(invoices.sentAt, on)))
  return result
}

describe('the policy', () => {
  /**
   * The most important assertion in the phase. This is the only automatic
   * behaviour in the system that emails somebody who is not a user of it, over
   * a company's name, with nobody present.
   */
  it('is off for a company that has never touched it', async () => {
    const policy = await getChasePolicy(fixture.companyId)

    expect(policy.enabled).toBe(false)
    expect(policy.updatedAt).toBeNull()
    // The rest of the numbers are what they would get if they switched it on,
    // not a description of anything happening.
    expect(policy.firstAfterDays).toBe(3)
    expect(policy.maxChases).toBe(3)
  })

  it('and a run under it sends nothing at all', async () => {
    const { invoice } = await anInvoice({ due: '2026-01-01' })
    await sendInvoice(fixture.ctx, invoice.id)

    const result = await runChases(fixture.ctx, { asOf: '2026-06-01' })

    expect(result.enabled).toBe(false)
    expect(result.sent).toBe(0)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.sendCount).toBe(1)
  })

  it('remembers what somebody set', async () => {
    await enable({ everyDays: 7, maxChases: 5, minimumBalanceCents: 10_000 })
    const policy = await getChasePolicy(fixture.companyId)

    expect(policy.enabled).toBe(true)
    expect(policy.everyDays).toBe(7)
    expect(policy.maxChases).toBe(5)
    expect(policy.minimumBalanceCents).toBe(10_000)
    expect(policy.updatedAt).not.toBeNull()
  })

  it('changes one setting without resetting the others', async () => {
    await enable({ everyDays: 7 })
    await updateChasePolicy(fixture.ctx, { maxChases: 6 })

    const policy = await getChasePolicy(fixture.companyId)
    expect(policy.everyDays).toBe(7)
    expect(policy.maxChases).toBe(6)
    expect(policy.enabled).toBe(true)
  })

  it('refuses a setting that would make the machine do something nobody meant', async () => {
    await expect(updateChasePolicy(fixture.ctx, { everyDays: 0 })).rejects.toBeInstanceOf(DomainError)
    await expect(updateChasePolicy(fixture.ctx, { firstAfterDays: -1 })).rejects.toBeInstanceOf(
      DomainError,
    )
    await expect(updateChasePolicy(fixture.ctx, { maxChases: 40 })).rejects.toBeInstanceOf(DomainError)
    await expect(updateChasePolicy(fixture.ctx, { maxPerRun: 0 })).rejects.toBeInstanceOf(DomainError)
  })

  it('is not something a reader can switch on', async () => {
    const readonly = { ...fixture.ctx, role: 'readonly' as const }
    await expect(updateChasePolicy(readonly, { enabled: true })).rejects.toBeInstanceOf(PermissionError)
  })

  it('records who turned it on', async () => {
    await enable()

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.companyId, fixture.companyId))

    const change = events.find((row) => row.action === 'chase.settings_update')
    expect(change).toBeDefined()
    expect(change!.userId).toBe(fixture.ctx.userId)
  })
})

describe('gathering what a chase could concern', () => {
  it('reads the send count and the address the decision needs', async () => {
    const { invoice } = await anInvoice()
    await sendInvoice(fixture.ctx, invoice.id)

    const [candidate] = await chaseCandidates(fixture.companyId)

    expect(candidate.number).toBe(invoice.number)
    expect(candidate.sendCount).toBe(1)
    expect(candidate.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(candidate.customerEmail).toBe('ap@harborview.test')
    expect(candidate.lastPaymentDate).toBeNull()
  })

  /**
   * The date lives on the payment, reached through the application. A part
   * payment is the strongest signal a customer is engaged, and getting this
   * join wrong means chasing them the morning after they paid.
   */
  it('finds when money last landed, through the application', async () => {
    const { customer, invoice } = await anInvoice()
    await sendInvoice(fixture.ctx, invoice.id)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-05-20',
      amountCents: 20_000,
      applications: [{ invoiceId: invoice.id, amountCents: 20_000 }],
    })

    const [candidate] = await chaseCandidates(fixture.companyId)
    expect(candidate.lastPaymentDate).toBe('2026-05-20')
    expect(candidate.balanceCents).toBe(100_000)
    expect(candidate.status).toBe('partial')
  })

  it('does not reach into another company', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const otherCustomer = await createCustomer(other.ctx, { name: 'Theirs', email: 'a@b.test' })
    const otherSales = await other.account('4000')
    await createInvoice(other.ctx, {
      customerId: otherCustomer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: otherSales.id, description: 'Theirs', unitPriceCents: 50_000 }],
    })

    await anInvoice()

    const mine = await chaseCandidates(fixture.companyId)
    expect(mine).toHaveLength(1)
    expect(mine[0].customerName).toBe('Harborview 1')
  })
})

describe('the preview', () => {
  it('says what would go out, and why the rest would not', async () => {
    await enable()

    const overdue = await anInvoice({ due: '2026-01-01', number: '1' })
    await sendOn(overdue.invoice.id, '2026-01-01')

    // Never sent, so never chased.
    await anInvoice({ due: '2026-01-01', number: '2' })

    // Sent, but not due yet.
    const future = await anInvoice({ due: '2027-01-01', number: '3' })
    await sendOn(future.invoice.id, '2026-03-01')

    const preview = await previewChases(fixture.companyId, '2026-06-01')

    expect(preview.due).toHaveLength(1)
    expect(preview.due[0].invoice.number).toBe(overdue.invoice.number)
    expect(preview.due[0].stage).toBe(1)
    expect(preview.heldCounts.never_sent).toBe(1)
    expect(preview.heldCounts.not_due_yet).toBe(1)
  })

  /**
   * The defect the browser caught.
   *
   * Written to plan against the stored policy, every row on a company that has
   * not switched chasing on read "chasing is switched off" — under a heading
   * promising to show what *would* go out. The preview was empty at exactly
   * the moment it was the whole point of the screen.
   */
  it('answers as if it were on, because that is the question somebody asks while it is off', async () => {
    // Deliberately not enabled.
    const overdue = await anInvoice({ due: '2026-01-01' })
    await sendOn(overdue.invoice.id, '2026-01-01')

    const preview = await previewChases(fixture.companyId, '2026-06-01')

    expect(preview.policy.enabled).toBe(false)
    expect(preview.due).toHaveLength(1)
    expect(preview.heldCounts.policy_off).toBe(0)
  })

  it('names the day after this one, which is the question somebody has', async () => {
    await enable()
    const { invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')

    const preview = await previewChases(fixture.companyId, '2026-06-01')
    // Today's chase resets the clock, so the next is 14 days from today —
    // not from an anchor five months in the past that has already gone by.
    expect(preview.due[0].nextAfter).toBe('2026-06-15')
  })

  it('holds back what is over the daily cap, and says how many', async () => {
    await enable({ maxPerRun: 1 })

    for (const n of ['1', '2', '3']) {
      const { invoice } = await anInvoice({ due: '2026-01-01', number: n })
      await sendOn(invoice.id, '2026-01-01')
    }

    const preview = await previewChases(fixture.companyId, '2026-06-01')
    expect(preview.due).toHaveLength(1)
    expect(preview.overCap).toBe(2)
  })
})

describe('the run', () => {
  it('sends the chase, and records it as an ordinary send', async () => {
    await enable()
    const { invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')

    const result = await runChases(fixture.ctx, { asOf: '2026-06-01' })

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    // One send by hand plus one chase. This count is the whole of the state
    // the cadence runs on — there is no second place a chase is remembered.
    expect(row.sendCount).toBe(2)

    const letters = await db
      .select()
      .from(transactionalMessages)
      .where(eq(transactionalMessages.reference, `invoice:${invoice.id}`))
    expect(letters).toHaveLength(2)
  })

  /**
   * The scheduler guarantees at least once, so this *will* happen. What stops
   * a double chase is the count the first one moved, not a lock.
   */
  it('firing twice on the same day chases once', async () => {
    await enable()
    const { invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')

    const first = await runOn('2026-06-01')
    const second = await runChases(fixture.ctx, { asOf: '2026-06-01' })

    expect(first.sent).toBe(1)
    expect(second.sent).toBe(0)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.sendCount).toBe(2)
  })

  it('stops once the invoice has had all the chases the policy allows', async () => {
    await enable({ maxChases: 2, everyDays: 10 })
    const { invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')

    expect((await runOn('2026-01-04')).sent).toBe(1)
    expect((await runOn('2026-01-14')).sent).toBe(1)
    // Third would be one more than allowed, however long it waits.
    expect((await runChases(fixture.ctx, { asOf: '2027-01-01' })).sent).toBe(0)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.sendCount).toBe(3)
  })

  /**
   * The expensive wrong answer, asserted end to end: a customer who paid does
   * not get a demand.
   */
  it('never chases an invoice that has been settled', async () => {
    await enable()
    const { customer, invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-02-01',
      amountCents: 120_000,
      applications: [{ invoiceId: invoice.id, amountCents: 120_000 }],
    })

    const result = await runChases(fixture.ctx, { asOf: '2026-06-01' })
    expect(result.sent).toBe(0)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.sendCount).toBe(1)
  })

  it('buys a part-payer some quiet, then resumes', async () => {
    await enable({ quietDaysAfterPayment: 10 })
    const { customer, invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-05-28',
      amountCents: 20_000,
      applications: [{ invoiceId: invoice.id, amountCents: 20_000 }],
    })

    expect((await runChases(fixture.ctx, { asOf: '2026-06-01' })).sent).toBe(0)
    expect((await runChases(fixture.ctx, { asOf: '2026-06-10' })).sent).toBe(1)
  })

  it('one bad address does not stop the rest of the day', async () => {
    await enable()

    // No email: `sendInvoice` would refuse it. The decision holds it back
    // before the send is attempted, which is what keeps the preview honest.
    const { invoice: mute } = await anInvoice({ due: '2026-01-01', number: '1', email: null })
    // A share link was pasted by hand, so it counts as sent.
    await db
      .update(invoices)
      .set({ sentAt: new Date('2026-01-01T00:00:00Z'), sendCount: 1 })
      .where(eq(invoices.id, mute.id))

    const good = await anInvoice({ due: '2026-01-01', number: '2' })
    await sendOn(good.invoice.id, '2026-01-01')

    const result = await runChases(fixture.ctx, { asOf: '2026-06-01' })

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)

    const preview = await previewChases(fixture.companyId, '2026-06-01')
    expect(preview.heldCounts.no_address).toBe(1)
  })

  it('leaves a written-off debt alone, and says so', async () => {
    await enable()
    const { invoice } = await anInvoice({ due: '2026-01-01' })
    await sendOn(invoice.id, '2026-01-01')
    await db.update(invoices).set({ status: 'written_off' }).where(eq(invoices.id, invoice.id))

    const result = await runChases(fixture.ctx, { asOf: '2026-06-01' })
    expect(result.sent).toBe(0)

    // Kept in the candidate set on purpose: "we are not chasing this because
    // you gave up on it" is the reassurance somebody needs before switching
    // chasing on.
    const preview = await previewChases(fixture.companyId, '2026-06-01')
    expect(preview.heldCounts.not_open).toBe(1)
  })

  it('is quiet on a day with nothing to do', async () => {
    await enable()
    const result = await runChases(fixture.ctx, { asOf: '2026-06-01' })

    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.considered).toBe(0)
    expect(result.notes).toEqual([])
  })
})
