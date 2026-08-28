import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices, transactionalMessages } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment, voidDocument } from '@/modules/receivables/service'
import {
  invoiceByShareToken,
  recordInvoiceView,
  revokeShareLink,
  sendInvoice,
  SendInvoiceError,
  shareLinkFor,
} from '@/modules/receivables/send'
import { PermissionError } from '@/modules/permissions'

/**
 * Getting an invoice to the customer (Phase 42).
 *
 * The claim under test: **the link shows the live record, and shows nothing
 * else**. A stranger holding it sees one invoice and no way to reach anything
 * around it.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Sending Co' })
})

async function anInvoice(opts: { email?: string | null; cents?: number } = {}) {
  const customer = await createCustomer(fixture.ctx, {
    name: 'Harborview LLC',
    email: opts.email === null ? undefined : (opts.email ?? 'ap@harborview.test'),
  })
  const sales = await fixture.account('4000')

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    memo: 'Thank you for your business.',
    lines: [
      {
        chartAccountId: sales.id,
        description: 'Kitchen refit',
        unitPriceCents: opts.cents ?? 120_000,
      },
    ],
  })

  return { customer, invoice }
}

describe('sending one', () => {
  it('mints a link, records who it went to, and reports that it left', async () => {
    const { invoice } = await anInvoice()
    const result = await sendInvoice(fixture.ctx, invoice.id)

    expect(result.to).toBe('ap@harborview.test')
    expect(result.isReminder).toBe(false)
    expect(result.delivered).toBe(true)
    expect(result.url).toContain('/i/')

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.shareToken).toBeTruthy()
    expect(row.sentTo).toBe('ap@harborview.test')
    expect(row.sendCount).toBe(1)
  })

  it('records the letter, so a failure is visible to an operator', async () => {
    const { invoice } = await anInvoice()
    await sendInvoice(fixture.ctx, invoice.id)

    const [message] = await db
      .select()
      .from(transactionalMessages)
      .where(eq(transactionalMessages.reference, `invoice:${invoice.id}`))

    expect(message).toBeDefined()
    expect(message.kind).toBe('invoice')
    expect(message.companyId).toBe(fixture.companyId)
  })

  it('is a reminder the second time, on the same link', async () => {
    const { invoice } = await anInvoice()
    const first = await sendInvoice(fixture.ctx, invoice.id)
    const second = await sendInvoice(fixture.ctx, invoice.id)

    expect(first.isReminder).toBe(false)
    expect(second.isReminder).toBe(true)
    // A link filed in somebody's inbox has to keep working.
    expect(second.url).toBe(first.url)
  })

  it('sends to an address typed for the occasion without changing the one on file', async () => {
    const { customer, invoice } = await anInvoice()
    const result = await sendInvoice(fixture.ctx, invoice.id, { to: 'boss@harborview.test' })

    expect(result.to).toBe('boss@harborview.test')

    const { customers } = await import('@/db/schema')
    const [row] = await db.select().from(customers).where(eq(customers.id, customer.id))
    expect(row.email).toBe('ap@harborview.test')
  })

  it('refuses when there is nowhere to send it', async () => {
    const { invoice } = await anInvoice({ email: null })
    await expect(sendInvoice(fixture.ctx, invoice.id)).rejects.toThrow(/no email address/)
  })

  it('refuses a voided invoice', async () => {
    const { invoice } = await anInvoice()
    await voidDocument(fixture.ctx, 'invoice', invoice.id)

    await expect(sendInvoice(fixture.ctx, invoice.id)).rejects.toThrow(SendInvoiceError)
  })

  it('refuses somebody else’s invoice', async () => {
    const other = await createCompanyFixture({ name: 'Not Yours' })
    const { invoice } = await anInvoice()

    await expect(sendInvoice(other.ctx, invoice.id)).rejects.toThrow(/not on these books/)
  })

  it('is not a bookkeeper’s to do', async () => {
    // Asking a customer for money is the same act as creating the debt.
    const { invoice } = await anInvoice()
    const bookkeeper = { ...fixture.ctx, role: 'bookkeeper' as const }

    await expect(sendInvoice(bookkeeper, invoice.id)).rejects.toThrow(PermissionError)
  })
})

describe('the link', () => {
  it('resolves to the invoice it was made for', async () => {
    const { invoice } = await anInvoice()
    const url = await shareLinkFor(fixture.ctx, invoice.id)
    const token = url.split('/i/')[1]

    const found = await invoiceByShareToken(token)
    expect(found?.invoiceId).toBe(invoice.id)
    expect(found?.view.number).toBe(invoice.number)
    expect(found?.view.customerName).toBe('Harborview LLC')
  })

  it('gives the same link twice rather than a new one', async () => {
    const { invoice } = await anInvoice()
    expect(await shareLinkFor(fixture.ctx, invoice.id)).toBe(
      await shareLinkFor(fixture.ctx, invoice.id),
    )
  })

  /**
   * The page is unauthenticated — whoever holds the link is looking at it —
   * so what it does *not* carry is the interesting assertion.
   */
  it('carries nothing internal', async () => {
    const { invoice } = await anInvoice()
    const token = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]
    const found = await invoiceByShareToken(token)

    const serialised = JSON.stringify(found?.view)
    expect(serialised).not.toContain('ap@harborview.test')
    expect(serialised).not.toContain(fixture.companyId)
    expect(serialised).not.toContain(invoice.id)
    expect(serialised).not.toContain('journalEntry')
  })

  it('follows the live record, so a part payment moves what the customer sees', async () => {
    const { customer, invoice } = await anInvoice({ cents: 120_000 })
    const token = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    expect((await invoiceByShareToken(token))?.view.balanceCents).toBe(120_000)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 20_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 20_000 }],
    })

    const after = await invoiceByShareToken(token)
    expect(after?.view.balanceCents).toBe(100_000)
    expect(after?.view.paidCents).toBe(20_000)
    expect(after?.view.isSettled).toBe(false)
  })

  it('reads as settled once it is paid', async () => {
    const { customer, invoice } = await anInvoice({ cents: 50_000 })
    const token = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 50_000 }],
    })

    expect((await invoiceByShareToken(token))?.view.isSettled).toBe(true)
  })

  /**
   * Somebody who was sent a bill that was later cancelled should find a dead
   * link, not a document they might still pay.
   */
  it('dies when the invoice is voided', async () => {
    const { invoice } = await anInvoice()
    const token = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    await voidDocument(fixture.ctx, 'invoice', invoice.id)
    expect(await invoiceByShareToken(token)).toBeNull()
  })

  it('dies when it is revoked, and the invoice is untouched', async () => {
    const { invoice } = await anInvoice()
    const token = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    await revokeShareLink(fixture.ctx, invoice.id)
    expect(await invoiceByShareToken(token)).toBeNull()

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.status).not.toBe('void')
    expect(row.balanceCents).toBe(120_000)
  })

  it('gives a new link after a revoke, and the old one stays dead', async () => {
    const { invoice } = await anInvoice()
    const first = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    await revokeShareLink(fixture.ctx, invoice.id)
    const second = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    expect(second).not.toBe(first)
    expect(await invoiceByShareToken(first)).toBeNull()
    expect(await invoiceByShareToken(second)).not.toBeNull()
  })

  it('resolves nothing for a token nobody issued', async () => {
    expect(await invoiceByShareToken('not-a-real-token')).toBeNull()
    expect(await invoiceByShareToken('')).toBeNull()
    expect(await invoiceByShareToken('   ')).toBeNull()
  })

  it('counts views without failing the page', async () => {
    const { invoice } = await anInvoice()
    const token = (await shareLinkFor(fixture.ctx, invoice.id)).split('/i/')[1]

    await recordInvoiceView(token)
    await recordInvoiceView(token)

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(row.viewCount).toBe(2)
    expect(row.firstViewedAt).not.toBeNull()
    // The first view is the first one, not the latest.
    expect(row.firstViewedAt!.getTime()).toBeLessThanOrEqual(row.lastViewedAt!.getTime())

    // A token nobody issued is a no-op rather than a throw.
    await expect(recordInvoiceView('nope')).resolves.toBeUndefined()
  })
})
