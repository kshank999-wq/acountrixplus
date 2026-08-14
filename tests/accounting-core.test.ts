import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices, journalEntries } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import {
  createCustomer,
  createInvoice,
  recordPayment,
} from '@/modules/receivables/service'
import {
  applyCredit,
  badDebtSummary,
  createCreditNote,
  listWriteOffs,
  recoverWriteOff,
  writeOffInvoice,
} from '@/modules/receivables/credits'
import { buildStatement, saveStatement } from '@/modules/receivables/statements'
import {
  createRecurringEntry,
  firstOccurrence,
  nextOccurrence,
  runDueRecurringEntries,
  setRecurringActive,
} from '@/modules/ledger/recurring'
import {
  closeFiscalYear,
  CloseBlockedError,
  previewClose,
  reopenFiscalYear,
} from '@/modules/ledger/closing'
import { profitAndLoss, balanceSheet } from '@/modules/ledger/reports'
import { accountBalances, trialBalance } from '@/modules/ledger/balances'
import { draftJournalEntry, postManualEntry } from '@/modules/ledger/journal'

/**
 * The accounting core completed (spec §13, ADR 0011).
 *
 * Credits, write-offs, statements, recurring entries, and the year-end close —
 * the §13 items that had been open since Phase 2.
 */

async function arFixture() {
  const fixture = await createCompanyFixture()
  const revenue = await fixture.account('4100')
  const customer = await createCustomer(fixture.ctx, {
    name: 'Harborview LLC',
    email: 'ap@harborview.test',
  })

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
  })

  return { fixture, revenue, customer, invoice }
}

describe('a credit note and a write-off are not the same thing', () => {
  it('a credit note takes the revenue back', async () => {
    const { fixture, customer, invoice } = await arFixture()

    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      reason: 'Billed for work that was never done',
      applyImmediately: true,
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // Never earned, so it should not be on the P&L at all.
    expect(pl.revenue.totalCents).toBe(0)
    expect(pl.operatingExpenses.totalCents).toBe(0)
  })

  it('a write-off keeps the revenue and records an expense', async () => {
    const { fixture, invoice } = await arFixture()

    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Customer entered administration',
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The sale happened. What is being recorded is that the money will not
    // arrive, and that is a cost of doing business.
    expect(pl.revenue.totalCents).toBe(100_000)
    expect(pl.operatingExpenses.totalCents).toBe(100_000)

    const badDebt = pl.operatingExpenses.rows.find((row) => row.number === '6025')
    expect(badDebt?.balanceCents).toBe(100_000)
  })

  it('leaves a written-off invoice saying so, rather than saying paid', async () => {
    const { fixture, invoice } = await arFixture()

    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Uncollectable',
    })

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1)

    // `paid` would erase the fact from every report that reads status, and
    // nobody paid.
    expect(row.status).toBe('written_off')
    expect(row.balanceCents).toBe(0)
  })

  it('refuses a write-off with no reason', async () => {
    const { fixture, invoice } = await arFixture()

    await expect(
      writeOffInvoice(fixture.ctx, invoice.id, { writtenOffOn: '2026-09-01', reason: '   ' }),
    ).rejects.toThrow(/why it is being written off/i)
  })

  it('refuses to write off more than is outstanding', async () => {
    const { fixture, invoice } = await arFixture()

    await expect(
      writeOffInvoice(fixture.ctx, invoice.id, {
        writtenOffOn: '2026-09-01',
        reason: 'Uncollectable',
        amountCents: 200_000,
      }),
    ).rejects.toThrow(/cannot be written off/i)
  })

  it('refuses to write the same debt off twice', async () => {
    const { fixture, invoice } = await arFixture()

    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Uncollectable',
    })

    // Doubling the bad-debt expense is the thing the unique constraint exists
    // to stop, and a check two requests could both pass would not.
    await expect(
      writeOffInvoice(fixture.ctx, invoice.id, {
        writtenOffOn: '2026-10-01',
        reason: 'Again',
      }),
    ).rejects.toThrow()
  })

  it('reverses the expense when a written-off debt is paid after all', async () => {
    const { fixture, invoice } = await arFixture()

    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Gone quiet',
    })

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-11-15',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // Revenue was recognized when the invoice was raised and never taken back.
    // Recognizing it again on recovery would count the sale twice.
    expect(pl.revenue.totalCents).toBe(100_000)
    expect(pl.operatingExpenses.totalCents).toBe(0)

    const summary = await badDebtSummary(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(summary.writtenOffCents).toBe(100_000)
    expect(summary.recoveredCents).toBe(100_000)
    expect(summary.netCents).toBe(0)
  })
})

