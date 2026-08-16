import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, customers, invoices, vendors } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { MalformedFileError, parseDelimited, readSheet, sniffDelimiter, stripBom } from '@/modules/importing/csv'
import {
  cleanText,
  isAmbiguousDate,
  looksLikeEmail,
  parseBoolean,
  parseDateISO,
  parseMoneyCents,
} from '@/modules/importing/coerce'
import {
  ACCOUNT_FIELDS,
  CONTACT_FIELDS,
  TRIAL_BALANCE_FIELDS,
  normalizeHeader,
  proposeMapping,
} from '@/modules/importing/mapping'
import { ImportNotReadyError, summarizeProblems } from '@/modules/importing/plan'
import {
  commitAccountImport,
  normalizeAccountType,
  planAccountImport,
} from '@/modules/importing/accounts'
import { commitContactImport, contactKey, planContactImport } from '@/modules/importing/contacts'
import {
  commitOpenDocumentImport,
  commitTrialBalanceImport,
  openingReadiness,
  planOpenDocumentImport,
  planTrialBalanceImport,
} from '@/modules/importing/opening-balances'
import {
  ImportNotReversibleError,
  listImportRuns,
  reversalBlockers,
  revertImport,
} from '@/modules/importing/reversal'
import { trialBalance } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'
import { createInvoice } from '@/modules/receivables/service'
import { accountByNumber } from '@/modules/coa/service'

/**
 * Bringing an existing business's books in (spec §20 Phase 8, Phase 17).
 *
 * The claim under test: **nothing is imported until all of it can be, and
 * Opening Balance Equity clears to zero when it has been.** The parsing block
 * is the groundwork; the rest are the ways a migration goes wrong.
 */

