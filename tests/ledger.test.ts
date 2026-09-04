import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, addUserWithRole, insertTransaction } from './helpers'
import {
  ClosedPeriodError,
  UnbalancedEntryError,
  closePeriod,
  entryForSource,
  listEntries,
  normalizeLines,
  postManualEntry,
  reopenPeriod,
  reverseEntry,
  voidEntry,
} from '@/modules/ledger/journal'
import { normalBalance, isDebitNormal, trialBalance } from '@/modules/ledger/balances'
import { balanceSheet, generalLedger, profitAndLoss } from '@/modules/ledger/reports'
import {
  categorize,
  excludeTransaction,
  markAsTransfer,
  splitTransaction,
  undoLast,
} from '@/modules/bookkeeping/transactions'
import { PermissionError } from '@/modules/permissions'

/** Balanced-entry validation — the ledger's central invariant (spec §13). */
describe('journal entry validation', () => {
  it('accepts a balanced entry', () => {
    const result = normalizeLines([
      { chartAccountId: 'a', debitCents: 5_000 },
      { chartAccountId: 'b', creditCents: 5_000 },
    ])
    expect(result.totalCents).toBe(5_000)
  })

  it('rejects an entry whose debits and credits disagree', () => {
    expect(() =>
      normalizeLines([
        { chartAccountId: 'a', debitCents: 5_000 },
        { chartAccountId: 'b', creditCents: 4_999 },
      ]),
    ).toThrow(UnbalancedEntryError)
  })

  it('rejects a line that is both a debit and a credit', () => {
    expect(() =>
      normalizeLines([
        { chartAccountId: 'a', debitCents: 100, creditCents: 100 },
        { chartAccountId: 'b', creditCents: 100 },
      ]),
    ).toThrow(/either a debit or a credit/i)
  })

  it('rejects a line that is neither', () => {
    expect(() =>
      normalizeLines([
        { chartAccountId: 'a' },
        { chartAccountId: 'b', creditCents: 100 },
      ]),
    ).toThrow(/either a debit or a credit/i)
  })

  it('rejects negative amounts', () => {
    expect(() =>
      normalizeLines([
        { chartAccountId: 'a', debitCents: -100 },
        { chartAccountId: 'b', creditCents: -100 },
      ]),
    ).toThrow(/cannot be negative/i)
  })

  it('rejects an entry with fewer than two lines', () => {
    expect(() => normalizeLines([{ chartAccountId: 'a', debitCents: 100 }])).toThrow(
      /at least two lines/i,
    )
  })

  it('rejects fractional cents', () => {
    expect(() =>
      normalizeLines([
        { chartAccountId: 'a', debitCents: 10.5 },
        { chartAccountId: 'b', creditCents: 10.5 },
      ]),
    ).toThrow(/whole numbers of cents/i)
  })
})

describe('normal balance', () => {
  it('treats assets and expenses as debit-normal', () => {
    expect(isDebitNormal('asset')).toBe(true)
    expect(isDebitNormal('expense')).toBe(true)
    expect(isDebitNormal('cogs')).toBe(true)
  })

  it('treats liabilities, equity, and revenue as credit-normal', () => {
    expect(isDebitNormal('liability')).toBe(false)
    expect(isDebitNormal('equity')).toBe(false)
    expect(isDebitNormal('revenue')).toBe(false)
  })

  it('returns a positive balance when an account carries its normal side', () => {
    expect(normalBalance('asset', 10_000, 3_000)).toBe(7_000)
    expect(normalBalance('revenue', 1_000, 9_000)).toBe(8_000)
  })

  it('returns negative when an account carries the opposite side', () => {
    // A checking account with more credits than debits is overdrawn.
    expect(normalBalance('asset', 1_000, 5_000)).toBe(-4_000)
  })
})