describe('credit notes', () => {
  it('defaults its lines to the invoice it credits', async () => {
    const { fixture, customer, invoice } = await arFixture()

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
      reason: 'Returned',
    })

    // Reversing to the same accounts the revenue landed on is what makes a
    // credited sale disappear from the right revenue line.
    expect(note.totalCents).toBe(100_000)
    expect(note.remainingCents).toBe(100_000)
  })

  it('reduces the invoice balance only when applied', async () => {
    const { fixture, customer, invoice } = await arFixture()

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
    })

    let [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1)
    expect(row.balanceCents).toBe(100_000)

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 40_000,
      appliedOn: '2026-03-20',
    })
    ;[row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1)
    expect(row.balanceCents).toBe(60_000)
  })

  it('posts no second entry when a credit is applied', async () => {
    const { fixture, customer, invoice } = await arFixture()

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
    })

    const before = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-03-20',
    })

    const after = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })

    // The credit note already moved the receivable. Applying it decides which
    // invoice the reduction belongs to; a second entry would halve AR twice.
    expect(after.totalDebitCents).toBe(before.totalDebitCents)
  })

  it('will not apply more credit than is left', async () => {
    const { fixture, customer, invoice } = await arFixture()

    const note = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      invoiceId: invoice.id,
    })

    await applyCredit(fixture.ctx, {
      creditNoteId: note.id,
      invoiceId: invoice.id,
      amountCents: 100_000,
      appliedOn: '2026-03-20',
    })

    await expect(
      applyCredit(fixture.ctx, {
        creditNoteId: note.id,
        invoiceId: invoice.id,
        amountCents: 1,
        appliedOn: '2026-03-21',
      }),
    ).rejects.toThrow(/is left to apply/i)
  })

  it('will not credit one customer against another’s invoice', async () => {
    const { fixture, customer, invoice, revenue } = await arFixture()
    const other = await createCustomer(fixture.ctx, { name: 'Someone Else' })

    const note = await createCreditNote(fixture.ctx, {
      customerId: other.id,
      issueDate: '2026-03-15',
      lines: [{ chartAccountId: revenue.id, description: 'Goodwill', unitPriceCents: 10_000 }],
    })

    await expect(
      applyCredit(fixture.ctx, {
        creditNoteId: note.id,
        invoiceId: invoice.id,
        amountCents: 10_000,
        appliedOn: '2026-03-20',
      }),
    ).rejects.toThrow(/same customer/i)

    void customer
  })

  it('will not credit more than the invoice was for', async () => {
    const { fixture, customer, invoice, revenue } = await arFixture()

    await expect(
      createCreditNote(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-03-15',
        invoiceId: invoice.id,
        lines: [{ chartAccountId: revenue.id, description: 'Too much', unitPriceCents: 200_000 }],
      }),
    ).rejects.toThrow(/more than invoice/i)
  })
})