describe('reading a file somebody else exported', () => {
  it('handles the things real CSV files do', () => {
    expect(parseDelimited('a,b\n"Portland, OR",2')).toEqual([
      ['a', 'b'],
      ['Portland, OR', '2'],
    ])
    expect(parseDelimited('a,b\n"line one\nline two",2')).toEqual([
      ['a', 'b'],
      ['line one\nline two', '2'],
    ])
    expect(parseDelimited('a\n"say ""hello"""')).toEqual([['a'], ['say "hello"']])
    expect(parseDelimited('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    // A trailing separator is an empty last field, not a missing one.
    expect(parseDelimited('a,b,c\n1,2,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ])
  })

  /**
   * Excel writes a byte-order mark on every CSV it saves. Left in place the
   * first header arrives as `﻿Account`, the mapping fails to match it,
   * and the user is told their file has no Account column while looking at a
   * file that plainly does.
   */
  it('strips the byte-order mark Excel writes', () => {
    expect(stripBom('﻿Account')).toBe('Account')
    expect(readSheet('﻿Account,Name\n1000,Cash').headers).toEqual(['Account', 'Name'])
  })

  /**
   * A tab-separated file of addresses has more commas than tabs — "Portland,
   * OR" in every row — so counting raw frequency picks the comma and shreds
   * the file. Consistency across rows is what identifies the real separator.
   */
  it('picks the delimiter by consistency, not by frequency', () => {
    const tabbed = 'Name\tCity\nAcme, Inc\tPortland, OR\nBeta, LLC\tSalem, OR'
    expect(sniffDelimiter(tabbed)).toBe('\t')
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',')
  })

  it('drops blank rows and pads short ones', () => {
    const sheet = readSheet('a,b,c\n\n1,2,3\n\n\n4,5\n')
    expect(sheet.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', ''],
    ])
    expect(sheet.blankRowsSkipped).toBe(3)
  })

  it('refuses a file whose quotes never close', () => {
    expect(() => parseDelimited('a,b\n"never closed,2')).toThrow(MalformedFileError)
  })

  it('refuses an empty file', () => {
    expect(() => readSheet('')).toThrow(MalformedFileError)
    expect(() => readSheet('\n\n\n')).toThrow(MalformedFileError)
  })
})

describe('reading what a person typed', () => {
  it('reads money the way accounting packages write it', () => {
    expect(parseMoneyCents('1234.56')).toBe(123_456)
    expect(parseMoneyCents('$1,234.56')).toBe(123_456)
    expect(parseMoneyCents('USD 1,234.56')).toBe(123_456)
    expect(parseMoneyCents('(1,234.56)')).toBe(-123_456)
    expect(parseMoneyCents('-1234.56')).toBe(-123_456)
    expect(parseMoneyCents('1234.56-')).toBe(-123_456)
    expect(parseMoneyCents('1234')).toBe(123_400)
    expect(parseMoneyCents('0')).toBe(0)
    expect(parseMoneyCents('$0.07')).toBe(7)
  })

  /**
   * `1.234` is one thousand two hundred and thirty-four in Europe and one and
   * a bit in the US, and nothing in the cell says which. A fifty-fifty guess
   * about somebody's money is not a guess worth making.
   */
  it('refuses European decimal notation rather than guessing', () => {
    expect(parseMoneyCents('1.234,56')).toBeNull()
  })

  it('refuses a comma that is not a thousands separator', () => {
    // Reading `1,23` as 123 would turn $1.23 into $123.00.
    expect(parseMoneyCents('1,23')).toBeNull()
    expect(parseMoneyCents('12,3456')).toBeNull()
  })

  it('refuses more precision than money has', () => {
    expect(parseMoneyCents('1.2345')).toBeNull()
  })

  it('treats an empty cell and a dash as no amount', () => {
    expect(parseMoneyCents('')).toBeNull()
    expect(parseMoneyCents('-')).toBeNull()
  })

  it('reads dates, and settles the ambiguous ones where it can', () => {
    expect(parseDateISO('2026-03-17')).toBe('2026-03-17')
    expect(parseDateISO('17-Mar-2026')).toBe('2026-03-17')
    expect(parseDateISO('Mar 17, 2026')).toBe('2026-03-17')
    expect(parseDateISO('3/17/26')).toBe('2026-03-17')

    // The setting decides only when the row does not.
    expect(parseDateISO('03/04/2026', 'mdy')).toBe('2026-03-04')
    expect(parseDateISO('03/04/2026', 'dmy')).toBe('2026-04-03')
    // 25 can only be a day, whatever was picked.
    expect(parseDateISO('25/03/2026', 'mdy')).toBe('2026-03-25')
  })

  it('refuses a date that does not exist', () => {
    expect(parseDateISO('02/31/2026')).toBeNull()
    expect(parseDateISO('02/29/2026')).toBeNull()
    expect(parseDateISO('02/29/2028')).toBe('2028-02-29')
    expect(parseDateISO('sometime last spring')).toBeNull()
  })

  it('flags a date that could be read two ways', () => {
    expect(isAmbiguousDate('03/04/2026')).toBe(true)
    expect(isAmbiguousDate('25/04/2026')).toBe(false)
    expect(isAmbiguousDate('2026-03-04')).toBe(false)
  })

  it('reads the shapes of yes and no', () => {
    expect(parseBoolean('Yes')).toBe(true)
    expect(parseBoolean('N')).toBe(false)
    expect(parseBoolean('maybe')).toBeNull()
  })

  it('tidies text and recognises an email', () => {
    expect(cleanText('  Acme   Ltd  ')).toBe('Acme Ltd')
    expect(looksLikeEmail('jo@harborview.test')).toBe(true)
    expect(looksLikeEmail('jo at harborview')).toBe(false)
  })
})

describe('matching their column names to ours', () => {
  it('maps a QuickBooks chart export without being asked', () => {
    const mapping = proposeMapping(
      ['Account #', 'Account Name', 'Account Type', 'Detail Type'],
      ACCOUNT_FIELDS,
    )

    expect(mapping.columns.number).toBe('Account #')
    expect(mapping.columns.name).toBe('Account Name')
    expect(mapping.columns.type).toBe('Account Type')
    expect(mapping.columns.subtype).toBe('Detail Type')
    expect(mapping.missingRequired).toEqual([])
  })

  /**
   * Without one-header-one-field, an `amount` field scoring equally against
   * `Debit` and `Credit` claims both, and the second column silently vanishes
   * from the import.
   */
  it('gives each column to one field', () => {
    const mapping = proposeMapping(['GL Code', 'Description', 'Debit', 'Credit'], TRIAL_BALANCE_FIELDS)

    expect(mapping.columns.debit).toBe('Debit')
    expect(mapping.columns.credit).toBe('Credit')
    expect(mapping.columns.number).toBe('GL Code')

    const assigned = Object.values(mapping.columns).filter(Boolean)
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('says which required columns are missing rather than guessing', () => {
    const mapping = proposeMapping(['Foo', 'Bar'], ACCOUNT_FIELDS)
    expect(mapping.missingRequired.sort()).toEqual(['name', 'number', 'type'])
    expect(mapping.unmatchedHeaders).toEqual(['Foo', 'Bar'])
  })

  it('normalizes headers so punctuation does not matter', () => {
    expect(normalizeHeader('Account #')).toBe('account')
    expect(normalizeHeader('E-Mail Address')).toBe('e mail address')
  })

  it('maps a contact export', () => {
    const mapping = proposeMapping(
      ['Display Name', 'Main Email', 'Main Phone', 'Bill Address City'],
      CONTACT_FIELDS,
    )
    expect(mapping.columns.name).toBe('Display Name')
    expect(mapping.columns.email).toBe('Main Email')
    expect(mapping.columns.city).toBe('Bill Address City')
  })

  it('collapses repeated problems into something readable', () => {
    const problems = Array.from({ length: 400 }, (_, i) => ({
      row: i + 1,
      message: 'No account number.',
      severity: 'error' as const,
    }))
    problems.push({ row: 12, message: 'Something else.', severity: 'error' as const })

    const summary = summarizeProblems(problems)
    expect(summary[0]).toContain('400 rows')
    expect(summary).toHaveLength(2)
  })
})

const CHART = `Account #,Account Name,Account Type
1000,Checking Account,Bank
4000,Sales Revenue,Income
5000,Cost of Goods Sold,Cost of Goods Sold
6400,Rent and Lease,Expense
7100,Consulting Fees Earned,Income
7200,Software Subscriptions,Other Current Asset`

describe('the chart of accounts', () => {
  it('recognises what other systems call each type', () => {
    expect(normalizeAccountType('Income')).toBe('revenue')
    expect(normalizeAccountType('Other Current Asset')).toBe('asset')
    expect(normalizeAccountType('Cost of Goods Sold')).toBe('cogs')
    expect(normalizeAccountType('Credit Card')).toBe('liability')
    expect(normalizeAccountType('Bank')).toBe('asset')
    expect(normalizeAccountType('Sausages')).toBeNull()
  })

  it('creates what is new and updates what is not', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planAccountImport(fixture.ctx, { text: CHART })
    expect(plan.canCommit).toBe(true)

    // 1000, 4000, 5000 and 6400 are in the standard chart already.
    expect(plan.counts.willUpdate).toBe(4)
    expect(plan.counts.willCreate).toBe(2)

    const result = await commitAccountImport(fixture.ctx, plan, { fileName: 'chart.csv' })
    expect(result.created).toBe(2)
    expect(result.updated).toBe(4)

    const [added] = await db
      .select()
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, fixture.companyId))
      .then((rows) => rows.filter((row) => row.number === '7100'))

    expect(added.name).toBe('Consulting Fees Earned')
    expect(added.type).toBe('revenue')
  })

  it('refuses a type it does not understand rather than picking one', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planAccountImport(fixture.ctx, {
      text: 'Account #,Account Name,Account Type\n9500,Mystery,Widgets',
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.rows[0].problems[0].message).toContain('not an account type')
    await expect(commitAccountImport(fixture.ctx, plan)).rejects.toThrow(ImportNotReadyError)
  })

  it('refuses a file that uses one account number twice', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planAccountImport(fixture.ctx, {
      text: 'Account #,Account Name,Account Type\n7100,First,Expense\n7100,Second,Expense',
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.rows[1].problems[0].message).toContain('appears twice')
  })

  /**
   * Changing the type of an account that already carries postings would move
   * money between sections of the profit and loss for every period ever
   * reported.
   */
  it('never changes the type of an account that already exists', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planAccountImport(fixture.ctx, {
      text: 'Account #,Account Name,Account Type\n4000,Renamed Revenue,Expense',
    })
    await commitAccountImport(fixture.ctx, plan)

    const [account] = await db
      .select()
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, fixture.companyId))
      .then((rows) => rows.filter((row) => row.number === '4000'))

    expect(account.name).toBe('Renamed Revenue')
    expect(account.type).toBe('revenue')
  })
})

