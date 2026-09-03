import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { createCreditNote, applyCredit, writeOffInvoice } from '@/modules/receivables/credits'
import { arAging } from '@/modules/ledger/reports'
import { controlAccounts } from '@/modules/ledger/receivables-check'

/**
 * The reports, asked about a date that is not today (Phase 108).
 *
 * Every one of them walked the ledger back to `asOf` and then read the document
 * balance as it stands now. Measured on the development books before the fix —
 * three answers to "what was owed on 31 March", none of them right:
 *
 * ```
 * as at 2026-03-31:  aging=124194  ledger=364194  subledger=4940069
 * ```
 *
 * The claim worth having is the last one in this file: the control account and
 * the documents behind it agree **at every date**, not only today.
 */

describe('a past date', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'History Co' })
  })

  /** An invoice raised in March, for 1,000.00. */
  const marchInvoice = async (name = 'Harborview LLC', cents = 100_000) => {
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: cents }],
    })
    return { revenue, customer, invoice }
  }


  it('shows an invoice paid in June as outstanding in March', async () => {
    const { invoice, customer } = await marchInvoice()
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-28',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const march = await arAging(fixture.ctx, { asOfDate: '2026-03-31' })
    const today = await arAging(fixture.ctx, { asOfDate: '2026-09-03' })

    // Before this phase, March read 0: the payment made it look settled all along.
    expect(march.totals.totalCents).toBe(100_000)
    expect(today.totals.totalCents).toBe(0)
  })

  it('shows a partly paid invoice at what was still owed then', async () => {
    const { invoice, customer } = await marchInvoice()
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-28',
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 30_000 }],
    })

    expect((await arAging(fixture.ctx, { asOfDate: '2026-03-31' })).totals.totalCents).toBe(
      100_000,
    )
    expect((await arAging(fixture.ctx, { asOfDate: '2026-09-03' })).totals.totalCents).toBe(
      70_000,
    )
  })

  it('counts a payment dated on the day itself as already received', async () => {
    const { invoice, customer } = await marchInvoice()
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-03-31',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    expect((await arAging(fixture.ctx, { asOfDate: '2026-03-31' })).totals.totalCents).toBe(0)
    expect((await arAging(fixture.ctx, { asOfDate: '2026-03-30' })).totals.totalCents).toBe(
      100_000,
    )
  })

  it('shows a debt written off in July as still owed in March', async () => {
    // Exactly what somebody looking at a historical aging wants to see: the
    // debt was real until the day it was given up on.
    const { invoice } = await marchInvoice()
    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-07-31',
      reason: 'Gone quiet for a year',
    })

    expect((await arAging(fixture.ctx, { asOfDate: '2026-03-31' })).totals.totalCents).toBe(
      100_000,
    )
    expect((await arAging(fixture.ctx, { asOfDate: '2026-09-03' })).totals.totalCents).toBe(0)
  })

  it('shows a credit applied in June as not yet applied in March', async () => {
    const { revenue, customer, invoice } = await marchInvoice()
    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill',
    })
    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 30_000,
      appliedOn: '2026-06-15',
    })

    const march = await arAging(fixture.ctx, { asOfDate: '2026-03-31' })

    // The invoice owed its full 1,000 in March; the credit existed but had not
    // been pointed at it yet, so it sits in the reconciliation line instead.
    expect(march.totals.totalCents).toBe(100_000)
    expect(march.credits).toEqual({ count: 1, functionalCents: 30_000 })
    expect(march.controlAccountCents).toBe(70_000)
  })

  it('leaves an invoice raised after the date out of it entirely', async () => {
    await marchInvoice()
    const revenue = await fixture.account('4100')
    const later = await createCustomer(fixture.ctx, { name: 'Later Ltd' })
    await createInvoice(fixture.ctx, {
      customerId: later.id,
      issueDate: '2026-05-01',
      dueDate: '2026-05-31',
      lines: [{ chartAccountId: revenue.id, description: 'Later work', unitPriceCents: 50_000 }],
    })

    const march = await arAging(fixture.ctx, { asOfDate: '2026-03-31' })

    expect(march.rows.map((row) => row.partyName)).toEqual(['Harborview LLC'])
    expect(march.totals.totalCents).toBe(100_000)
  })
})

describe('the control account, at every date', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Reconciling History Co' })
  })

  it('agrees in March as well as today', async () => {
    // The defect stated as one assertion. Before this phase the ledger walked
    // back and the documents did not, so any past date reported a fault on
    // healthy books -- the register's highest severity, from a date picker.
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-28',
      amountCents: 40_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 40_000 }],
    })

    for (const asOf of ['2026-03-31', '2026-05-31', '2026-06-30', '2026-09-03']) {
      const { receivables } = await controlAccounts(fixture.ctx, { asOf })
      expect(receivables.agrees, asOf).toBe(true)
      expect(receivables.subledgerCents, asOf).toBe(receivables.ledgerCents)
    }
  })

  it('reports the March figure, not today’s', async () => {
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-06-28',
      amountCents: 40_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 40_000 }],
    })

    const march = await controlAccounts(fixture.ctx, { asOf: '2026-03-31' })
    const today = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })

    expect(march.receivables.subledgerCents).toBe(100_000)
    expect(today.receivables.subledgerCents).toBe(60_000)
  })

  it('still catches a real split at a past date', async () => {
    // Restoring history must not make the check blind to what it exists for.
    const revenue = await fixture.account('4100')
    const ar = await fixture.account('1100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    const { createJournalEntry } = await import('@/modules/ledger/journal')
    const { db } = await import('@/db')
    await createJournalEntry(
      fixture.ctx,
      {
        entryDate: '2026-03-15',
        memo: 'Straight at the control account',
        lines: [
          { chartAccountId: ar.id, debitCents: 36_500 },
          { chartAccountId: revenue.id, creditCents: 36_500 },
        ],
      },
      db,
    )

    const march = await controlAccounts(fixture.ctx, { asOf: '2026-03-31' })

    expect(march.receivables.agrees).toBe(false)
    expect(march.receivables.differenceCents).toBe(36_500)
  })
})
