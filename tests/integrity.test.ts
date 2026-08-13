import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  auditEvents,
  bankTransactions,
  categorizationRules,
  transactionSplits,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { createCompanyFixture, insertTransaction } from './helpers'
import {
  bulkCategorize,
  categorize,
  excludeTransaction,
  markAsTransfer,
  splitTransaction,
  splitsFor,
  transactionHistory,
  undoLast,
  acceptSuggestion,
  inboxCounts,
} from '@/modules/bookkeeping/transactions'
import { allocateCents, formatCents, parseAmountToCents } from '@/lib/money'
import { accountsForIndustry } from '@/modules/coa/service'
import { INDUSTRY_PACKS } from '@/modules/coa/industry'
import { STANDARD_ACCOUNTS } from '@/modules/coa/standard'

/** Money arithmetic — the base of every other guarantee (spec §19). */
describe('money', () => {
  it('parses decimal input to exact cents', () => {
    expect(parseAmountToCents('12.34')).toBe(1234)
    expect(parseAmountToCents('$1,234.56')).toBe(123456)
    expect(parseAmountToCents('-45.00')).toBe(-4500)
    // "1.5" is a dollar fifty, not one dollar five cents.
    expect(parseAmountToCents('1.5')).toBe(150)
    expect(parseAmountToCents('100')).toBe(10000)
  })

  it('rejects more than two decimal places', () => {
    expect(() => parseAmountToCents('1.234')).toThrow(/two decimal places/i)
  })

  it('rejects non-numeric input', () => {
    expect(() => parseAmountToCents('abc')).toThrow()
    expect(() => parseAmountToCents('')).toThrow()
  })

  it('avoids the floating point error that decimals would introduce', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; in cents it is exact.
    expect(parseAmountToCents('0.10') + parseAmountToCents('0.20')).toBe(
      parseAmountToCents('0.30'),
    )
  })

  it('formats cents for display', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(-6240)).toBe('-$62.40')
  })

  it('allocates without losing or inventing cents', () => {
    // 100 cents across 3 ways cannot divide evenly.
    const parts = allocateCents(100, 3)
    expect(parts).toEqual([34, 33, 33])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)

    const negative = allocateCents(-100, 3)
    expect(negative.reduce((a, b) => a + b, 0)).toBe(-100)
  })
})

/** Chart-of-accounts integrity (spec §5). */
describe('chart of accounts', () => {
  it('installs the standard chart for a general company', async () => {
    const fixture = await createCompanyFixture({ industry: 'general' })
    const accounts = await fixture.account('6350')
    expect(accounts.name).toBe('Office Supplies')
  })

  it('adds industry accounts on top of the standard chart', () => {
    const construction = accountsForIndustry('construction')
    const numbers = construction.map((a) => a.number)

    // Standard backbone survives.
    expect(numbers).toContain('1000')
    expect(numbers).toContain('6350')
    // Industry pack applied.
    expect(numbers).toContain('5130')
    expect(construction.find((a) => a.number === '5130')?.name).toBe('Subcontractors')
  })

  it('returns accounts in account-number order', () => {
    const accounts = accountsForIndustry('retail')
    const numbers = accounts.map((a) => a.number)
    expect(numbers).toEqual([...numbers].sort())
  })

  it('never lets an industry pack collide with a standard account number', () => {
    // A collision would be silently dropped by accountsForIndustry, so the
    // packs themselves have to stay clear of the standard numbering.
    const standard = new Set(STANDARD_ACCOUNTS.map((a) => a.number))

    for (const pack of Object.values(INDUSTRY_PACKS)) {
      for (const account of pack.accounts) {
        expect(
          standard.has(account.number),
          `${pack.key} pack reuses standard account number ${account.number} (${account.name})`,
        ).toBe(false)
      }
    }
  })

  it('keeps account numbers unique within every industry', () => {
    for (const pack of Object.values(INDUSTRY_PACKS)) {
      const numbers = accountsForIndustry(pack.key).map((a) => a.number)
      expect(new Set(numbers).size, `duplicate account number in ${pack.key}`).toBe(numbers.length)
    }
  })

  it('includes the system accounts the books depend on', () => {
    const accounts = accountsForIndustry('general')
    for (const number of ['1100', '2000', '3200', '4990', '6900']) {
      expect(accounts.some((a) => a.number === number && a.isSystem)).toBe(true)
    }
  })
})