describe('customers and vendors', () => {
  const PEOPLE = `Display Name,Main Email,Bill Address City
Harborview LLC,jo@harborview.test,Portland
Cityworks Inc.,dana@cityworks.test,Salem
Northgate Partners,not-an-email,Eugene`

  it('imports, and warns about a bad email without dropping the row', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planContactImport(fixture.ctx, { kind: 'customers', text: PEOPLE })
    expect(plan.canCommit).toBe(true)
    expect(plan.counts.warnings).toBe(1)

    const result = await commitContactImport(fixture.ctx, 'customers', plan)
    expect(result.created).toBe(3)

    const rows = await db.select().from(customers).where(eq(customers.companyId, fixture.companyId))
    expect(rows).toHaveLength(3)
    // The row with the malformed address is still there, with the value kept
    // as written so somebody can correct it.
    expect(rows.find((row) => row.name === 'Northgate Partners')?.email).toBe('not-an-email')
  })

  /**
   * `Acme, Inc.` in the old system and `Acme Inc` typed in here are one
   * business, and importing both leaves two ledgers for one customer with half
   * the history each.
   */
  it('recognises the same business written differently', () => {
    expect(contactKey('Acme, Inc.')).toBe(contactKey('Acme Inc'))
    expect(contactKey('Harborview LLC')).toBe(contactKey('harborview  l l c'))
    // And stops short of merging two businesses that merely share a prefix.
    expect(contactKey('Acme Northwest')).not.toBe(contactKey('Acme North West'))
  })

  it('updates an existing customer without blanking what it does not know', async () => {
    const fixture = await createCompanyFixture()

    await db.insert(customers).values({
      companyId: fixture.companyId,
      name: 'Harborview, Inc.',
      email: 'corrected@harborview.test',
    })

    const plan = await planContactImport(fixture.ctx, {
      kind: 'customers',
      text: 'Display Name,Main Email,Main Phone\nHarborview Inc,stale@harborview.test,555-0100',
    })
    expect(plan.counts.willUpdate).toBe(1)

    await commitContactImport(fixture.ctx, 'customers', plan)

    const [row] = await db.select().from(customers).where(eq(customers.companyId, fixture.companyId))
    // The newer value in the application wins; the gap is filled from the file.
    expect(row.email).toBe('corrected@harborview.test')
    expect(row.phone).toBe('555-0100')
  })

  it('imports vendors into the vendor list, not the customer list', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planContactImport(fixture.ctx, {
      kind: 'vendors',
      text: 'Name,Email\nDelta Electrical,ap@delta.test',
    })
    await commitContactImport(fixture.ctx, 'vendors', plan)

    expect(await db.select().from(vendors).where(eq(vendors.companyId, fixture.companyId))).toHaveLength(1)
    expect(await db.select().from(customers).where(eq(customers.companyId, fixture.companyId))).toHaveLength(0)
  })
})

