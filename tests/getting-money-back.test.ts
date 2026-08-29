import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { creditNotes, refunds } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
} from '@/modules/receivables/service'
import { createCreditNote } from '@/modules/receivables/credits'
import { createVendorCredit, refundVendorCredit } from '@/modules/receivables/vendor-credits'
import { putRate } from '@/modules/fx/service'
import { convert } from '@/modules/fx/rates'
import { trialBalance } from '@/modules/ledger/balances'
import { splitReceipt } from '@/modules/receivables/overpayment'
import { DomainError } from '@/modules/errors'

/**
 * The money the supplier owes you back (Phase 68).
 *
 * A vendor credit posts `Dr Accounts Payable / Cr Expense` when it is issued,
 * and applying it to a bill posts nothing. So an unapplied credit is a debit
 * sitting in payables — money the supplier owes back, netted against everything
 * else the business owes them.
 *
 * That is right while more bills are coming. When the relationship ends, no
 * bill ever arrives to apply it to, `splitReceipt`'s remedy is advice nobody
 * can take, and the credit understates what is owed to other suppliers for
 * ever. ADR 0067 named it as the mirror of the retainer it had just fixed.
 */

let fixture: Fixture
let expenseId: string
let revenueId: string

/** 1.0835 when the credit was raised; 1.10 when the money came back. */
const RAISED = 1_083_500
const RETURNED = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Recovery Co' })
  expenseId = (await fixture.account('6000')).id
  revenueId = (await fixture.account('4000')).id

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

async function euroCredit(amountCents = 50_000) {
  const vendor = await createVendor(fixture.ctx, { name: 'Hafen Logistik GmbH' })

  const bill = await createBill(fixture.ctx, {
    vendorId: vendor.id,
    issueDate: '2026-04-01',
    dueDate: '2026-05-01',
    currency: 'EUR',
    lines: [{ chartAccountId: expenseId, description: 'Freight', unitPriceCents: 200_000 }],
  })

  const credit = await createVendorCredit(fixture.ctx, {
    vendorId: vendor.id,
    issueDate: '2026-04-01',
    billId: bill.id,
    lines: [{ chartAccountId: expenseId, description: 'Overcharge', unitPriceCents: amountCents }],
  })

  return { vendor, bill, credit }
}