describe('customer statements', () => {
  it('lists what is unpaid, on an open-item statement', async () => {
    const { fixture, customer, invoice, revenue } = await arFixture()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      dueDate: '2026-04-30',
      lines: [{ chartAccountId: revenue.id, description: 'More work', unitPriceCents: 50_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-15',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-06-30',
    })

    // The paid one is gone; only what is still owed is listed.
    expect(statement.lines).toHaveLength(1)
    expect(statement.closingBalanceCents).toBe(50_000)
  })

  it('carries a balance in and out, on a balance-forward statement', async () => {
    const { fixture, customer, invoice, revenue } = await arFixture()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-10',
      lines: [{ chartAccountId: revenue.id, description: 'April', unitPriceCents: 50_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-20',
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 30_000 }],
    })

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-04-30',
      kind: 'balance_forward',
      periodStart: '2026-04-01',
    })

    // March's invoice is the opening balance; April's activity is the body.
    expect(statement.openingBalanceCents).toBe(100_000)
    expect(statement.closingBalanceCents).toBe(120_000)
    expect(statement.lines.map((line) => line.kind)).toEqual(['invoice', 'payment'])
  })

  it('calls a write-off a write-off, not a payment', async () => {
    const { fixture, customer, invoice } = await arFixture()

    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-05-01',
      reason: 'Uncollectable',
    })

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-06-30',
      kind: 'balance_forward',
      periodStart: '2026-01-01',
    })

    const writeOffLine = statement.lines.find((line) => line.kind === 'write_off')

    // A customer reading "payment" against a debt nobody paid would be
    // entitled to be confused.
    expect(writeOffLine).toBeDefined()
    expect(writeOffLine!.description).toMatch(/written off/i)
    expect(statement.closingBalanceCents).toBe(0)
  })

  it('freezes the figures when it is saved', async () => {
    const { fixture, customer, invoice, revenue } = await arFixture()

    const saved = await saveStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-03-31',
    })

    expect(saved.closingBalanceCents).toBe(100_000)

    // The books move afterwards.
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      lines: [{ chartAccountId: revenue.id, description: 'Later', unitPriceCents: 70_000 }],
    })

    const { customerStatements } = await import('@/db/schema')
    const [row] = await db
      .select()
      .from(customerStatements)
      .where(eq(customerStatements.id, saved.id))
      .limit(1)

    // A statement regenerated from today's data is not the document the
    // customer is holding.
    expect(row.closingBalanceCents).toBe(100_000)
    void invoice
  })

  it('ages what is unpaid', async () => {
    const { fixture, customer } = await arFixture()

    const statement = await buildStatement(fixture.ctx, {
      customerId: customer.id,
      asOfDate: '2026-07-01',
    })

    // Due 2026-03-31, asked on 2026-07-01: over ninety days.
    expect(statement.aging.d90_plus).toBe(100_000)
    expect(statement.aging.current).toBe(0)
  })
})