/**
 * A migration, end to end. The numbers are chosen so the detail agrees with
 * the control accounts exactly, which is the case Opening Balance Equity is
 * supposed to reduce to zero.
 */
const TRIAL_BALANCE = `Account,Description,Debit,Credit
1000,Checking Account,"25,000.00",
1100,Accounts Receivable,"8,400.00",
1400,Inventory,"3,600.00",
2000,Accounts Payable,,"5,200.00"
4000,Sales Revenue,,"31,800.00"`

const OPEN_INVOICES = `Customer,Invoice No,Date,Due Date,Open Balance
Harborview LLC,INV-9001,01/15/2026,02/14/2026,"5,200.00"
Cityworks Inc,INV-9002,01/28/2026,02/27/2026,"3,200.00"`

const OPEN_BILLS = `Vendor,Bill No,Date,Open Balance
Delta Electrical,B-7781,01/20/2026,"5,200.00"`

async function migrated(): Promise<Fixture> {
  const fixture = await createCompanyFixture()

  const accounts = await planAccountImport(fixture.ctx, { text: CHART })
  await commitAccountImport(fixture.ctx, accounts)

  const people = await planContactImport(fixture.ctx, {
    kind: 'customers',
    text: 'Display Name\nHarborview LLC\nCityworks Inc',
  })
  await commitContactImport(fixture.ctx, 'customers', people)

  const suppliers = await planContactImport(fixture.ctx, {
    kind: 'vendors',
    text: 'Name\nDelta Electrical',
  })
  await commitContactImport(fixture.ctx, 'vendors', suppliers)

  return fixture
}

