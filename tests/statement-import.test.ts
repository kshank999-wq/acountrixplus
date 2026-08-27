import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  commitStatementImport,
  listStatementAccounts,
  planStatementImport,
  StatementImportError,
} from '@/modules/importing/statements'
import { ImportNotReadyError } from '@/modules/importing/plan'
import {
  ImportNotReversibleError,
  listImportRuns,
  reversalBlockers,
  revertImport,
} from '@/modules/importing/reversal'
import { categorize } from '@/modules/bookkeeping/transactions'
import { PermissionError } from '@/modules/permissions'

/**
 * Importing a downloaded bank statement (Phase 39).
 *
 * The claim under test: **the same statement can be imported as many times as
 * you like and the feed does not change**, while two genuinely identical
 * charges on one day stay two transactions.
 *
 * That pair is the whole difficulty. Getting the first without the second is a
 * plain content hash, which silently deletes money. Getting the second without
 * the first is no dedup at all, which is how a February–April export doubles
 * February.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Statement Co' })
})

const HEADER = 'Date,Description,Amount'

/** Three rows, two of which are the same coffee bought twice on one day. */
const MARCH = [
  HEADER,
  '03/14/2026,COFFEE HOUSE,-4.50',
  '03/14/2026,COFFEE HOUSE,-4.50',
  '03/15/2026,CLIENT PAYMENT,2500.00',
].join('\n')

async function importFile(text: string, fileName = 'march.csv') {
  const plan = await planStatementImport(fixture.ctx, {
    financialAccountId: fixture.financialAccountId,
    text,
  })
  return { plan, result: await commitStatementImport(fixture.ctx, plan, { fileName }) }
}

async function feed() {
  return db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.companyId, fixture.companyId))
    .orderBy(bankTransactions.postedDate, bankTransactions.description)
}

describe('importing a statement', () => {
  it('puts the rows in the inbox and posts nothing', async () => {
    const { result } = await importFile(MARCH)
    expect(result.created).toBe(3)
    expect(result.skipped).toBe(0)

    const rows = await feed()
    expect(rows).toHaveLength(3)
    // Everything arrives uncategorised. A statement is evidence of what
    // happened, not a decision about which account it belongs in.
    expect(rows.every((row) => row.reviewState === 'new')).toBe(true)
    expect(rows.every((row) => row.chartAccountId === null)).toBe(true)
    expect(rows.every((row) => row.financialAccountId === fixture.financialAccountId)).toBe(true)
  })

  it('reads money out as negative and money in as positive', async () => {
    await importFile(MARCH)
    const rows = await feed()

    expect(rows.filter((row) => row.amountCents === -450)).toHaveLength(2)
    expect(rows.find((row) => row.description === 'CLIENT PAYMENT')?.amountCents).toBe(250_000)
  })

  /**
   * The case a content hash gets wrong. Two coffees on one day are two
   * transactions, and collapsing them loses £4.50 that the bank definitely
   * took.
   */
  it('keeps two identical charges on one day as two transactions', async () => {
    await importFile(MARCH)
    const coffees = (await feed()).filter((row) => row.description === 'COFFEE HOUSE')

    expect(coffees).toHaveLength(2)
    expect(coffees[0].providerTransactionId).not.toBe(coffees[1].providerTransactionId)
  })

  it('adds nothing when the same file is imported again', async () => {
    await importFile(MARCH)

    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: MARCH,
    })

    // The preview is honest about why: three good rows, none of them new.
    expect(plan.counts.willCreate).toBe(0)
    expect(plan.counts.willSkip).toBe(3)
    expect(plan.counts.errors).toBe(0)

    // And it will not commit. A run of nought rows is not a no-op — it is a
    // line in the history that says an import happened when none did, in the
    // one place that answers "where did these come from".
    expect(plan.canCommit).toBe(false)
    await expect(commitStatementImport(fixture.ctx, plan)).rejects.toThrow(
      /already have all 3/,
    )

    expect(await feed()).toHaveLength(3)
    expect(await listImportRuns(fixture.ctx)).toHaveLength(1)
  })

  /**
   * The realistic case: export January to March, then in April export February
   * to April. Two of the three months arrive twice.
   */
  it('adds only the new rows of an overlapping window', async () => {
    await importFile(
      [HEADER, '01/31/2026,RENT,-1200.00', '02/14/2026,COFFEE HOUSE,-4.50'].join('\n'),
      'jan-feb.csv',
    )

    const { result } = await importFile(
      [HEADER, '02/14/2026,COFFEE HOUSE,-4.50', '03/31/2026,RENT,-1200.00'].join('\n'),
      'feb-mar.csv',
    )

    expect(result.created).toBe(1)
    expect(result.skipped).toBe(1)
    expect(await feed()).toHaveLength(3)
  })

  it('does not confuse the same row in a second account', async () => {
    const other = await createCompanyFixture({ name: 'Other Co' })
    await importFile(MARCH)
    const plan = await planStatementImport(other.ctx, {
      financialAccountId: other.financialAccountId,
      text: MARCH,
    })
    const result = await commitStatementImport(other.ctx, plan)

    // Same file, different account: all three are new there.
    expect(result.created).toBe(3)
  })

  it('says how much the new rows move the account, so the figure can be checked', async () => {
    const { plan } = await importFile(MARCH)
    // −4.50 twice, +2500.00.
    expect(plan.netCentsToAdd).toBe(249_100)
    expect(plan.earliest).toBe('2026-03-14')
    expect(plan.latest).toBe('2026-03-15')
    expect(plan.accountName).toBe('Business Checking')
  })
})

