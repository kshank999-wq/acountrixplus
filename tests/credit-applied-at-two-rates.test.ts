import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries, journalLines, chartAccounts } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
} from '@/modules/receivables/service'
import { applyCredit, createCreditNote } from '@/modules/receivables/credits'
import { applyVendorCredit, createVendorCredit } from '@/modules/receivables/vendor-credits'
import { putRate } from '@/modules/fx/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { trialBalance } from '@/modules/ledger/balances'

/**
 * The credit note applied at two rates (Phase 137).
 *
 * Applying a credit reduces **two** balances carried at **two** rates for one
 * face amount, and both paths posted nothing on the argument that "the credit
 * note already moved the receivable". True of the face amounts and false of the
 * functional ones.
 *
 * Measured before the fix: a €1,000 invoice raised at 1.10, credited in full by
 * a €1,000 note issued at 1.0835, left **$16.50** in Accounts Receivable with
 * the customer owing nothing — and `ledger.receivables`, a `fault`, failed on it
 * every night with no document left that could clear it.
 *
 * This is ADR 0114's defect in the two places its fix did not reach. It repaired
 * the path that spends a **held payment**; the two that spend a **credit note**
 * were never looked at.
 */

let fixture: Fixture
let revenueId: string
let expenseId: string

/** 1.10 when the document went out; 1.0835 when the credit was issued. */
const RAISED = 1_100_000
const CREDITED = 1_083_500

/** €1,000 at 1.10 is $1,100.00; at 1.0835 it is $1,083.50. */
const DOCUMENT_FUNCTIONAL = 110_000
const NOTE_FUNCTIONAL = 108_350
const DIFFERENCE = DOCUMENT_FUNCTIONAL - NOTE_FUNCTIONAL // 1650

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Two Rates Co' })
  revenueId = (await fixture.account('4000')).id
  expenseId = (await fixture.account('6000')).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: RAISED,
    source: 'manual',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-07-01',
    rateMillionths: CREDITED,
    source: 'manual',
  })
})

/** What 7100 holds, signed the way the trial balance reads it. */
async function exchangeBalance(): Promise<number> {
  const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
  return (
    balances.rows.find((row: { number: string; balanceCents: number }) => row.number === '7100')
      ?.balanceCents ?? 0
  )
}

async function euroInvoiceAndNote(faceCents: number) {
  const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-06-01',
    dueDate: '2026-07-31',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: faceCents }],
  })

  const note = await createCreditNote(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-07-01',
    invoiceId: invoice.id,
    lines: [{ chartAccountId: revenueId, description: 'Goodwill', unitPriceCents: faceCents }],
  })

  return { customer, invoice, note }
}

describe('a euro credit note against a euro invoice', () => {
  it('leaves the control account agreeing with the subledger', async () => {
    // The assertion the whole phase exists for. Before this, `agrees` was false
    // and `ledger.receivables` — severity `fault` — failed every night on a
    // difference nobody could clear: the invoice settled, the note spent, and
    // no document left to point at.
    const { invoice, note } = await euroInvoiceAndNote(100_000)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    const after = await controlAccounts(fixture.ctx, {})
    expect(after.receivables.subledgerCents).toBe(0)
    expect(after.receivables.ledgerCents).toBe(0)
    expect(after.receivables.agrees).toBe(true)
  })

  it('names the $16.50 as a realised loss rather than losing it', async () => {
    const { invoice, note } = await euroInvoiceAndNote(100_000)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    // We billed when the euro was strong and credited it back when the euro was
    // weak, so the receivable we gave up was worth less than the one we raised.
    // 7100 is other income, so a loss reads negative.
    expect(await exchangeBalance()).toBe(-DIFFERENCE)
  })

  it('posts one entry of exactly the difference, not the face amount', async () => {
    // The thing the old comment was right to refuse: posting the *amount* again
    // would halve the receivable twice. Only the gap is posted.
    const { invoice, note } = await euroInvoiceAndNote(100_000)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.sourceType, 'credit_application'),
        ),
      )

    expect(entries.length).toBe(1)
    expect(entries[0].entryDate).toBe('2026-07-02')

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entries[0].id))

    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line.debitCents + line.creditCents).toBe(DIFFERENCE)
    }

    // Dated the day it was applied, not the day either document was raised
    // (Phase 113's rule, which is what keeps a July application out of a closed
    // March).
    const control = await db
      .select({ id: chartAccounts.id })
      .from(chartAccounts)
      .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, '1100')))

    const arLine = lines.find((line) => line.chartAccountId === control[0].id)
    expect(arLine?.creditCents).toBe(DIFFERENCE)
  })

  it('agrees after a part application too, and after the rest', async () => {
    // The last application takes whatever functional remainder is left, so the
    // two columns reach zero together — and the difference is posted on each
    // part rather than saved up for the end.
    const { invoice, note } = await euroInvoiceAndNote(100_000)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 40_000,
      appliedOn: '2026-07-02',
    })

    const midway = await controlAccounts(fixture.ctx, {})
    expect(midway.receivables.agrees).toBe(true)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 60_000,
      appliedOn: '2026-07-03',
    })

    const after = await controlAccounts(fixture.ctx, {})
    expect(after.receivables.agrees).toBe(true)
    expect(after.receivables.ledgerCents).toBe(0)
    // Rounding across two parts still sums to the whole difference.
    expect(await exchangeBalance()).toBe(-DIFFERENCE)
  })
})