describe('posting manual entries', () => {
  it('posts a balanced entry and numbers it sequentially', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    const first = await postManualEntry(fixture.ctx, {
      entryDate: '2026-08-01',
      memo: 'Owner contribution',
      lines: [
        { chartAccountId: cash.id, debitCents: 500_000 },
        { chartAccountId: equity.id, creditCents: 500_000 },
      ],
    })
    const second = await postManualEntry(fixture.ctx, {
      entryDate: '2026-08-02',
      lines: [
        { chartAccountId: cash.id, debitCents: 100 },
        { chartAccountId: equity.id, creditCents: 100 },
      ],
    })

    expect(first.entryNumber).toBe(1)
    expect(second.entryNumber).toBe(2)
  })

  it('refuses to post into another company\'s account', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaCash = await alpha.account('1000')
    const betaEquity = await beta.account('3000')

    await expect(
      postManualEntry(alpha.ctx, {
        entryDate: '2026-08-01',
        lines: [
          { chartAccountId: alphaCash.id, debitCents: 100 },
          { chartAccountId: betaEquity.id, creditCents: 100 },
        ],
      }),
    ).rejects.toThrow(/not on these books/i)
  })

  it('requires accounting:journal to post manually', async () => {
    const fixture = await createCompanyFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    // A bookkeeper categorizes; an accountant writes journal entries.
    await expect(
      postManualEntry(bookkeeper, {
        entryDate: '2026-08-01',
        lines: [
          { chartAccountId: cash.id, debitCents: 100 },
          { chartAccountId: equity.id, creditCents: 100 },
        ],
      }),
    ).rejects.toThrow(PermissionError)
  })

  it('keeps a voided entry out of the balances but in the database', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    const entry = await postManualEntry(fixture.ctx, {
      entryDate: '2026-08-01',
      lines: [
        { chartAccountId: cash.id, debitCents: 500_000 },
        { chartAccountId: equity.id, creditCents: 500_000 },
      ],
    })

    await voidEntry(fixture.ctx, entry.id)

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '1000')).toBeUndefined()

    // Still on the record.
    const [row] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entry.id))
    expect(row.status).toBe('void')
  })

  it('reverses an entry by swapping every side', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    const entry = await postManualEntry(fixture.ctx, {
      entryDate: '2026-08-01',
      lines: [
        { chartAccountId: cash.id, debitCents: 500_000 },
        { chartAccountId: equity.id, creditCents: 500_000 },
      ],
    })

    await reverseEntry(fixture.ctx, entry.id, '2026-09-01')

    // Original plus reversal nets to zero.
    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '1000')?.balanceCents).toBe(0)
    expect(balances.isBalanced).toBe(true)

    const reversalLines = await db
      .select()
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(eq(journalEntries.reversalOfId, entry.id))

    const cashLine = reversalLines.find((r) => r.journal_lines.chartAccountId === cash.id)
    expect(cashLine?.journal_lines.creditCents).toBe(500_000)
    expect(cashLine?.journal_lines.debitCents).toBe(0)
  })
})

/** Period close and reopen (spec §13, §14). */
describe('accounting periods', () => {
  it('blocks a new entry dated inside a closed period', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    await closePeriod(fixture.ctx, { periodStart: '2026-08-01', periodEnd: '2026-08-31' })

    await expect(
      postManualEntry(fixture.ctx, {
        entryDate: '2026-08-15',
        lines: [
          { chartAccountId: cash.id, debitCents: 100 },
          { chartAccountId: equity.id, creditCents: 100 },
        ],
      }),
    ).rejects.toThrow(ClosedPeriodError)
  })

  it('allows entries outside the closed period', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    await closePeriod(fixture.ctx, { periodStart: '2026-08-01', periodEnd: '2026-08-31' })

    await expect(
      postManualEntry(fixture.ctx, {
        entryDate: '2026-09-01',
        lines: [
          { chartAccountId: cash.id, debitCents: 100 },
          { chartAccountId: equity.id, creditCents: 100 },
        ],
      }),
    ).resolves.toBeDefined()
  })

  it('lets entries through again once the period is reopened', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')

    const period = await closePeriod(fixture.ctx, {
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    })
    await reopenPeriod(fixture.ctx, period.id)

    await expect(
      postManualEntry(fixture.ctx, {
        entryDate: '2026-08-15',
        lines: [
          { chartAccountId: cash.id, debitCents: 100 },
          { chartAccountId: equity.id, creditCents: 100 },
        ],
      }),
    ).resolves.toBeDefined()
  })

  it('blocks categorizing a transaction dated inside a closed period', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES',
      postedDate: '2026-08-15',
    })

    await closePeriod(fixture.ctx, { periodStart: '2026-08-01', periodEnd: '2026-08-31' })

    await expect(categorize(fixture.ctx, transaction.id, office.id)).rejects.toThrow(
      ClosedPeriodError,
    )
  })

  it('rolls the bookkeeping change back when the ledger rejects it', async () => {
    // The categorization and its ledger entry share one database transaction,
    // so a closed-period rejection must undo both.
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES',
      postedDate: '2026-08-15',
    })
    await closePeriod(fixture.ctx, { periodStart: '2026-08-01', periodEnd: '2026-08-31' })

    await expect(categorize(fixture.ctx, transaction.id, office.id)).rejects.toThrow()

    const { bankTransactions } = await import('@/db/schema')
    const [after] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transaction.id))

    expect(after.reviewState).toBe('new')
    expect(after.chartAccountId).toBeNull()
  })

  it('requires accounting:close to close a period', async () => {
    const fixture = await createCompanyFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(
      closePeriod(bookkeeper, { periodStart: '2026-08-01', periodEnd: '2026-08-31' }),
    ).rejects.toThrow(PermissionError)
  })
})