describe('opening balances', () => {
  it('posts a trial balance as one entry against Opening Balance Equity', async () => {
    const fixture = await migrated()

    const plan = await planTrialBalanceImport(fixture.ctx, { text: TRIAL_BALANCE })
    expect(plan.balances).toBe(true)
    expect(plan.canCommit).toBe(true)
    // The file as written foots — that is what `balances` checks.
    expect(plan.fileDebitCents).toBe(3_700_000)
    expect(plan.fileCreditCents).toBe(3_700_000)
    // What actually posts excludes the two control accounts, so it does not
    // foot on its own. Opening Balance Equity is the difference, by design.
    expect(plan.totalDebitCents).toBe(2_860_000)
    expect(plan.totalCreditCents).toBe(3_180_000)

    // Five rows in the file, but Accounts Receivable and Accounts Payable are
    // not posted from here — the open documents supply them.
    const result = await commitTrialBalanceImport(fixture.ctx, plan, { asOfDate: '2026-01-31' })
    expect(result.lineCount).toBe(3)
    expect(plan.receivableControlCents).toBe(840_000)
    expect(plan.payableControlCents).toBe(520_000)

    const balances = await trialBalance(fixture.ctx)
    expect(balances.isBalanced).toBe(true)
  })

  /**
   * A half-posted opening balance is an unbalanced ledger, and the tool that
   * caused it is the tool they would have to use to find it.
   */
  it('refuses a trial balance that does not balance, and posts nothing', async () => {
    const fixture = await migrated()

    const before = await trialBalance(fixture.ctx)
    const plan = await planTrialBalanceImport(fixture.ctx, {
      text: 'Account,Debit,Credit\n1000,"25,000.00",\n4000,,"24,000.00"',
    })

    expect(plan.balances).toBe(false)
    expect(plan.canCommit).toBe(false)
    expect(plan.fileProblems.some((problem) => problem.message.includes('does not balance'))).toBe(true)

    await expect(
      commitTrialBalanceImport(fixture.ctx, plan, { asOfDate: '2026-01-31' }),
    ).rejects.toThrow(ImportNotReadyError)

    const after = await trialBalance(fixture.ctx)
    expect(after.totalDebitCents).toBe(before.totalDebitCents)
  })

  it('refuses a balance for an account that does not exist', async () => {
    const fixture = await migrated()

    const plan = await planTrialBalanceImport(fixture.ctx, {
      text: 'Account,Debit,Credit\n9999,"100.00",\n1000,,"100.00"',
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.rows[0].problems[0].message).toContain('no account 9999')
  })

  it('refuses a row carrying both a debit and a credit', async () => {
    const fixture = await migrated()

    const plan = await planTrialBalanceImport(fixture.ctx, {
      text: 'Account,Debit,Credit\n1000,"100.00","100.00"',
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.rows[0].problems[0].message).toContain('both a debit and a credit')
  })

  it('reads a single signed balance column too', async () => {
    const fixture = await migrated()

    const plan = await planTrialBalanceImport(fixture.ctx, {
      text: 'Account,Balance\n1000,"25,000.00"\n4000,"(25,000.00)"',
    })

    expect(plan.balances).toBe(true)
    expect(plan.canCommit).toBe(true)
  })

  /**
   * The claim. The whole migration reduces to one number, and that number
   * being zero is what says the books are open and consistent.
   */
  it('clears Opening Balance Equity to zero when the detail agrees', async () => {
    const fixture = await migrated()

    const balances = await planTrialBalanceImport(fixture.ctx, { text: TRIAL_BALANCE })
    await commitTrialBalanceImport(fixture.ctx, balances, { asOfDate: '2026-01-31' })

    const receivable = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: OPEN_INVOICES,
    })
    expect(receivable.canCommit).toBe(true)
    expect(receivable.totalCents).toBe(840_000)
    await commitOpenDocumentImport(fixture.ctx, 'open_invoices', receivable)

    const payable = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_bills',
      text: OPEN_BILLS,
    })
    await commitOpenDocumentImport(fixture.ctx, 'open_bills', payable)

    const readiness = await openingReadiness(fixture.ctx)

    expect(readiness.openingBalanceEquityCents).toBe(0)
    expect(readiness.isClear).toBe(true)
    expect(readiness.receivablesAgree).toBe(true)
    expect(readiness.payablesAgree).toBe(true)
    expect(readiness.diagnosis).toContain('complete and consistent')

    // And the books still balance after all of it.
    expect((await trialBalance(fixture.ctx)).isBalanced).toBe(true)
  })

  /**
   * The failure case is where the value is. A non-zero Opening Balance Equity
   * is not a mystery — it is exactly the gap, named.
   */
  it('says exactly why Opening Balance Equity is not zero', async () => {
    const fixture = await migrated()

    const balances = await planTrialBalanceImport(fixture.ctx, { text: TRIAL_BALANCE })
    await commitTrialBalanceImport(fixture.ctx, balances, { asOfDate: '2026-01-31' })

    // Only one of the two invoices making up the $8,400 receivable.
    const partial = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: `Customer,Invoice No,Date,Open Balance\nHarborview LLC,INV-9001,01/15/2026,"5,200.00"`,
    })
    await commitOpenDocumentImport(fixture.ctx, 'open_invoices', partial)

    const readiness = await openingReadiness(fixture.ctx)

    expect(readiness.isClear).toBe(false)
    expect(readiness.receivablesAgree).toBe(false)
    expect(readiness.receivablesReportedCents).toBe(840_000)
    expect(readiness.receivablesDetailCents).toBe(520_000)
    expect(readiness.diagnosis).toContain('$3,200.00')
    expect(readiness.diagnosis).toContain('less than the receivables balance')
  })

  /**
   * The sale happened in the old system and was reported there. Recognising it
   * again here would double the company's lifetime revenue and put a year's
   * trading into whatever month the migration happened.
   */
  it('brings an open invoice across without recognising its revenue again', async () => {
    const fixture = await migrated()

    const plan = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: OPEN_INVOICES,
    })
    await commitOpenDocumentImport(fixture.ctx, 'open_invoices', plan)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.revenue.totalCents).toBe(0)

    // But the receivable is real, and so is the invoice.
    const rows = await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))
    expect(rows).toHaveLength(2)
    expect(rows.reduce((sum, row) => sum + row.balanceCents, 0)).toBe(840_000)
  })

  it('refuses an invoice for a customer nobody has imported', async () => {
    const fixture = await migrated()

    const plan = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: 'Customer,Invoice No,Date,Open Balance\nNobody At All,INV-1,01/15/2026,"100.00"',
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.unknownParties).toEqual(['Nobody At All'])
    expect(plan.rows[0].problems[0].message).toContain('Import customers first')
  })

  it('warns when the dates in a file could be read two ways', async () => {
    const fixture = await migrated()

    const plan = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: 'Customer,Invoice No,Date,Open Balance\nHarborview LLC,INV-1,03/04/2026,"100.00"',
    })

    expect(plan.canCommit).toBe(true)
    expect(plan.fileProblems.some((problem) => problem.message.includes('read two ways'))).toBe(true)
  })

  /**
   * A zero here on a company that never migrated means nothing was posted,
   * not that a migration reconciled. Congratulating somebody on a complete
   * opening position they never attempted is a reassurance they cannot rely
   * on.
   */
  it('does not call an untouched company’s books a completed migration', async () => {
    const fixture = await createCompanyFixture()

    const readiness = await openingReadiness(fixture.ctx)
    expect(readiness.openingBalanceEquityCents).toBe(0)
    expect(readiness.receivablesReportedCents).toBeNull()
    expect(readiness.diagnosis).toContain('No opening balances have been imported')
    expect(readiness.diagnosis).not.toContain('complete and consistent')
  })

  it('refuses a negative outstanding amount rather than inventing a credit note', async () => {
    const fixture = await migrated()

    const plan = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: 'Customer,Invoice No,Date,Open Balance\nHarborview LLC,INV-1,01/15/2026,"(100.00)"',
    })

    expect(plan.canCommit).toBe(false)
    expect(plan.rows[0].problems[0].message).toContain('credit note')
  })
})

