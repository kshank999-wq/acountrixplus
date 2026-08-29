import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customerStatements, transactionalMessages } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { saveStatement } from '@/modules/receivables/statements'
import {
  sendStatement,
  SendStatementError,
  statementByToken,
  statementLinkFor,
} from '@/modules/receivables/statement-send'

/**
 * Getting a statement to the customer it is about (Phase 55).
 *
 * Two claims under test:
 *
 *  1. **A saved statement says nothing about where it went until it goes.**
 *     `sent_at` had existed since Phase 11 with nothing writing to it, while
 *     `sent_to` was filled in at *save* time — so the screen showed a
 *     statement, a date and an email address it had never been sent to.
 *  2. **What the customer opens is what was frozen.** Deliberately unlike the
 *     invoice link, which renders the live record: a statement is a claim
 *     about a moment, and a page that restated itself would mean the two
 *     parties could never be looking at the same document.
 */

let fixture: Fixture
let bankId: string
let revenueId: string
let customerId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Statement Co' })
  revenueId = (await fixture.account('4000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
  customerId = (
    await createCustomer(fixture.ctx, {
      name: 'Meridian Facilities Ltd',
      email: 'ap@meridian.test',
    })
  ).id
})

async function anInvoice(cents: number) {
  return createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    lines: [{ chartAccountId: revenueId, description: 'Survey', unitPriceCents: cents }],
  })
}

async function anAdvance(cents: number) {
  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-02-01',
    amountCents: cents,
    financialAccountId: bankId,
    applications: [],
  })
}

const aStatement = () => saveStatement(fixture.ctx, { customerId, asOfDate: '2026-06-30' })

describe('saving a statement', () => {
  /**
   * The defect itself. Before this phase, `saveStatement` wrote the customer's
   * address into `sent_to` and nothing ever wrote `sent_at` — so a business
   * reading that row would conclude the customer had been told.
   */
  it('claims nothing about having sent it', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    expect(saved.sentAt).toBeNull()
    expect(saved.sentTo).toBeNull()
    expect(saved.sendCount).toBe(0)
    expect(saved.shareToken).toBeNull()
  })
})

describe('sending it', () => {
  it('records that it went, and where', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    const result = await sendStatement(fixture.ctx, saved.id)

    expect(result.to).toBe('ap@meridian.test')
    expect(result.isResend).toBe(false)
    expect(result.delivered).toBe(true)

    const [row] = await db
      .select()
      .from(customerStatements)
      .where(eq(customerStatements.id, saved.id))

    expect(row.sentAt).not.toBeNull()
    expect(row.sentTo).toBe('ap@meridian.test')
    expect(row.sendCount).toBe(1)
    expect(row.shareToken).toBeTruthy()
  })

  it('writes a message somebody can find afterwards', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()
    await sendStatement(fixture.ctx, saved.id)

    const [message] = await db
      .select()
      .from(transactionalMessages)
      .where(eq(transactionalMessages.reference, `statement:${saved.id}`))

    expect(message.kind).toBe('statement')
    expect(message.outcome).toBe('sent')
    expect(message.subject).toContain('Statement to 2026-06-30')
  })

  /** "We have sent this three times" is the fact a chase conversation turns on. */
  it('counts the times it went, and says the later ones are resends', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    await sendStatement(fixture.ctx, saved.id)
    const second = await sendStatement(fixture.ctx, saved.id)

    expect(second.isResend).toBe(true)

    const [row] = await db
      .select()
      .from(customerStatements)
      .where(eq(customerStatements.id, saved.id))

    expect(row.sendCount).toBe(2)
  })

  /** The token is minted once and never rotated, so an old link still opens. */
  it('keeps the same link across sends', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    const first = await sendStatement(fixture.ctx, saved.id)
    const second = await sendStatement(fixture.ctx, saved.id)

    expect(second.url).toBe(first.url)
  })

  it('sends to an address typed in instead of the one on file', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    const result = await sendStatement(fixture.ctx, saved.id, { to: 'cfo@meridian.test' })

    expect(result.to).toBe('cfo@meridian.test')
  })

  it('refuses a customer with no address, and says what to do', async () => {
    const other = await createCustomer(fixture.ctx, { name: 'No Email Ltd' })
    await createInvoice(fixture.ctx, {
      customerId: other.id,
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      lines: [{ chartAccountId: revenueId, description: 'x', unitPriceCents: 50_000 }],
    })
    const saved = await saveStatement(fixture.ctx, {
      customerId: other.id,
      asOfDate: '2026-06-30',
    })

    await expect(sendStatement(fixture.ctx, saved.id)).rejects.toThrow(SendStatementError)
    await expect(sendStatement(fixture.ctx, saved.id)).rejects.toThrow(/Get link/)
  })

  it('refuses a statement of nothing', async () => {
    const saved = await aStatement()

    await expect(sendStatement(fixture.ctx, saved.id)).rejects.toThrow(
      /nothing on this statement/,
    )
  })

  it('refuses one that is not on these books', async () => {
    await expect(
      sendStatement(fixture.ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/not on these books/)
  })
})