/** Split integrity (spec §3). */
describe('transaction splits', () => {
  it('splits a transaction across accounts', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const computer = await fixture.account('6100')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES 00114',
    })

    await splitTransaction(fixture.ctx, transactionRow.id, [
      { chartAccountId: office.id, amountCents: -6_000 },
      { chartAccountId: computer.id, amountCents: -4_000 },
    ])

    const splits = await splitsFor(fixture.ctx, transactionRow.id)
    expect(splits).toHaveLength(2)
    expect(splits.reduce((sum, s) => sum + s.amountCents, 0)).toBe(-10_000)

    const [updated] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))

    expect(updated.isSplit).toBe(true)
    // The splits carry the accounts now.
    expect(updated.chartAccountId).toBeNull()
    expect(updated.reviewState).toBe('categorized')
  })

  it('refuses a split that does not sum to the transaction amount', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const computer = await fixture.account('6100')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES 00114',
    })

    await expect(
      splitTransaction(fixture.ctx, transactionRow.id, [
        { chartAccountId: office.id, amountCents: -6_000 },
        // One cent short — the books would not balance.
        { chartAccountId: computer.id, amountCents: -3_999 },
      ]),
    ).rejects.toThrow(/must match exactly/i)

    // Nothing was written.
    const splits = await db
      .select()
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, transactionRow.id))
    expect(splits).toHaveLength(0)
  })

  it('refuses a split with fewer than two lines', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const transactionRow = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES',
    })

    await expect(
      splitTransaction(fixture.ctx, transactionRow.id, [
        { chartAccountId: office.id, amountCents: -10_000 },
      ]),
    ).rejects.toThrow(/at least two lines/i)
  })

  it('refuses a zero-amount split line', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const computer = await fixture.account('6100')
    const transactionRow = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES',
    })

    await expect(
      splitTransaction(fixture.ctx, transactionRow.id, [
        { chartAccountId: office.id, amountCents: -10_000 },
        { chartAccountId: computer.id, amountCents: 0 },
      ]),
    ).rejects.toThrow(/cannot be zero/i)
  })

  it('clears splits when the transaction is later categorized whole', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const computer = await fixture.account('6100')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES',
    })
    await splitTransaction(fixture.ctx, transactionRow.id, [
      { chartAccountId: office.id, amountCents: -6_000 },
      { chartAccountId: computer.id, amountCents: -4_000 },
    ])

    await categorize(fixture.ctx, transactionRow.id, office.id)

    const splits = await splitsFor(fixture.ctx, transactionRow.id)
    expect(splits).toHaveLength(0)

    const [updated] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))
    expect(updated.isSplit).toBe(false)
    expect(updated.chartAccountId).toBe(office.id)
  })
})

/** Transfers (spec §3). */
describe('transfers', () => {
  it('refuses transfer legs that are not equal and opposite', async () => {
    const fixture = await createCompanyFixture()

    const out = await insertTransaction(fixture, {
      amountCents: -50_000,
      description: 'TRANSFER OUT',
    })
    const wrong = await insertTransaction(fixture, {
      amountCents: 40_000,
      description: 'TRANSFER IN',
    })

    await expect(markAsTransfer(fixture.ctx, out.id, wrong.id)).rejects.toThrow(
      /equal and opposite/i,
    )
  })

  it('refuses a transfer within a single account', async () => {
    const fixture = await createCompanyFixture()

    const out = await insertTransaction(fixture, {
      amountCents: -50_000,
      description: 'TRANSFER OUT',
    })
    const back = await insertTransaction(fixture, {
      amountCents: 50_000,
      description: 'TRANSFER IN',
    })

    // Both are on the fixture's single checking account.
    await expect(markAsTransfer(fixture.ctx, out.id, back.id)).rejects.toThrow(
      /two different accounts/i,
    )
  })

  it('marks a single leg as a transfer without a pair', async () => {
    const fixture = await createCompanyFixture()
    const out = await insertTransaction(fixture, {
      amountCents: -50_000,
      description: 'TRANSFER TO SAVINGS',
    })

    await markAsTransfer(fixture.ctx, out.id)

    const [updated] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, out.id))
    expect(updated.isTransfer).toBe(true)
    expect(updated.reviewState).toBe('matched')
  })
})