describe('recurring entries', () => {
  it('always moves forward, on every cadence', () => {
    const dates = ['2026-01-31', '2026-02-28', '2026-08-14', '2026-12-31']

    for (const cadence of ['weekly', 'monthly', 'quarterly', 'annually'] as const) {
      for (const after of dates) {
        const next = nextOccurrence({ cadence, dayOfMonth: 1 }, after)
        expect(next > after, `${cadence} from ${after} gave ${next}`).toBe(true)
      }
    }
  })

  it('does not skip a month rolling over from a long one', () => {
    // The 31st of January plus a month is the 31st of February, which
    // resolves to March — the bug this guards.
    expect(nextOccurrence({ cadence: 'monthly', dayOfMonth: 1 }, '2026-01-31')).toBe('2026-02-01')
    expect(nextOccurrence({ cadence: 'monthly', dayOfMonth: 15 }, '2026-01-31')).toBe('2026-02-15')
  })

  it('starts on the first matching day on or after the start date', () => {
    expect(firstOccurrence({ cadence: 'monthly', dayOfMonth: 15 }, '2026-03-01')).toBe('2026-03-15')
    expect(firstOccurrence({ cadence: 'monthly', dayOfMonth: 1 }, '2026-03-05')).toBe('2026-04-01')
  })

  it('refuses a template that does not balance', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    // Caught when the template is saved rather than when it first fires, so a
    // broken template is a failed save instead of a failed job at 2am.
    await expect(
      createRecurringEntry(fixture.ctx, {
        name: 'Broken rent',
        cadence: 'monthly',
        startsOn: '2026-01-01',
        lines: [
          { chartAccountId: rent.id, debitCents: 100_000 },
          { chartAccountId: cash.id, creditCents: 90_000 },
        ],
      }),
    ).rejects.toThrow(/does not balance/i)
  })

  it('posts when the template says to, and drafts when it does not', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    await createRecurringEntry(fixture.ctx, {
      name: 'Monthly rent',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: true,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rent.id, debitCents: 100_000 },
        { chartAccountId: cash.id, creditCents: 100_000 },
      ],
    })

    await createRecurringEntry(fixture.ctx, {
      name: 'Estimated accrual',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: false,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rent.id, debitCents: 20_000 },
        { chartAccountId: cash.id, creditCents: 20_000 },
      ],
    })

    const results = await runDueRecurringEntries(fixture.ctx, '2026-01-31')

    expect(results).toHaveLength(2)
    expect(results.filter((row) => row.posted)).toHaveLength(1)

    const tb = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    // Only the posted one affects the books. The draft is a proposal.
    expect(tb.totalDebitCents).toBe(100_000)
  })

  it('running twice on the same day changes nothing', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    await createRecurringEntry(fixture.ctx, {
      name: 'Monthly rent',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: true,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rent.id, debitCents: 100_000 },
        { chartAccountId: cash.id, creditCents: 100_000 },
      ],
    })

    await runDueRecurringEntries(fixture.ctx, '2026-01-15')
    await runDueRecurringEntries(fixture.ctx, '2026-01-15')

    // Phase 10's queue runs at least once, so this has to be free.
    const tb = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(tb.totalDebitCents).toBe(100_000)
  })

  it('produces one entry per period when it catches up', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    await createRecurringEntry(fixture.ctx, {
      name: 'Monthly rent',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: true,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rent.id, debitCents: 100_000 },
        { chartAccountId: cash.id, creditCents: 100_000 },
      ],
    })

    // A worker that was down for three months, catching up in one run. One
    // occurrence per call would mean January's rent posting in March.
    const results = await runDueRecurringEntries(fixture.ctx, '2026-03-31')

    expect(results.map((row) => row.occurredOn)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ])

    const tb = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    // January, February, March — one each, dated correctly, not three today.
    expect(tb.totalDebitCents).toBe(300_000)

    // And running again changes nothing.
    await runDueRecurringEntries(fixture.ctx, '2026-03-31')
    const after = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(after.totalDebitCents).toBe(300_000)
  })

  it('stops itself past its end date', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    await createRecurringEntry(fixture.ctx, {
      name: 'Lease that ends',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: true,
      startsOn: '2026-01-01',
      endsOn: '2026-02-28',
      lines: [
        { chartAccountId: rent.id, debitCents: 100_000 },
        { chartAccountId: cash.id, creditCents: 100_000 },
      ],
    })

    for (let round = 0; round < 6; round++) {
      await runDueRecurringEntries(fixture.ctx, '2026-12-31')
    }

    const tb = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(tb.totalDebitCents).toBe(200_000)
  })

  it('does not fire while switched off', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    const template = await createRecurringEntry(fixture.ctx, {
      name: 'Paused rent',
      cadence: 'monthly',
      autoPost: true,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rent.id, debitCents: 100_000 },
        { chartAccountId: cash.id, creditCents: 100_000 },
      ],
    })

    await setRecurringActive(fixture.ctx, template.id, false)
    const results = await runDueRecurringEntries(fixture.ctx, '2026-06-30')

    expect(results).toHaveLength(0)
  })
})