describe('what the customer opens', () => {
  /**
   * The substance of the phase's one real design decision. The invoice link
   * renders the live record and is right to; this must not, because a
   * statement the customer and the business see differently is not a statement.
   */
  it('shows the figures as they were frozen, not as they are now', async () => {
    const invoice = await anInvoice(90_000)
    await anAdvance(60_000)
    const saved = await aStatement()
    const result = await sendStatement(fixture.ctx, saved.id)

    // The books move underneath it: the credit is spent against the invoice.
    const { applyCredit } = await import('@/modules/receivables/customer-credit')
    const [payment] = await db
      .select()
      .from((await import('@/db/schema')).payments)
      .where(eq((await import('@/db/schema')).payments.customerId, customerId))
    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: invoice.id,
      appliedOn: '2026-07-01',
    })

    const token = result.url.split('/').pop()!
    const view = await statementByToken(token)

    expect(view).not.toBeNull()
    expect(view!.asOfDate).toBe('2026-06-30')
    expect(view!.closingBalanceCents).toBe(90_000)
    expect(view!.heldCreditCents).toBe(60_000)
    expect(view!.dueCents).toBe(30_000)
    expect(view!.isFrozen).toBe(true)
  })

  it('shows the customer and the company, and nothing around them', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()
    const result = await sendStatement(fixture.ctx, saved.id)

    const view = (await statementByToken(result.url.split('/').pop()!))!

    expect(view.customerName).toBe('Meridian Facilities Ltd')
    expect(view.company.name).toBe('Statement Co')
    // Nothing that would identify the books it came from, or anybody else on
    // them. The projection is an allowlist, so this is a floor, not a ceiling.
    expect(view).not.toHaveProperty('companyId')
    expect(view).not.toHaveProperty('customerId')
    expect(view).not.toHaveProperty('createdBy')
  })

  it('is nothing at all for a token that was never minted', async () => {
    expect(await statementByToken('not-a-real-token')).toBeNull()
    expect(await statementByToken('')).toBeNull()
  })
})

describe('handing somebody the link', () => {
  /**
   * A link is not a letter. Recording "Get link" as a send would put back
   * exactly the claim this phase removed.
   */
  it('does not mark the statement as sent', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    const url = await statementLinkFor(fixture.ctx, saved.id)
    expect(url).toContain('/s/')

    const [row] = await db
      .select()
      .from(customerStatements)
      .where(eq(customerStatements.id, saved.id))

    expect(row.shareToken).toBeTruthy()
    expect(row.sentAt).toBeNull()
    expect(row.sendCount).toBe(0)
  })

  it('hands back the same link the email would use', async () => {
    await anInvoice(90_000)
    const saved = await aStatement()

    const link = await statementLinkFor(fixture.ctx, saved.id)
    const sent = await sendStatement(fixture.ctx, saved.id)

    expect(sent.url).toBe(link)
  })

  /** Works for the customer with no address, which is what the refusal says to do. */
  it('works when there is nobody to email', async () => {
    const other = await createCustomer(fixture.ctx, { name: 'No Email Ltd' })
    await createInvoice(fixture.ctx, {
      customerId: other.id,
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      lines: [{ chartAccountId: revenueId, description: 'x', unitPriceCents: 50_000 }],
    })
    const saved = await saveStatement(fixture.ctx, {
      customerId: other.id,
      asOfDate: '2026-06-30',
    })

    await expect(statementLinkFor(fixture.ctx, saved.id)).resolves.toContain('/s/')
  })
})
