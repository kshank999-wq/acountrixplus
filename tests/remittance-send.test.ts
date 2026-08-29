import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { payments, transactionalMessages } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import {
  remittanceByToken,
  remittanceLinkFor,
  RemittanceError,
  sendRemittance,
} from '@/modules/payables/remittance-send'
import { voidPayment } from '@/modules/receivables/payment-voiding'

/**
 * Telling a supplier what a payment was for (Phase 58).
 *
 * The decision is asserted in `remittance.test.ts` with no database. Under test
 * here is the half that touches the world: that the advice lists what the
 * payment actually settled, that the send is recorded, and — the case that
 * matters most — that a supplier holding a link for a payment later voided is
 * told the money came back.
 */

let fixture: Fixture
let expenseId: string
let bankId: string
let vendorId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Remittance Co' })
  expenseId = (await fixture.account('6000')).id
  bankId = (
    await createFinancialAccount(fixture.ctx, {
      name: 'Business Checking',
      kind: 'checking',
      mask: '4471',
    })
  ).id
  vendorId = (
    await createVendor(fixture.ctx, {
      name: 'Cascade Building Supply',
      email: 'ar@cascade.test',
    })
  ).id
})

async function aBill(cents: number, reference: string) {
  const bill = await createBill(fixture.ctx, {
    vendorId,
    issueDate: '2026-06-01',
    dueDate: '2026-07-01',
    vendorReference: reference,
    lines: [{ chartAccountId: expenseId, description: 'Timber', unitPriceCents: cents }],
  })

  // Phase 50's approvals are off unless a company switches them on, and this
  // fixture leaves them off: the bill is payable as entered. Turning them on
  // here would test Phase 50 again rather than what the supplier is told.
  return bill
}

async function payBills(bills: { id: string; cents: number }[]) {
  return recordPayment(fixture.ctx, {
    kind: 'disbursement',
    vendorId,
    paymentDate: '2026-07-15',
    amountCents: bills.reduce((sum, b) => sum + b.cents, 0),
    financialAccountId: bankId,
    reference: 'BACS 88213',
    applications: bills.map((b) => ({ billId: b.id, amountCents: b.cents })),
  })
}

describe('sending it', () => {
  it('records that it went, and where', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])

    const result = await sendRemittance(fixture.ctx, payment.id)

    expect(result.to).toBe('ar@cascade.test')
    expect(result.isResend).toBe(false)
    expect(result.delivered).toBe(true)

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.remittanceSentAt).not.toBeNull()
    expect(row.remittanceSentTo).toBe('ar@cascade.test')
    expect(row.remittanceSendCount).toBe(1)
    expect(row.shareToken).toBeTruthy()
  })

  it('writes a message somebody can find afterwards', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])
    await sendRemittance(fixture.ctx, payment.id)

    const [message] = await db
      .select()
      .from(transactionalMessages)
      .where(eq(transactionalMessages.reference, `remittance:${payment.id}`))

    expect(message.kind).toBe('remittance')
    expect(message.outcome).toBe('sent')
    expect(message.subject).toContain('Remittance advice from Remittance Co')
  })

  it('counts the times it went', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])

    await sendRemittance(fixture.ctx, payment.id)
    const second = await sendRemittance(fixture.ctx, payment.id)

    expect(second.isResend).toBe(true)

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.remittanceSendCount).toBe(2)
  })

  it('keeps the same link across sends', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])

    const first = await sendRemittance(fixture.ctx, payment.id)
    const second = await sendRemittance(fixture.ctx, payment.id)

    expect(second.url).toBe(first.url)
  })

  /** Sending a customer one would tell them the business had paid *them*. */
  it('refuses money that came in rather than went out', async () => {
    const customer = await createCustomer(fixture.ctx, {
      name: 'A Customer',
      email: 'ap@customer.test',
    })
    const revenue = await fixture.account('4000')
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 50_000 }],
    })
    const receipt = await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-07-15',
      amountCents: 50_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 50_000 }],
    })

    await expect(sendRemittance(fixture.ctx, receipt.id)).rejects.toThrow(RemittanceError)
    await expect(sendRemittance(fixture.ctx, receipt.id)).rejects.toThrow(/money you paid out/)
  })

  it('refuses a supplier with no address, and says what to do', async () => {
    const quiet = await createVendor(fixture.ctx, { name: 'No Email Supply' })
    const bill = await createBill(fixture.ctx, {
      vendorId: quiet.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      vendorReference: 'NE-1',
      lines: [{ chartAccountId: expenseId, description: 'Sand', unitPriceCents: 10_000 }],
    })
    const payment = await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: quiet.id,
      paymentDate: '2026-07-15',
      amountCents: 10_000,
      financialAccountId: bankId,
      applications: [{ billId: bill.id, amountCents: 10_000 }],
    })

    await expect(sendRemittance(fixture.ctx, payment.id)).rejects.toThrow(/Get link/)
  })

  it('refuses one that is not on these books', async () => {
    await expect(
      sendRemittance(fixture.ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/not on these books/)
  })
})