describe('undoing an import', () => {
  it('removes what it created and leaves the books where they started', async () => {
    const fixture = await createCompanyFixture()

    const before = await trialBalance(fixture.ctx)
    const beforeAccounts = await db
      .select()
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, fixture.companyId))

    const plan = await planAccountImport(fixture.ctx, { text: CHART })
    const { runId } = await commitAccountImport(fixture.ctx, plan)

    expect(await reversalBlockers(fixture.ctx, runId)).toEqual([])
    const result = await revertImport(fixture.ctx, runId)

    expect(result.deleted.account).toBe(2)
    // The four that already existed were updated, not created, so they stay.
    expect(result.updatesLeftAlone).toBe(4)

    const afterAccounts = await db
      .select()
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, fixture.companyId))

    expect(afterAccounts).toHaveLength(beforeAccounts.length)
    expect((await trialBalance(fixture.ctx)).totalDebitCents).toBe(before.totalDebitCents)
  })

  it('voids the opening entry rather than deleting it', async () => {
    const fixture = await migrated()

    const plan = await planTrialBalanceImport(fixture.ctx, { text: TRIAL_BALANCE })
    const { runId } = await commitTrialBalanceImport(fixture.ctx, plan, { asOfDate: '2026-01-31' })

    const result = await revertImport(fixture.ctx, runId)
    expect(result.entriesVoided).toBe(1)

    // Nothing left on the books, and nothing erased from the history either.
    const balances = await trialBalance(fixture.ctx)
    expect(balances.totalDebitCents).toBe(0)
    expect(balances.isBalanced).toBe(true)
  })

  it('removes imported invoices and the entries behind them', async () => {
    const fixture = await migrated()

    const plan = await planOpenDocumentImport(fixture.ctx, {
      kind: 'open_invoices',
      text: OPEN_INVOICES,
    })
    const { runId } = await commitOpenDocumentImport(fixture.ctx, 'open_invoices', plan)

    await revertImport(fixture.ctx, runId)

    expect(await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))).toHaveLength(0)
    expect((await trialBalance(fixture.ctx)).totalDebitCents).toBe(0)
  })

  /**
   * A timestamp window would sweep up whatever else happened in the same
   * minute. Reversal is by name, and it stops when what it made is in use.
   */
  it('refuses when something it created has since been used', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planContactImport(fixture.ctx, {
      kind: 'customers',
      text: 'Name\nHarborview LLC',
    })
    const { runId } = await commitContactImport(fixture.ctx, 'customers', plan)

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.companyId, fixture.companyId))

    const revenue = await accountByNumber(fixture.companyId, '4000')
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-02-01',
      lines: [
        {
          description: 'Work done since the import',
          quantityMilli: 1000,
          unitPriceCents: 50_000,
          chartAccountId: revenue!.id,
        },
      ],
    })

    const blockers = await reversalBlockers(fixture.ctx, runId)
    expect(blockers[0]).toContain('invoice has been raised against imported customers')
    await expect(revertImport(fixture.ctx, runId)).rejects.toThrow(ImportNotReversibleError)

    // And the customer is still there, because nothing was half-undone.
    expect(await db.select().from(customers).where(eq(customers.companyId, fixture.companyId))).toHaveLength(1)
  })

  it('refuses to undo the same import twice', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planAccountImport(fixture.ctx, { text: CHART })
    const { runId } = await commitAccountImport(fixture.ctx, plan)

    await revertImport(fixture.ctx, runId)
    expect(await reversalBlockers(fixture.ctx, runId)).toEqual(['This import has already been undone.'])
    await expect(revertImport(fixture.ctx, runId)).rejects.toThrow(ImportNotReversibleError)
  })

  it('keeps the history of every import, reverted or not', async () => {
    const fixture = await createCompanyFixture()

    const plan = await planAccountImport(fixture.ctx, { text: CHART })
    const { runId } = await commitAccountImport(fixture.ctx, plan, { fileName: 'chart.csv' })
    await revertImport(fixture.ctx, runId)

    const runs = await listImportRuns(fixture.ctx)
    expect(runs).toHaveLength(1)
    expect(runs[0].fileName).toBe('chart.csv')
    expect(runs[0].status).toBe('reverted')
    expect(runs[0].revertedAt).not.toBeNull()
  })

  it('keeps one company’s imports invisible to another', async () => {
    const mine = await createCompanyFixture()
    const theirs = await createCompanyFixture()

    const plan = await planAccountImport(mine.ctx, { text: CHART })
    const { runId } = await commitAccountImport(mine.ctx, plan)

    expect(await listImportRuns(theirs.ctx)).toHaveLength(0)
    expect(await reversalBlockers(theirs.ctx, runId)).toEqual([
      'That import does not exist on these books.',
    ])
  })
})