describe('the refusal that pointed at a dead end', () => {
  /**
   * `splitReceipt` still refuses an over-payment to a supplier, and should —
   * a vendor credit is the right home for it. What changed is that the remedy
   * is now something a person can actually finish.
   */
  it('still sends an over-payment to a vendor credit', () => {
    const verdict = splitReceipt({
      kind: 'disbursement',
      amountCents: 100_000,
      appliedCents: 80_000,
      hasParty: true,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('raise a vendor credit')
  })

  it('says the credit can be taken back in cash', () => {
    const verdict = splitReceipt({
      kind: 'disbursement',
      amountCents: 100_000,
      appliedCents: 80_000,
      hasParty: true,
    })

    expect(verdict.ok === false && verdict.why).toContain('taken back in cash')
  })
})

describe('getting a vendor credit back', () => {
  /** The operation ADR 0067 said did not exist. */
  it('can be done at all', async () => {
    const { credit } = await euroCredit()

    const result = await refundVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.refundedCents).toBe(50_000)
    expect(result.currency).toBe('EUR')
    expect(result.remainingCents).toBe(0)
  })

  /**
   * The substance, and the sign. €500 raised at 1.0835 is a $541.75 debit in
   * payables; the supplier returns it when the euro is worth 1.10, so $550.00
   * arrives. The $8.25 is a **gain** — the business is getting back money that
   * became more valuable while the supplier held it.
   *
   * The same movement on a retainer is a loss (Phase 67), which is exactly why
   * `recoverHeld` exists rather than reusing `settleHeld`.
   */
  it('banks what actually arrived, and realises the difference as a gain', async () => {
    const { credit } = await euroCredit()

    const result = await refundVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.receivedCents).toBe(convert(50_000, RETURNED))
    expect(result.realisedCents).toBe(convert(50_000, RETURNED) - convert(50_000, RAISED))
    expect(result.realisedCents).toBe(825)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)

    // 7100 is other income, so a gain reads positive — the opposite of the
    // retainer refund in Phase 67, on the same rate movement.
    const fx = balances.rows.find(
      (row: { number: string; balanceCents: number }) => row.number === '7100',
    )?.balanceCents
    expect(fx).toBe(825)
  })

  it('records it as money coming in, not going out', async () => {
    const { credit } = await euroCredit()

    await refundVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      amountCents: 20_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
      reference: 'Wire 5512',
    })

    const [row] = await db.select().from(refunds).where(eq(refunds.subjectId, credit.id))

    expect(row.subjectType).toBe('credit_note')
    expect(row.direction).toBe('in')
    expect(row.amountCents).toBe(20_000)
    expect(row.carriedCents).toBe(convert(20_000, RAISED))
    expect(row.cashCents).toBe(convert(20_000, RETURNED))
    // Coming in, the cash debited covers the balance plus the gap — the other
    // way round from a refund, which is what `direction` is for.
    expect(row.cashCents).toBe(row.carriedCents + row.realisedCents)
    expect(row.reference).toBe('Wire 5512')
  })

  it('takes both halves of what is left down together', async () => {
    const { credit } = await euroCredit()

    for (const piece of [20_000, 20_000, 10_000]) {
      await refundVendorCredit(fixture.ctx, {
        creditNoteId: credit.id,
        amountCents: piece,
        financialAccountId: fixture.financialAccountId,
        refundedOn: '2026-06-15',
      })
    }

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, credit.id))
    expect(row.remainingCents).toBe(0)
    expect(row.functionalRemainingCents).toBe(0)
    expect(row.status).toBe('applied')
  })

  it('empties the payable it was sitting in', async () => {
    const { credit } = await euroCredit()

    const before = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    const payableBefore =
      before.rows.find((row: { number: string; balanceCents: number }) => row.number === '2000')
        ?.balanceCents ?? 0

    await refundVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    const after = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    const payableAfter =
      after.rows.find((row: { number: string; balanceCents: number }) => row.number === '2000')
        ?.balanceCents ?? 0

    // The credit's debit is gone from payables: what the business owes this
    // supplier goes back up by what it has just been handed.
    expect(payableAfter - payableBefore).toBe(convert(50_000, RAISED))
    expect(after.isBalanced).toBe(true)
  })

  /**
   * The refusal has to reach the person. Only `DomainError` messages survive
   * the server-action boundary — everything else is logged and replaced with
   * "Something went wrong", which is what this module did for all 25 of its
   * refusals until Phase 68 (found in the browser, not by a test).
   */
  it('refuses in a way the screen can actually print', async () => {
    const { credit } = await euroCredit()

    await expect(
      refundVendorCredit(fixture.ctx, {
        creditNoteId: credit.id,
        amountCents: 80_000,
        financialAccountId: fixture.financialAccountId,
        refundedOn: '2026-06-15',
      }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('refuses more than is left, in the supplier’s own currency', async () => {
    const { credit } = await euroCredit()

    await expect(
      refundVendorCredit(fixture.ctx, {
        creditNoteId: credit.id,
        amountCents: 80_000,
        financialAccountId: fixture.financialAccountId,
        refundedOn: '2026-06-15',
      }),
    ).rejects.toThrow(/Only €500\.00 is held for this supplier/)
  })

  it('refuses a customer credit note, which is refunded from its payment', async () => {
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Homes' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 100_000 }],
    })
    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Goodwill', unitPriceCents: 20_000 }],
    })

    await expect(
      refundVendorCredit(fixture.ctx, {
        creditNoteId: note.id,
        amountCents: 10_000,
        financialAccountId: fixture.financialAccountId,
        refundedOn: '2026-06-15',
      }),
    ).rejects.toThrow(/customer credit note/)
  })

  /** Domestic behaviour, realising nothing. */
  it('gives a domestic credit back with nothing to realise', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Harborview Supply' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      lines: [{ chartAccountId: expenseId, description: 'Parts', unitPriceCents: 100_000 }],
    })
    const credit = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-04-01',
      billId: bill.id,
      lines: [{ chartAccountId: expenseId, description: 'Returned', unitPriceCents: 30_000 }],
    })

    const result = await refundVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
      refundedOn: '2026-06-15',
    })

    expect(result.receivedCents).toBe(30_000)
    expect(result.realisedCents).toBe(0)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    expect(balances.isBalanced).toBe(true)
    expect(
      balances.rows.find(
        (row: { number: string; balanceCents: number }) => row.number === '7100',
      )?.balanceCents ?? 0,
    ).toBe(0)
  })
})