describe('a domestic credit note, which is most of them', () => {
  it('posts no entry at all, exactly as before', async () => {
    // Why a hundred and thirty phases never saw this: with one currency both
    // documents are carried at 1.0 and the difference is always zero.
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview Homes' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-31',
      lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: 100_000 }],
    })

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-07-01',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenueId, description: 'Goodwill', unitPriceCents: 100_000 }],
    })

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.sourceType, 'credit_application'),
        ),
      )

    expect(entries.length).toBe(0)
    expect(await exchangeBalance()).toBe(0)

    const after = await controlAccounts(fixture.ctx, {})
    expect(after.receivables.agrees).toBe(true)
  })
})

describe('the payables mirror', () => {
  it('calls the same rate movement a gain, and agrees again', async () => {
    // The direction that is not symmetric. A debt that got cheaper before we
    // settled it is money made, where the same movement on an invoice is money
    // lost — which is why `meets` is told which control account it is in.
    const vendor = await createVendor(fixture.ctx, { name: 'Hafen Logistik GmbH' })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-31',
      currency: 'EUR',
      lines: [{ chartAccountId: expenseId, description: 'Freight', unitPriceCents: 100_000 }],
    })

    const note = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-07-01',
      billId: bill.id,
      lines: [{ chartAccountId: expenseId, description: 'Overcharge', unitPriceCents: 100_000 }],
    })

    await applyVendorCredit(fixture.ctx, {
      creditNoteId: note.id,
      billId: bill.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    const after = await controlAccounts(fixture.ctx, {})
    expect(after.payables.agrees).toBe(true)
    expect(after.payables.ledgerCents).toBe(0)

    // A gain, where the customer side of the same movement was a loss.
    expect(await exchangeBalance()).toBe(DIFFERENCE)
  })

  it('leaves a domestic bill untouched', async () => {
    const vendor = await createVendor(fixture.ctx, { name: 'Harborview Supply' })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-06-01',
      dueDate: '2026-07-31',
      lines: [{ chartAccountId: expenseId, description: 'Freight', unitPriceCents: 100_000 }],
    })

    const note = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-07-01',
      billId: bill.id,
      lines: [{ chartAccountId: expenseId, description: 'Overcharge', unitPriceCents: 100_000 }],
    })

    await applyVendorCredit(fixture.ctx, {
      creditNoteId: note.id,
      billId: bill.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    expect(await exchangeBalance()).toBe(0)
    const after = await controlAccounts(fixture.ctx, {})
    expect(after.payables.agrees).toBe(true)
  })
})

describe('the books still balance', () => {
  it('keeps the trial balance balanced through a foreign application', async () => {
    const { invoice, note } = await euroInvoiceAndNote(100_000)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-07-02',
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(balances.isBalanced).toBe(true)
  })
})