describe('closing the year', () => {
  async function yearOfTrading() {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-01',
      memo: 'A sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 500_000 },
        { chartAccountId: revenue.id, creditCents: 500_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-15',
      memo: 'Rent',
      lines: [
        { chartAccountId: rent.id, debitCents: 200_000 },
        { chartAccountId: cash.id, creditCents: 200_000 },
      ],
    })

    return { fixture, revenue, rent, cash }
  }

  it('empties revenue and expense into retained earnings', async () => {
    const { fixture } = await yearOfTrading()

    const preview = await previewClose(fixture.ctx, { closingDate: '2026-12-31' })
    expect(preview.netIncomeCents).toBe(300_000)

    await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })

    const after = await accountBalances(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The year measured itself and then started again.
    expect(after.find((row) => row.number === '4100')?.balanceCents ?? 0).toBe(0)
    expect(after.find((row) => row.number === '6400')?.balanceCents ?? 0).toBe(0)
    expect(after.find((row) => row.number === '3200')?.balanceCents).toBe(300_000)
  })

  it('leaves the balance sheet balanced and its earnings line empty', async () => {
    const { fixture } = await yearOfTrading()

    const before = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31' })
    expect(before.netIncomeCents).toBe(300_000)
    expect(before.isBalanced).toBe(true)

    await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })

    const after = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31' })

    // The line the balance sheet has shown separately since Phase 2 is empty
    // now, because the closing entry moved it where it belongs.
    expect(after.netIncomeCents).toBe(0)
    expect(after.equity.totalCents).toBe(300_000)
    expect(after.isBalanced).toBe(true)
    expect(after.totalAssetsCents).toBe(before.totalAssetsCents)
  })

  it('refuses to close the same year twice', async () => {
    const { fixture } = await yearOfTrading()

    await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })

    // Closing twice has exactly one outcome, it is wrong, and no reason makes
    // it right — so unlike a filing there is no override.
    await expect(
      closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' }),
    ).rejects.toThrow(CloseBlockedError)
  })

  it('warns about proposed entries that would be left out', async () => {
    const { fixture, rent, cash } = await yearOfTrading()

    await draftJournalEntry(fixture.ctx, {
      entryDate: '2026-11-30',
      memo: 'Proposed and undecided',
      lines: [
        { chartAccountId: rent.id, debitCents: 10_000 },
        { chartAccountId: cash.id, creditCents: 10_000 },
      ],
    })

    const preview = await previewClose(fixture.ctx, { closingDate: '2026-12-31' })
    const warning = preview.checks.find((check) => check.severity === 'warning')

    expect(warning?.message).toMatch(/waiting for a decision/i)
    // A warning, not a blocker: leaving a draft out is a choice, and it is
    // the accountant's.
    expect(preview.checks.filter((check) => check.severity === 'blocker')).toHaveLength(0)
  })

  it('reverses the entry when a year is reopened', async () => {
    const { fixture } = await yearOfTrading()

    const closed = await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })
    await reopenFiscalYear(fixture.ctx, closed.id, 'A late invoice turned up')

    const after = await accountBalances(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // Reversal rather than deletion: an auditor asking why Retained Earnings
    // moves twice deserves an answer.
    expect(after.find((row) => row.number === '4100')?.balanceCents).toBe(500_000)
    expect(after.find((row) => row.number === '3200')?.balanceCents ?? 0).toBe(0)

    const closingEntries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.companyId, fixture.companyId))

    expect(closingEntries.some((entry) => entry.status === 'void')).toBe(true)
  })

  it('closes a loss as well as a profit', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const cash = await fixture.account('1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-15',
      memo: 'Rent, and no sales',
      lines: [
        { chartAccountId: rent.id, debitCents: 200_000 },
        { chartAccountId: cash.id, creditCents: 200_000 },
      ],
    })

    await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })

    const after = await accountBalances(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      includeZero: true,
    })

    // A loss debits Retained Earnings. Its normal balance is a credit, so the
    // signed figure is negative.
    expect(after.find((row) => row.number === '3200')?.balanceCents).toBe(-200_000)
    expect(after.find((row) => row.number === '6400')?.balanceCents ?? 0).toBe(0)
  })

  it('refuses a reopen with no reason', async () => {
    const { fixture } = await yearOfTrading()
    const closed = await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })

    await expect(reopenFiscalYear(fixture.ctx, closed.id, '  ')).rejects.toThrow(/why/i)
  })
})

describe('tenant isolation', () => {
  it('keeps credits, write-offs, and closes to their own company', async () => {
    const ours = await arFixture()
    const theirs = await arFixture()

    await writeOffInvoice(ours.fixture.ctx, ours.invoice.id, {
      writtenOffOn: '2026-09-01',
      reason: 'Uncollectable',
    })

    const theirWriteOffs = await listWriteOffs(theirs.fixture.ctx)
    expect(theirWriteOffs).toHaveLength(0)

    await expect(
      writeOffInvoice(theirs.fixture.ctx, ours.invoice.id, {
        writtenOffOn: '2026-09-01',
        reason: 'Not mine to write off',
      }),
    ).rejects.toThrow(/not found/i)
  })
})