describe('what the supplier opens', () => {
  it('lists the bills the payment settled, by their own reference', async () => {
    const first = await aBill(250_000, 'CBS-4471')
    const second = await aBill(150_000, 'CBS-4482')
    const payment = await payBills([
      { id: first.id, cents: 250_000 },
      { id: second.id, cents: 150_000 },
    ])

    const result = await sendRemittance(fixture.ctx, payment.id)
    const view = (await remittanceByToken(result.url.split('/').pop()!))!

    expect(view.amountCents).toBe(400_000)
    expect(view.appliedCents).toBe(400_000)
    expect(view.bills.map((b) => b.vendorReference)).toEqual(['CBS-4471', 'CBS-4482'])
    expect(view.supplierName).toBe('Cascade Building Supply')
  })

  it('shows the company and nothing around it', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])
    const result = await sendRemittance(fixture.ctx, payment.id)

    const view = (await remittanceByToken(result.url.split('/').pop()!))!

    expect(view.company.name).toBe('Remittance Co')
    expect(view).not.toHaveProperty('companyId')
    expect(view).not.toHaveProperty('vendorId')
  })

  it('is nothing at all for a token that was never minted', async () => {
    expect(await remittanceByToken('not-a-real-token')).toBeNull()
    expect(await remittanceByToken('')).toBeNull()
  })

  /**
   * The substance of the phase's one real design decision. A remittance needs
   * no freezing because a posted payment does not change — except that Phase 52
   * made one voidable, and reading live is exactly what lets the page tell a
   * supplier the money came back. A snapshot would have gone on claiming it
   * stood.
   */
  it('says so when the payment was voided after the advice went', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])
    const result = await sendRemittance(fixture.ctx, payment.id)
    const token = result.url.split('/').pop()!

    expect((await remittanceByToken(token))!.isVoided).toBe(false)

    await voidPayment(fixture.ctx, {
      paymentId: payment.id,
      reason: 'Sent to the wrong account',
    })

    const after = (await remittanceByToken(token))!
    expect(after.isVoided).toBe(true)
    expect(after.voidReason).toBe('Sent to the wrong account')
  })

  it('will not send a fresh advice for a payment already voided', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])
    await voidPayment(fixture.ctx, { paymentId: payment.id, reason: 'Duplicate' })

    await expect(sendRemittance(fixture.ctx, payment.id)).rejects.toThrow(/voided/)
  })
})

describe('handing somebody the link', () => {
  /** A link is not an advice. Recording it as one would be a claim too far. */
  it('does not mark the payment as advised', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])

    const url = await remittanceLinkFor(fixture.ctx, payment.id)
    expect(url).toContain('/r/')

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.shareToken).toBeTruthy()
    expect(row.remittanceSentAt).toBeNull()
    expect(row.remittanceSendCount).toBe(0)
  })

  it('hands back the same link the email would use', async () => {
    const bill = await aBill(400_000, 'CBS-4471')
    const payment = await payBills([{ id: bill.id, cents: 400_000 }])

    const link = await remittanceLinkFor(fixture.ctx, payment.id)
    const sent = await sendRemittance(fixture.ctx, payment.id)

    expect(sent.url).toBe(link)
  })
})