describe('a statement this parser does not understand', () => {
  it('refuses the whole file when one row cannot be read', async () => {
    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: [HEADER, '03/14/2026,COFFEE HOUSE,-4.50', 'not a date,MYSTERY,-9.99'].join('\n'),
    })

    expect(plan.canCommit).toBe(false)
    await expect(commitStatementImport(fixture.ctx, plan)).rejects.toThrow(ImportNotReadyError)
    // Nothing at all, not just the bad row: an import goes in whole or not.
    expect(await feed()).toHaveLength(0)
  })

  it('refuses a row with figures in both money columns rather than netting them', async () => {
    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: ['Date,Description,Withdrawal,Deposit', '03/14/2026,ODD,4.50,9.00'].join('\n'),
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.rows[0].problems.some((problem) => problem.message.includes('both'))).toBe(true)
  })

  it('reads a two-column statement, taking the bank’s debit as money leaving', async () => {
    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: [
        'Date,Description,Withdrawal,Deposit',
        '03/14/2026,COFFEE HOUSE,4.50,',
        '03/15/2026,CLIENT PAYMENT,,2500.00',
      ].join('\n'),
    })

    await commitStatementImport(fixture.ctx, plan)
    const rows = await feed()
    expect(rows.find((row) => row.description === 'COFFEE HOUSE')?.amountCents).toBe(-450)
    expect(rows.find((row) => row.description === 'CLIENT PAYMENT')?.amountCents).toBe(250_000)
  })

  it('warns rather than refuses when a date could be read either way', async () => {
    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: [HEADER, '03/04/2026,COFFEE HOUSE,-4.50'].join('\n'),
    })

    expect(plan.canCommit).toBe(true)
    expect(plan.counts.warnings).toBe(1)
    expect(plan.rows[0].problems[0].message).toContain('either way')
  })

  it('reads the same file differently when told the dates are day-first', async () => {
    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: [HEADER, '03/04/2026,COFFEE HOUSE,-4.50'].join('\n'),
      dateOrder: 'dmy',
    })

    await commitStatementImport(fixture.ctx, plan)
    expect((await feed())[0].postedDate).toBe('2026-04-03')
  })

  it('refuses a file with no money column at all', async () => {
    const plan = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: ['Date,Description', '03/14/2026,COFFEE HOUSE'].join('\n'),
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.fileProblems.some((problem) => problem.message.includes('Money out'))).toBe(true)
  })

  it('refuses an account belonging to somebody else', async () => {
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    await expect(
      planStatementImport(fixture.ctx, {
        financialAccountId: other.financialAccountId,
        text: MARCH,
      }),
    ).rejects.toThrow(StatementImportError)
  })
})