/** Audit trail and undo (spec §14, §19, §22). */
describe('audit trail and undo', () => {
  it('attributes every change to the acting user', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES 00114',
    })
    await categorize(fixture.ctx, transactionRow.id, office.id)

    const history = await transactionHistory(fixture.ctx, transactionRow.id)
    expect(history).toHaveLength(1)
    expect(history[0].action).toBe('transaction.categorize')
    expect(history[0].actorName).toBe('Owner User')
    expect(history[0].after).toMatchObject({ chartAccountId: office.id })
  })

  it('restores the prior state on undo', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES 00114',
    })
    await categorize(fixture.ctx, transactionRow.id, office.id)

    const result = await undoLast(fixture.ctx)
    expect(result.undone).toBe(1)

    const [restored] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))

    expect(restored.reviewState).toBe('new')
    expect(restored.chartAccountId).toBeNull()
  })

  it('keeps the audit log append-only across an undo', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES 00114',
    })
    await categorize(fixture.ctx, transactionRow.id, office.id)
    await undoLast(fixture.ctx)

    const history = await transactionHistory(fixture.ctx, transactionRow.id)

    // Both the original change and its reversal are on the record.
    expect(history).toHaveLength(2)
    expect(history.filter((e) => e.isUndo)).toHaveLength(1)

    const original = history.find((e) => !e.isUndo)
    expect(original?.undoneByEventId).not.toBeNull()
  })

  it('undoes a bulk action as one unit', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const first = await insertTransaction(fixture, { amountCents: -1_000, description: 'ONE' })
    const second = await insertTransaction(fixture, { amountCents: -2_000, description: 'TWO' })
    const third = await insertTransaction(fixture, { amountCents: -3_000, description: 'THREE' })

    const bulk = await bulkCategorize(fixture.ctx, [first.id, second.id, third.id], office.id)
    expect(bulk.updated).toBe(3)

    const undo = await undoLast(fixture.ctx)
    expect(undo.undone).toBe(3)

    const rows = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))
    expect(rows.every((r) => r.reviewState === 'new')).toBe(true)
  })

  it('does not undo the same event twice', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES',
    })
    await categorize(fixture.ctx, transactionRow.id, office.id)

    expect((await undoLast(fixture.ctx)).undone).toBe(1)
    // Nothing left that is undoable.
    expect((await undoLast(fixture.ctx)).undone).toBe(0)
  })

  it('restores splits correctly on undo', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const computer = await fixture.account('6100')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'STAPLES',
    })
    await splitTransaction(fixture.ctx, transactionRow.id, [
      { chartAccountId: office.id, amountCents: -6_000 },
      { chartAccountId: computer.id, amountCents: -4_000 },
    ])

    await undoLast(fixture.ctx)

    // The stale split rows are cleared along with the flag.
    const splits = await splitsFor(fixture.ctx, transactionRow.id)
    expect(splits).toHaveLength(0)

    const [restored] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))
    expect(restored.isSplit).toBe(false)
    expect(restored.reviewState).toBe('new')
  })

  it('still undoes the categorization when it also remembered the vendor', async () => {
    // Regression: remembering the vendor writes a rule.create event that lands
    // after the categorize event. Undo used to pick that up, skip it, and
    // report nothing to undo.
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
      merchantName: 'Shell Oil',
    })

    const result = await categorize(fixture.ctx, transactionRow.id, fuel.id, {
      rememberVendor: true,
    })
    expect(result.vendorRule).not.toBeNull()

    const undo = await undoLast(fixture.ctx)
    expect(undo.undone).toBe(1)

    const [restored] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))
    expect(restored.reviewState).toBe('new')
    expect(restored.chartAccountId).toBeNull()
  })

  it('retires the vendor rule when that categorization is undone', async () => {
    // Otherwise the rule would re-apply the decision the user just took back.
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
      merchantName: 'Shell Oil',
    })
    await categorize(fixture.ctx, transactionRow.id, fuel.id, { rememberVendor: true })

    await undoLast(fixture.ctx)

    const [rule] = await db
      .select()
      .from(categorizationRules)
      .where(eq(categorizationRules.companyId, fixture.companyId))

    expect(rule.isVendorMemory).toBe(true)
    expect(rule.isActive).toBe(false)
  })

  it('skips past non-undoable events to find the real target', async () => {
    // An import event sits between the two categorizations; undo must reach
    // the categorization rather than stopping at the import.
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES',
    })
    await categorize(fixture.ctx, transactionRow.id, office.id)

    await recordAudit(fixture.ctx, {
      action: 'transaction.import',
      entityType: 'bank_connection',
      entityId: fixture.financialAccountId,
      after: { imported: 0 },
    })

    const undo = await undoLast(fixture.ctx)
    expect(undo.undone).toBe(1)
  })

  it('writes the audit row in the same transaction as the change', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES',
    })
    await categorize(fixture.ctx, transactionRow.id, office.id)

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, transactionRow.id))

    expect(events).toHaveLength(1)
    expect(events[0].companyId).toBe(fixture.companyId)
    expect(events[0].userId).toBe(fixture.userId)
  })
})

/** Review state transitions (spec §3). */
describe('review states', () => {
  it('reports counts by state', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')

    const first = await insertTransaction(fixture, { amountCents: -1_000, description: 'ONE' })
    await insertTransaction(fixture, { amountCents: -2_000, description: 'TWO' })
    await categorize(fixture.ctx, first.id, office.id)

    const counts = await inboxCounts(fixture.ctx)
    expect(counts.categorized).toBe(1)
    expect(counts.new).toBe(1)
  })

  it('excludes a transaction with a reason', async () => {
    const fixture = await createCompanyFixture()
    const transactionRow = await insertTransaction(fixture, {
      amountCents: -8_000,
      description: 'PERSONAL LUNCH',
    })

    await excludeTransaction(fixture.ctx, transactionRow.id, 'Personal expense')

    const [updated] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))

    expect(updated.reviewState).toBe('excluded')
    expect(updated.excludeReason).toBe('Personal expense')
  })

  it('refuses to accept a suggestion that does not exist', async () => {
    const fixture = await createCompanyFixture()
    const transactionRow = await insertTransaction(fixture, {
      amountCents: -1_000,
      description: 'NO SUGGESTION',
    })

    await expect(acceptSuggestion(fixture.ctx, transactionRow.id)).rejects.toThrow(
      /no pending suggestion/i,
    )
  })
})
