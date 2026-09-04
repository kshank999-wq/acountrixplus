import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, chartAccounts, financialAccounts } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  cashTieOut,
  createFinancialAccount,
  FinancialAccountError,
  listFinancialAccounts,
  renameFinancialAccount,
  setFinancialAccountActive,
} from '@/modules/banking/accounts'
import { connectInstitution } from '@/modules/banking/sync'
import { commitStatementImport, planStatementImport } from '@/modules/importing/statements'
import { categorize } from '@/modules/bookkeeping/transactions'
import { startReconciliation } from '@/modules/reconciliation/service'
import { PermissionError } from '@/modules/permissions'
import { INTEGRITY_CHECKS } from '@/modules/integrity/register'

/**
 * Bank accounts somebody owns (Phase 40).
 *
 * The claim under test: **one bank account, one ledger account** — and a
 * business can open one without an aggregator's permission.
 *
 * Before this, `financial_accounts` rows were only ever written by a provider
 * or the seed, so a company banking somewhere the aggregator does not reach
 * had none at all and could not import a statement, reconcile, take a deposit
 * or remit payroll. And every account that was not a card pointed at 1000, so
 * two real accounts shared one balance-sheet line.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Accounts Co' })
})

async function chartFor(financialAccountId: string) {
  const [row] = await db
    .select({ number: chartAccounts.number, name: chartAccounts.name, type: chartAccounts.type })
    .from(chartAccounts)
    .innerJoin(financialAccounts, eq(financialAccounts.chartAccountId, chartAccounts.id))
    .where(eq(financialAccounts.id, financialAccountId))
  return row
}

describe('opening an account by hand', () => {
  it('gives it a ledger account of its own, in the right band', async () => {
    // The fixture's own account already holds 1000.
    const savings = await createFinancialAccount(fixture.ctx, {
      name: 'Deposit Account',
      kind: 'savings',
      mask: '9928',
    })

    const chart = await chartFor(savings.id)
    expect(chart.number).toBe('1010')
    expect(chart.type).toBe('asset')
    // One thing under one name, so nobody reconciles the wrong line.
    expect(chart.name).toBe('Deposit Account ••9928')
  })

  it('makes a card a liability and an account an asset', async () => {
    const card = await createFinancialAccount(fixture.ctx, {
      name: 'Company Card',
      kind: 'credit_card',
    })
    expect((await chartFor(card.id)).type).toBe('liability')
    expect((await chartFor(card.id)).number).toBe('2100')
  })

  it('steps to the next number for a second account of the same kind', async () => {
    const second = await createFinancialAccount(fixture.ctx, {
      name: 'Second Current',
      kind: 'checking',
    })
    // 1000 is taken by the fixture's account.
    expect((await chartFor(second.id)).number).toBe('1001')
  })

  it('keeps only the last four digits of anything typed into the mask', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Deposit Account',
      kind: 'savings',
      // A full account number is not evidence anybody needs — spec §19.
      mask: '1234 5678 9012 3456',
    })
    expect(account.mask).toBe('3456')
  })

  it('starts with no balance and no transactions', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Deposit Account',
      kind: 'savings',
    })
    expect(account.currentBalanceCents).toBe(0)
    expect(account.transactionCount).toBe(0)
  })

  it('refuses an account with no name', async () => {
    await expect(
      createFinancialAccount(fixture.ctx, { name: '   ', kind: 'checking' }),
    ).rejects.toThrow(FinancialAccountError)
  })

  it('is an accountant’s or owner’s act, not a bookkeeper’s', async () => {
    // Opening an account writes a new line onto the balance sheet, which is
    // not the same kind of act as coding a card charge.
    const bookkeeper = { ...fixture.ctx, role: 'bookkeeper' as const }
    await expect(
      createFinancialAccount(bookkeeper, { name: 'Deposit Account', kind: 'savings' }),
    ).rejects.toThrow(PermissionError)
  })
})

describe('one account, one ledger account', () => {
  it('refuses a ledger account another bank account already posts to', async () => {
    const [existing] = await db
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(eq(financialAccounts.id, fixture.financialAccountId))

    await expect(
      createFinancialAccount(fixture.ctx, {
        name: 'Deposit Account',
        kind: 'savings',
        chartAccountId: existing.chartAccountId,
      }),
    ).rejects.toThrow(/already posts to that ledger account/)
  })

  /**
   * The database is what makes it true. Two people connecting institutions at
   * once would both pass an application-level check, and the constraint is
   * what stops the second write.
   */
  it('is enforced by the database, not only by the service', async () => {
    const [existing] = await db
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(eq(financialAccounts.id, fixture.financialAccountId))

    const refused = await db
      .insert(financialAccounts)
      .values({
        companyId: fixture.companyId,
        chartAccountId: existing.chartAccountId,
        name: 'Sneaked In',
        kind: 'savings',
      })
      .then(
        () => null,
        // postgres.js puts the driver's own summary in `message` and the
        // constraint name on the cause, so the cause is what to assert on.
        (error: { cause?: { constraint_name?: string; code?: string } }) => error.cause,
      )

    expect(refused?.code).toBe('23505')
    expect(refused?.constraint_name).toBe('financial_accounts_chart_account_unique')
  })

  it('refuses a ledger account that is neither an asset nor a liability', async () => {
    const revenue = await fixture.account('4000')
    await expect(
      createFinancialAccount(fixture.ctx, {
        name: 'Odd One',
        kind: 'checking',
        chartAccountId: revenue.id,
      }),
    ).rejects.toThrow(/asset or a liability/)
  })

  it('refuses a ledger account belonging to somebody else', async () => {
    const other = await createCompanyFixture({ name: 'Not Yours' })
    const theirs = await other.account('1010')

    await expect(
      createFinancialAccount(fixture.ctx, {
        name: 'Deposit Account',
        kind: 'savings',
        chartAccountId: theirs.id,
      }),
    ).rejects.toThrow(/not on these books/)
  })

  /**
   * The bug this phase exists to fix. `connectInstitution` pointed every
   * account that was not a card at 1000, so a checking and a savings account
   * shared one balance-sheet line.
   */
  it('gives each account a connection brings in its own ledger account', async () => {
    const connected = await createCompanyFixture({ name: 'Connected Co' })
    await connectInstitution(connected.ctx, { publicToken: 'demo' })

    const accounts = await listFinancialAccounts(connected.ctx)
    expect(accounts.length).toBeGreaterThan(1)

    // This line was followed by `sharedLedgerAccounts(...) === []` until Phase
    // 122 retired both the query and its check. It says the same thing, and it
    // says it about the data rather than about a second reading of the data.
    const numbers = accounts.map((account) => account.chartAccountNumber)
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})