describe('undoing a statement import', () => {
  it('removes the rows nobody has touched', async () => {
    const { result } = await importFile(MARCH)
    const [run] = await listImportRuns(fixture.ctx)

    expect(await reversalBlockers(fixture.ctx, run.id)).toEqual([])
    const reversal = await revertImport(fixture.ctx, run.id)

    expect(result.created).toBe(3)
    expect(reversal.deleted['bank transaction']).toBe(3)
    expect(await feed()).toHaveLength(0)
  })

  it('refuses once a row has been categorised and posted', async () => {
    await importFile(MARCH)
    const [coffee] = await feed()
    const expense = await fixture.account('6100')
    await categorize(fixture.ctx, coffee.id, expense.id)

    const [run] = await listImportRuns(fixture.ctx)
    const blockers = await reversalBlockers(fixture.ctx, run.id)

    expect(blockers.some((blocker) => blocker.includes('categorised'))).toBe(true)
    await expect(revertImport(fixture.ctx, run.id)).rejects.toThrow(ImportNotReversibleError)
    // And nothing was half-removed on the way to refusing.
    expect(await feed()).toHaveLength(3)
  })

  it('lets the import be run again after it is undone', async () => {
    await importFile(MARCH)
    const [run] = await listImportRuns(fixture.ctx)
    await revertImport(fixture.ctx, run.id)

    const { result } = await importFile(MARCH)
    expect(result.created).toBe(3)
    expect(await feed()).toHaveLength(3)
  })

  /**
   * The person who imports a statement is a bookkeeper. Requiring an
   * accountant to undo it would mean the person who made the mistake has to
   * find somebody else to fix it.
   */
  it('is a bookkeeper’s to undo, even though an opening balance is not', async () => {
    await importFile(MARCH)
    const [run] = await listImportRuns(fixture.ctx)
    const bookkeeper = { ...fixture.ctx, role: 'bookkeeper' as const }

    const reversal = await revertImport(bookkeeper, run.id)
    expect(reversal.deleted['bank transaction']).toBe(3)
  })
})

describe('who may import a statement', () => {
  it('is a bookkeeper, who cannot bring the opening books across', async () => {
    const bookkeeper = { ...fixture.ctx, role: 'bookkeeper' as const }
    const plan = await planStatementImport(bookkeeper, {
      financialAccountId: fixture.financialAccountId,
      text: MARCH,
    })
    expect((await commitStatementImport(bookkeeper, plan)).created).toBe(3)
  })

  it('is not somebody with no bookkeeping access at all', async () => {
    const sales = { ...fixture.ctx, role: 'sales' as const }
    await expect(
      planStatementImport(sales, { financialAccountId: fixture.financialAccountId, text: MARCH }),
    ).rejects.toThrow(PermissionError)
  })

  it('offers only this company’s accounts', async () => {
    const other = await createCompanyFixture({ name: 'Not Yours' })
    const accounts = await listStatementAccounts(fixture.ctx)

    expect(accounts.map((account) => account.id)).toEqual([fixture.financialAccountId])
    expect(accounts.map((account) => account.id)).not.toContain(other.financialAccountId)
  })
})

describe('two people importing the same file at once', () => {
  /**
   * Both plans are computed before either commits, so both believe every row
   * is new. The database is what decides — the unique constraint over
   * (company, account, fingerprint) means the loser writes nothing.
   */
  it('leaves one copy of each row, because the database arbitrates', async () => {
    const first = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: MARCH,
    })
    const second = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: MARCH,
    })

    const a = await commitStatementImport(fixture.ctx, first)
    const b = await commitStatementImport(fixture.ctx, second)

    expect(a.created).toBe(3)
    expect(b.created).toBe(0)
    expect(b.skipped).toBe(3)
    expect(await feed()).toHaveLength(3)
  })

  it('does not record an import record for a row it did not write', async () => {
    const first = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: MARCH,
    })
    const second = await planStatementImport(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      text: MARCH,
    })
    await commitStatementImport(fixture.ctx, first)
    await commitStatementImport(fixture.ctx, second)

    // Undoing the second run must not delete the first run's rows.
    const runs = await listImportRuns(fixture.ctx)
    await revertImport(fixture.ctx, runs[0].id)

    expect(await feed()).toHaveLength(3)
  })
})

describe('the run that is kept', () => {
  it('records what was imported, from where, and by whom', async () => {
    await importFile(MARCH, 'chase-march.csv')
    const [run] = await listImportRuns(fixture.ctx)

    expect(run.kind).toBe('bank_statement')
    expect(run.fileName).toBe('chase-march.csv')
    expect(run.rowCount).toBe(3)
    expect(run.createdCount).toBe(3)

    const [written] = await db
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.companyId, fixture.companyId),
          eq(bankTransactions.description, 'CLIENT PAYMENT'),
        ),
      )
    expect(written).toBeDefined()
  })
})