/** Bank transactions posting to the ledger (ADR 0001). */
describe('posting from bank transactions', () => {
  it('posts spending as Dr expense / Cr the bank account', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')
    const checking = await fixture.account('1000')

    const transaction = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
    })
    await categorize(fixture.ctx, transaction.id, fuel.id)

    const entry = await entryForSource(fixture.ctx, 'bank_transaction', transaction.id)
    expect(entry).not.toBeNull()

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry!.id))

    expect(lines.find((l) => l.chartAccountId === fuel.id)?.debitCents).toBe(6_240)
    expect(lines.find((l) => l.chartAccountId === checking.id)?.creditCents).toBe(6_240)
  })

  it('posts a deposit as Dr the bank account / Cr revenue', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4000')
    const checking = await fixture.account('1000')

    const transaction = await insertTransaction(fixture, {
      amountCents: 260_103,
      description: 'STRIPE TRANSFER',
    })
    await categorize(fixture.ctx, transaction.id, revenue.id)

    const entry = await entryForSource(fixture.ctx, 'bank_transaction', transaction.id)
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry!.id))

    expect(lines.find((l) => l.chartAccountId === checking.id)?.debitCents).toBe(260_103)
    expect(lines.find((l) => l.chartAccountId === revenue.id)?.creditCents).toBe(260_103)
  })

  it('replaces the entry rather than stacking one when recategorized', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')
    const travel = await fixture.account('6700')

    const transaction = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL',
    })
    await categorize(fixture.ctx, transaction.id, fuel.id)
    await categorize(fixture.ctx, transaction.id, travel.id)

    const live = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.sourceId, transaction.id),
          eq(journalEntries.status, 'posted'),
        ),
      )

    expect(live).toHaveLength(1)

    // The expense landed in travel, not fuel.
    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '6700')?.balanceCents).toBe(6_240)
    expect(balances.rows.find((r) => r.number === '6800')).toBeUndefined()
  })

  it('posts each split line and one line for the bank side', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const computer = await fixture.account('6100')
    const checking = await fixture.account('1000')

    const transaction = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES',
    })
    await splitTransaction(fixture.ctx, transaction.id, [
      { chartAccountId: office.id, amountCents: -6_000 },
      { chartAccountId: computer.id, amountCents: -4_000 },
    ])

    const entry = await entryForSource(fixture.ctx, 'bank_transaction', transaction.id)
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry!.id))

    expect(lines).toHaveLength(3)
    expect(lines.find((l) => l.chartAccountId === office.id)?.debitCents).toBe(6_000)
    expect(lines.find((l) => l.chartAccountId === computer.id)?.debitCents).toBe(4_000)
    expect(lines.find((l) => l.chartAccountId === checking.id)?.creditCents).toBe(10_000)
  })

  it('withdraws the entry when a transaction is excluded', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transaction = await insertTransaction(fixture, {
      amountCents: -8_000,
      description: 'PERSONAL LUNCH',
    })
    await categorize(fixture.ctx, transaction.id, office.id)
    await excludeTransaction(fixture.ctx, transaction.id, 'Personal')

    expect(await entryForSource(fixture.ctx, 'bank_transaction', transaction.id)).toBeNull()

    const balances = await trialBalance(fixture.ctx)
    expect(balances.rows.find((r) => r.number === '6350')).toBeUndefined()
  })

  it('withdraws the entry when a categorization is undone', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES',
    })
    await categorize(fixture.ctx, transaction.id, office.id)
    await undoLast(fixture.ctx)

    expect(await entryForSource(fixture.ctx, 'bank_transaction', transaction.id)).toBeNull()
  })

  it('posts a matched transfer once, between the two bank accounts', async () => {
    const fixture = await createCompanyFixture()
    const savingsGl = await fixture.account('1010')

    // A second bank account, so the two legs live on different accounts.
    const { financialAccounts } = await import('@/db/schema')
    const [savings] = await db
      .insert(financialAccounts)
      .values({
        companyId: fixture.companyId,
        chartAccountId: savingsGl.id,
        name: 'Business Savings',
        kind: 'savings',
        providerAccountId: 'test-savings-002',
      })
      .returning()

    const out = await insertTransaction(fixture, {
      amountCents: -50_000,
      description: 'TRANSFER OUT',
    })
    const { bankTransactions } = await import('@/db/schema')
    const [incoming] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: savings.id,
        providerTransactionId: 'transfer-in-001',
        postedDate: '2026-08-01',
        amountCents: 50_000,
        description: 'TRANSFER IN',
      })
      .returning()

    await markAsTransfer(fixture.ctx, out.id, incoming.id)

    const live = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      )

    // One entry for the pair, not two.
    expect(live).toHaveLength(1)

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, live[0].id))

    const checking = await fixture.account('1000')
    expect(lines.find((l) => l.chartAccountId === savingsGl.id)?.debitCents).toBe(50_000)
    expect(lines.find((l) => l.chartAccountId === checking.id)?.creditCents).toBe(50_000)

    // A transfer must not reach income or expense.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.netIncomeCents).toBe(0)
  })

  it('keeps the trial balance balanced across many postings', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')
    const revenue = await fixture.account('4000')

    for (let i = 0; i < 10; i++) {
      const spend = await insertTransaction(fixture, {
        amountCents: -(1_000 + i * 137),
        description: `SPEND ${i}`,
      })
      await categorize(fixture.ctx, spend.id, fuel.id)

      const deposit = await insertTransaction(fixture, {
        amountCents: 5_000 + i * 311,
        description: `DEPOSIT ${i}`,
      })
      await categorize(fixture.ctx, deposit.id, revenue.id)
    }

    const balances = await trialBalance(fixture.ctx)
    expect(balances.isBalanced).toBe(true)
    expect(balances.totalDebitCents).toBeGreaterThan(0)
  })
})

