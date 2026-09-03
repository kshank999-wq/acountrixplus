import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, createVendor, createBill } from '@/modules/receivables/service'
import { applyCredit, createCreditNote } from '@/modules/receivables/credits'
import { createVendorCredit } from '@/modules/receivables/vendor-credits'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { runIntegrityChecks } from '@/modules/integrity/service'
import { checkByKey } from '@/modules/integrity/register'

/**
 * The document that moved the control account and left no trace (Phase 106).
 *
 * Phase 31 proved 1100 against the open invoices, and a credit note credits
 * 1100 the moment it is issued — `applyCredit` posts no journal entry at all,
 * because the money already moved. So between issue and application the check
 * reported a *fault*, its highest severity, on a state the application fully
 * supports; 2000 had the same hole via vendor credits.
 *
 * The measured failure, before this phase: a $1,000 invoice with a $300 credit
 * against it read `ledger=70000 subledger=100000`.
 */

describe('against the database', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Control Account Co' })
  })

  const customerWithInvoice = async (cents = 100_000) => {
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: cents }],
    })
    return { revenue, customer, invoice }
  }

  const vendorWithBill = async (cents = 80_000) => {
    const expense = await fixture.account('6000')
    const vendor = await createVendor(fixture.ctx, { name: 'Kestrel Supply' })
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: expense.id, description: 'Parts', unitPriceCents: cents }],
    })
    return { expense, vendor, bill }
  }

  it('agrees while a credit note sits unapplied', async () => {
    const { revenue, customer, invoice } = await customerWithInvoice()

    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill, not yet applied',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    // Both sides at 70000: the ledger because the credit posted, the subledger
    // because the credit is now counted. Before this phase, 70000 against
    // 100000 and a fault.
    expect(receivables.ledgerCents).toBe(70_000)
    expect(receivables.subledgerCents).toBe(70_000)
    expect(receivables.agrees).toBe(true)
  })

  it('still agrees once it is applied, with nothing double-counted', async () => {
    // Applying posts no entry, so the ledger does not move. The subledger must
    // not move either: the invoice falls by 300 and the credit's remaining
    // balance falls by the same, which is why counting both is safe.
    const { revenue, customer, invoice } = await customerWithInvoice()

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill',
    })
    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 30_000,
      appliedOn: '2026-03-16',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.ledgerCents).toBe(70_000)
    expect(receivables.subledgerCents).toBe(70_000)
    expect(receivables.agrees).toBe(true)
  })

  it('agrees while a vendor credit sits unapplied', async () => {
    const { expense, vendor, bill } = await vendorWithBill()

    await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-15',
      billId: bill.id,
      lines: [{ chartAccountId: expense.id, description: 'Returned', unitPriceCents: 20_000 }],
      reason: 'Returned goods',
    })

    const { payables } = await controlAccounts(fixture.ctx)

    expect(payables.ledgerCents).toBe(60_000)
    expect(payables.subledgerCents).toBe(60_000)
    expect(payables.agrees).toBe(true)
  })

  it('takes the credit off the customer who holds it, not off the total alone', async () => {
    // The list of who owes what has to net too, or the check agrees while
    // naming a figure against a customer that nobody owes.
    const { revenue, customer, invoice } = await customerWithInvoice()
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.parties).toHaveLength(1)
    expect(receivables.parties[0].name).toBe('Harborview LLC')
    expect(receivables.parties[0].balanceCents).toBe(70_000)
  })

  it('drops a customer whose credit covers everything they owe', async () => {
    const { revenue, customer, invoice } = await customerWithInvoice()
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      reason: 'Billed for work never done',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.subledgerCents).toBe(0)
    expect(receivables.agrees).toBe(true)
    expect(receivables.parties).toEqual([])
  })

  it('still catches an entry posted straight at the control account', async () => {
    // The defect Phase 31 exists for. Counting credit notes must not make the
    // check blind to it.
    const { customer } = await customerWithInvoice()
    expect(customer.id).toBeTruthy()

    const ar = await fixture.account('1100')
    const revenue = await fixture.account('4100')
    const { createJournalEntry } = await import('@/modules/ledger/journal')
    const { db } = await import('@/db')
    await createJournalEntry(
      fixture.ctx,
      {
        entryDate: '2026-04-01',
        memo: 'Straight at the control account',
        lines: [
          { chartAccountId: ar.id, debitCents: 36_500 },
          { chartAccountId: revenue.id, creditCents: 36_500 },
        ],
      },
      db,
    )

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.agrees).toBe(false)
    expect(receivables.differenceCents).toBe(36_500)
  })

  it('says what the figure is made of', async () => {
    const { revenue, customer, invoice } = await customerWithInvoice()
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.composition).toBe(
      '1 invoice worth $1,000.00, 1 credit note less $300.00',
    )
  })

  it('names a customer whose only document is a credit note', async () => {
    // Grouped on the foreign key rather than joined to the invoice rows, so a
    // party with no open invoice would otherwise come out unnamed.
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Beacon Ltd' })
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 25_000 }],
      reason: 'Standalone goodwill before the next invoice',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.parties.map((party) => party.name)).toEqual(['Beacon Ltd'])
    // Money the business owes them, kept rather than clamped away.
    expect(receivables.parties[0].balanceCents).toBe(-25_000)
    expect(receivables.subledgerCents).toBe(-25_000)
    expect(receivables.agrees).toBe(true)
  })

  it('reports the whole thing through the register, and passes', async () => {
    const { revenue, customer, invoice } = await customerWithInvoice()
    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 30_000 }],
      reason: 'Goodwill',
    })

    const run = await runIntegrityChecks(fixture.ctx)
    const finding = run.findings.find((row: { key: string }) => row.key === 'ledger.receivables')!

    expect(finding.agrees).toBe(true)
    expect(finding.detail).toContain('1 credit note less')
    expect(finding.detail).toContain('Harborview LLC')
  })

  it('keeps one company’s credit notes out of another’s control account', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else Ltd' })
    const revenue = await other.account('4100')
    const customer = await createCustomer(other.ctx, { name: 'Their Customer' })
    await createCreditNote(other.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 90_000 }],
      reason: 'Theirs, not ours',
    })

    const { receivables } = await controlAccounts(fixture.ctx)

    expect(receivables.subledgerCents).toBe(0)
    expect(receivables.parties).toEqual([])
  })
})

describe('the register says what it now compares', () => {
  it('names credit notes on both control accounts', () => {
    const receivables = checkByKey('ledger.receivables')!
    const payables = checkByKey('ledger.payables')!

    expect(receivables.compares).toContain('credit notes')
    expect(payables.compares).toContain('vendor credits')
    // And says why, since "issued" versus "applied" is the whole distinction.
    expect(receivables.meaning).toContain('when it is issued')
  })
})