describe('renaming and closing', () => {
  it('renames the ledger account with it, so there are not two names for one thing', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Deposit Account',
      kind: 'savings',
      mask: '9928',
    })

    await renameFinancialAccount(fixture.ctx, account.id, { name: 'Reserve Account' })
    const chart = await chartFor(account.id)

    expect(chart.name).toBe('Reserve Account ••9928')
    // The number is what every report and every import refers to, so it stays.
    expect(chart.number).toBe('1010')
  })

  it('closes rather than deletes, keeping everything it holds', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Old Account',
      kind: 'savings',
    })

    await setFinancialAccountActive(fixture.ctx, account.id, false)

    const active = await listFinancialAccounts(fixture.ctx, { activeOnly: true })
    expect(active.map((row) => row.id)).not.toContain(account.id)

    // Still there, and still findable — a closed account's history is exactly
    // what somebody looks at a year later.
    const all = await listFinancialAccounts(fixture.ctx)
    expect(all.map((row) => row.id)).toContain(account.id)
  })

  it('takes the ledger account off the categorisation list with it', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Old Account',
      kind: 'savings',
    })
    await setFinancialAccountActive(fixture.ctx, account.id, false)

    const [chart] = await db
      .select({ isActive: chartAccounts.isActive })
      .from(chartAccounts)
      .where(
        and(
          eq(chartAccounts.companyId, fixture.companyId),
          eq(chartAccounts.number, '1010'),
        ),
      )

    expect(chart.isActive).toBe(false)
  })

  it('refuses to close an account with a reconciliation open on it', async () => {
    await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-03-01',
      statementEndDate: '2026-03-31',
      statementEndingBalanceCents: 100_000,
    })

    await expect(
      setFinancialAccountActive(fixture.ctx, fixture.financialAccountId, false),
    ).rejects.toThrow(/open reconciliation/)
  })

  it('can be reopened', async () => {
    const account = await createFinancialAccount(fixture.ctx, {
      name: 'Old Account',
      kind: 'savings',
    })
    await setFinancialAccountActive(fixture.ctx, account.id, false)
    await setFinancialAccountActive(fixture.ctx, account.id, true)

    const active = await listFinancialAccounts(fixture.ctx, { activeOnly: true })
    expect(active.map((row) => row.id)).toContain(account.id)
  })
})