/** Statements (spec §13, §20). */
describe('financial statements', () => {
  it('computes profit and loss over a date range', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4000')
    const fuel = await fixture.account('6800')

    const income = await insertTransaction(fixture, {
      amountCents: 100_000,
      description: 'DEPOSIT',
      postedDate: '2026-08-10',
    })
    await categorize(fixture.ctx, income.id, revenue.id)

    const spend = await insertTransaction(fixture, {
      amountCents: -30_000,
      description: 'FUEL',
      postedDate: '2026-08-12',
    })
    await categorize(fixture.ctx, spend.id, fuel.id)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })

    expect(pl.revenue.totalCents).toBe(100_000)
    expect(pl.operatingExpenses.totalCents).toBe(30_000)
    expect(pl.netIncomeCents).toBe(70_000)
  })

  it('excludes activity outside the requested range', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4000')

    const august = await insertTransaction(fixture, {
      amountCents: 100_000,
      description: 'AUGUST',
      postedDate: '2026-08-10',
    })
    await categorize(fixture.ctx, august.id, revenue.id)

    const september = await insertTransaction(fixture, {
      amountCents: 50_000,
      description: 'SEPTEMBER',
      postedDate: '2026-09-10',
    })
    await categorize(fixture.ctx, september.id, revenue.id)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })
    expect(pl.revenue.totalCents).toBe(100_000)
  })

  it('produces a balance sheet where assets equal liabilities plus equity', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equity = await fixture.account('3000')
    const revenue = await fixture.account('4000')
    const fuel = await fixture.account('6800')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-08-01',
      memo: 'Opening capital',
      lines: [
        { chartAccountId: cash.id, debitCents: 500_000 },
        { chartAccountId: equity.id, creditCents: 500_000 },
      ],
    })

    const income = await insertTransaction(fixture, {
      amountCents: 100_000,
      description: 'DEPOSIT',
      postedDate: '2026-08-10',
    })
    await categorize(fixture.ctx, income.id, revenue.id)

    const spend = await insertTransaction(fixture, {
      amountCents: -30_000,
      description: 'FUEL',
      postedDate: '2026-08-12',
    })
    await categorize(fixture.ctx, spend.id, fuel.id)

    const bs = await balanceSheet(fixture.ctx, { asOfDate: '2026-08-31' })

    expect(bs.isBalanced).toBe(true)
    // 500,000 opening + 100,000 in − 30,000 out
    expect(bs.totalAssetsCents).toBe(570_000)
    expect(bs.netIncomeCents).toBe(70_000)
    expect(bs.equity.totalCents).toBe(500_000)
  })

  it('shows credit-card spending as a liability, not negative cash', async () => {
    const fixture = await createCompanyFixture()
    const cardGl = await fixture.account('2100')
    const materials = await fixture.account('5100')

    const { financialAccounts, bankTransactions } = await import('@/db/schema')
    const [card] = await db
      .insert(financialAccounts)
      .values({
        companyId: fixture.companyId,
        chartAccountId: cardGl.id,
        name: 'Business Card',
        kind: 'credit_card',
        providerAccountId: 'test-card-003',
      })
      .returning()

    const [charge] = await db
      .insert(bankTransactions)
      .values({
        companyId: fixture.companyId,
        financialAccountId: card.id,
        providerTransactionId: 'card-001',
        postedDate: '2026-08-05',
        amountCents: -57_773,
        description: 'HOME DEPOT',
      })
      .returning()

    await categorize(fixture.ctx, charge.id, materials.id)

    const bs = await balanceSheet(fixture.ctx, { asOfDate: '2026-08-31' })

    // Spending on a card increases what is owed.
    expect(bs.liabilities.totalCents).toBe(57_773)
    expect(bs.isBalanced).toBe(true)
  })

  it('builds a general ledger with a running balance', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    for (const amount of [-1_000, -2_000, -3_000]) {
      const transaction = await insertTransaction(fixture, {
        amountCents: amount,
        description: `FUEL ${amount}`,
        postedDate: '2026-08-10',
      })
      await categorize(fixture.ctx, transaction.id, fuel.id)
    }

    const gl = await generalLedger(fixture.ctx, fuel.id)

    expect(gl.lines).toHaveLength(3)
    expect(gl.lines.map((l) => l.runningBalanceCents)).toEqual([1_000, 3_000, 6_000])
    expect(gl.closingBalanceCents).toBe(6_000)
  })

  it('carries an opening balance into a mid-range general ledger', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    const july = await insertTransaction(fixture, {
      amountCents: -5_000,
      description: 'JULY FUEL',
      postedDate: '2026-07-15',
    })
    await categorize(fixture.ctx, july.id, fuel.id)

    const august = await insertTransaction(fixture, {
      amountCents: -3_000,
      description: 'AUGUST FUEL',
      postedDate: '2026-08-15',
    })
    await categorize(fixture.ctx, august.id, fuel.id)

    const gl = await generalLedger(fixture.ctx, fuel.id, {
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })

    expect(gl.openingBalanceCents).toBe(5_000)
    expect(gl.lines).toHaveLength(1)
    expect(gl.closingBalanceCents).toBe(8_000)
  })

  it('scopes the ledger to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaFuel = await alpha.account('6800')
    const transaction = await insertTransaction(alpha, {
      amountCents: -6_240,
      description: 'ALPHA FUEL',
    })
    await categorize(alpha.ctx, transaction.id, alphaFuel.id)

    expect((await trialBalance(alpha.ctx)).rows.length).toBeGreaterThan(0)
    expect((await trialBalance(beta.ctx)).rows).toHaveLength(0)
    expect(await listEntries(beta.ctx)).toHaveLength(0)
  })
})