describe('the ledger against the bank, per account', () => {
  const STATEMENT = [
    'Date,Description,Amount',
    '03/14/2026,TIMBER MERCHANT,-812.40',
    '03/15/2026,CLIENT PAYMENT,2500.00',
  ].join('\n')

  async function importStatement(financialAccountId: string) {
    const plan = await planStatementImport(fixture.ctx, { financialAccountId, text: STATEMENT })
    return commitStatementImport(fixture.ctx, plan)
  }

  it('says nothing has posted while the rows sit in the inbox', async () => {
    await importStatement(fixture.financialAccountId)
    const [tie] = (await cashTieOut(fixture.ctx)).filter(
      (row) => row.financialAccountId === fixture.financialAccountId,
    )

    expect(tie.feedCents).toBe(0)
    expect(tie.uncategorizedCount).toBe(2)
  })

  it('agrees once the rows are coded', async () => {
    await importStatement(fixture.financialAccountId)

    const expense = await fixture.account('6100')
    const income = await fixture.account('4000')
    const rows = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))

    for (const row of rows) {
      await categorize(fixture.ctx, row.id, row.amountCents < 0 ? expense.id : income.id)
    }

    const [tie] = (await cashTieOut(fixture.ctx)).filter(
      (row) => row.financialAccountId === fixture.financialAccountId,
    )

    expect(tie.feedCents).toBe(168_760)
    expect(tie.ledgerCents).toBe(168_760)
    expect(tie.differenceCents).toBe(0)
    expect(tie.uncategorizedCount).toBe(0)
  })

  /**
   * The reason this check could not exist before. With two accounts on one
   * ledger account, the ledger figure covers both and the comparison is
   * meaningless in exactly the case it is for.
   */
  it('reports each account separately, because each has its own ledger account', async () => {
    const savings = await createFinancialAccount(fixture.ctx, {
      name: 'Deposit Account',
      kind: 'savings',
    })
    await importStatement(fixture.financialAccountId)

    const rows = await cashTieOut(fixture.ctx)
    expect(rows).toHaveLength(2)

    const bySavings = rows.find((row) => row.financialAccountId === savings.id)!
    expect(bySavings.uncategorizedCount).toBe(0)
    expect(bySavings.feedCents).toBe(0)
    expect(bySavings.chartAccountNumber).toBe('1010')
  })
})

describe('the integrity checks', () => {
  /**
   * `banking.shared_ledger_accounts` had three tests here, from Phase 40 until
   * Phase 122 retired it. The middle one is why: to see the state the check
   * hunted, it had to `ALTER TABLE ... DROP CONSTRAINT` inside a transaction it
   * then rolled back. Nothing short of that could produce a sharing pair —
   * `financial_accounts_chart_account_unique` refuses new ones, and the
   * migration that added it repaired the old ones in the same commit. A test
   * that has to take the database apart to give a check something to find is
   * the check telling you it has nothing to find.
   *
   * What is left below is the pair's surviving sibling, which reads live books
   * and reports a real number.
   */
  it('refuses to hold two bank accounts on one ledger account', async () => {
    // The constraint, asserted directly, in place of the check that used to
    // report after the fact. A constraint beats a check (Phase 116).
    const [existing] = await db
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(eq(financialAccounts.id, fixture.financialAccountId))

    await expect(
      db.insert(financialAccounts).values({
        companyId: fixture.companyId,
        chartAccountId: existing.chartAccountId,
        name: 'Shadow Account',
        kind: 'savings',
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: 'financial_accounts_chart_account_unique' },
    })
  })

  it('reports the tie-out as a position rather than a fault', async () => {
    // Money legitimately enters a bank account without a feed row, so an
    // alarm here would cry wolf on ordinary trading.
    const check = INTEGRITY_CHECKS.find((c) => c.key === 'banking.cash_tie_out')!
    expect(check.severity).toBe('position')
    expect(check.module).toBeNull()
  })
})
