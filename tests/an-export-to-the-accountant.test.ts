import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { accountantExports, auditEvents, chartAccounts, companies } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { postManualEntry } from '@/modules/ledger/journal'
import { setTaxProfile, companyProfile, taxIdentifier } from '@/modules/exporter/entity'
import { exportForAccountant, exportHistory, readinessFor } from '@/modules/exporter/service'
import { renderedTotals, UNIVERSAL_VERSION } from '@/modules/exporter/universal'
import { assemble } from '@/modules/exporter/package'
import { gapNote } from '@/modules/exporter/sections'
import { Refusal } from '@/modules/errors'

/**
 * An export to the accountant (Phase 158).
 *
 * The acceptance test for the Professional Accountant Export Engine's own Phase
 * 1 — *"Universal accountant data model, balancing, mapping, audit logging,
 * CSV/XLSX package"* — which is the only one of its five phases that needs no
 * vendor research.
 *
 * `tests/export-engine.test.ts` holds the registries and the §11 checks against
 * fixtures, because that is the only way to see each check *disagree*. This file
 * is the whole thing over real books: assemble, validate, render, log.
 */

let fixture: Fixture

/** $4,000 of joinery, and a $1,200 timber bill, both in January. */
const SALE = 400_000
const TIMBER = 120_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Hartley Joinery' })

  const cash = await fixture.account('1000')
  const sales = await fixture.account('4000')
  const cogs = await fixture.account('5000')

  await postManualEntry(fixture.ctx, {
    entryDate: '2026-01-15',
    memo: 'Kitchen fit-out, 14 Mill Lane',
    lines: [
      { chartAccountId: cash.id, debitCents: SALE },
      { chartAccountId: sales.id, creditCents: SALE },
    ],
  })

  await postManualEntry(fixture.ctx, {
    entryDate: '2026-01-20',
    memo: 'Timber, Cawthorne Sawmill',
    lines: [
      { chartAccountId: cogs.id, debitCents: TIMBER },
      { chartAccountId: cash.id, creditCents: TIMBER },
    ],
  })
})

const YEAR = { destinationKey: 'universal', startDate: '2026-01-01', endDate: '2026-12-31' }

/** One file out of a result, by name. */
function file(files: Array<{ name: string; content: string }>, name: string): string {
  const found = files.find((candidate) => candidate.name === name)
  expect(found, `${name} should be in the package`).toBeTruthy()
  return found!.content
}

describe('a client profile the books could not hold', () => {
  it('holds the export until somebody says which return these books feed', async () => {
    /**
     * How this phase found its migration. §11 makes an incomplete client profile
     * a **red** exception, because the entity type decides which return the
     * figures feed — and `companies` held a name, an industry, a fiscal year
     * start and a currency, and no entity type at all.
     *
     * So the check would have fired on every company in existence, and a red
     * check that can only fail is worth as little as Phase 121's check that can
     * only agree. It was not going to be the check that changed.
     */
    await expect(exportForAccountant(fixture.ctx, YEAR)).rejects.toThrow(Refusal)

    const { assessment } = await readinessFor(fixture.ctx, YEAR)
    expect(assessment.status).toBe('red')
    expect(assessment.exceptions.map((exception) => exception.code)).toContain(
      'entity_data_complete',
    )
  })

  it('is not the industry, and the two are kept apart', async () => {
    // A joinery can be a sole proprietorship, a partnership or an S
    // corporation. `industry` drives the chart of accounts; this drives the
    // return. Bending one to mean both would be Phase 130's defect in the field
    // a federal return is selected from.
    const profile = await setTaxProfile(fixture.ctx, {
      classification: 's_corporation',
      taxIdentifier: '81-4455210',
    })

    expect(profile.industry).toBe('general')
    expect(profile.classification?.key).toBe('s_corporation')
    expect(profile.classification?.filesAs).toContain('1120-S')
  })

  it('refuses a tax identifier that is not one', async () => {
    await expect(
      setTaxProfile(fixture.ctx, { classification: 'partnership', taxIdentifier: 'ask Denise' }),
    ).rejects.toThrow(/nine digits/)
  })

  it('carries whether an EIN exists, and not the EIN', async () => {
    /**
     * §12: *"do not include sensitive fields that are not required by the target
     * system."* The readiness assessment is shown on screen, written into the
     * export log and pasted into support tickets, so it carries the answer to
     * *is one on file* and nothing more. Reading the number is a second call a
     * caller has to decide to make.
     */
    await setTaxProfile(fixture.ctx, {
      classification: 'c_corporation',
      taxIdentifier: '81-4455210',
    })

    const profile = await companyProfile(fixture.ctx)
    expect(profile.hasTaxIdentifier).toBe(true)
    expect(JSON.stringify(profile)).not.toContain('4455210')

    expect(await taxIdentifier(fixture.ctx)).toBe('81-4455210')
  })

  it('derives the fiscal year end rather than storing a second month', async () => {
    // Two columns that must agree are two answers to one question, and the one
    // a preparer asks for is the end.
    const calendar = await companyProfile(fixture.ctx)
    expect(calendar.fiscalYearStartMonth).toBe(1)
    expect(calendar.fiscalYearEndMonth).toBe(12)

    await db
      .update(companies)
      .set({ fiscalYearStartMonth: 7 })
      .where(eq(companies.id, fixture.companyId))

    expect((await companyProfile(fixture.ctx)).fiscalYearEndMonth).toBe(6)
  })
})

describe('the universal accountant package', () => {
  beforeEach(async () => {
    await setTaxProfile(fixture.ctx, {
      classification: 's_corporation',
      taxIdentifier: '81-4455210',
    })
  })

  it('exports, and the trial balance foots to what the report says', async () => {
    const result = await exportForAccountant(fixture.ctx, YEAR)

    expect(result.assessment.status).toBe('green')
    expect(result.adapterVersion).toBe(UNIVERSAL_VERSION)

    // The figures, read back out of the file a firm receives rather than
    // recomputed from the package — which is the point of the check: a figure
    // computed twice from one source agrees with itself whatever the rendering
    // did to it.
    expect(renderedTotals(result.files)).toEqual({
      totalDebitCents: SALE + TIMBER,
      totalCreditCents: SALE + TIMBER,
    })

    const trialBalance = file(result.files, 'trial_balance.csv')
    expect(trialBalance).toContain('account_number,account_name')
    // $4,000.00 as 4000.00 — units, not cents. A file that opens in a
    // spreadsheet showing 400000 for $4,000 is not an export an accountant can
    // use.
    expect(trialBalance).toContain(',4000.00,')
  })

  it('ties its own two halves together', async () => {
    /**
     * §11's *"export totals reconcile to Accountrix source reports"*, which is
     * the reconciliation a firm actually performs: the balances per account
     * against the lines behind them.
     *
     * They are two queries with separately written filters — posted only,
     * inside the window, joined to an account that exists — so they can
     * genuinely disagree. Here they do not.
     */
    const result = await exportForAccountant(fixture.ctx, YEAR)

    const detail = file(result.files, 'general_ledger.csv')
    const lines = detail.trim().split(/\r?\n/).slice(1)
    expect(lines).toHaveLength(4)

    const debits = lines.reduce((total, line) => {
      const fields = line.split(',')
      return total + Math.round(Number(fields[fields.length - 2] || 0) * 100)
    }, 0)
    expect(debits).toBe(SALE + TIMBER)
  })

  it('carries the statements, the agings and the opening balances', async () => {
    const result = await exportForAccountant(fixture.ctx, YEAR)
    const names = result.files.map((f) => f.name)

    for (const expected of [
      'entity.csv',
      'chart_of_accounts.csv',
      'opening_balances.csv',
      'trial_balance.csv',
      'general_ledger.csv',
      'profit_and_loss.csv',
      'balance_sheet.csv',
      'cash_flow.csv',
      'ar_aging.csv',
      'ap_aging.csv',
      'manifest.txt',
    ]) {
      expect(names, `${expected} missing`).toContain(expected)
    }

    // The statements are reports and not import sources, and the P&L shows the
    // period's profit: $4,000 of sales less $1,200 of timber.
    expect(file(result.files, 'profit_and_loss.csv')).toContain('Net income,2800.00')
  })

  it('does not put the EIN in the file', async () => {
    // §12 again, at the only place it could actually leak: the entity file is
    // the one a firm opens to create the client record.
    const result = await exportForAccountant(fixture.ctx, YEAR)

    expect(file(result.files, 'entity.csv')).not.toContain('4455210')
    expect(result.files.map((f) => f.content).join('\n')).not.toContain('4455210')
  })

  it('says in the manifest what the package does not contain', async () => {
    /**
     * The file a firm reads first. A package whose absences have to be
     * discovered by searching for them is the failure §5's list exists to
     * prevent — so the four items Accountrix does not hold are named, with the
     * reasons recorded against them.
     */
    const result = await exportForAccountant(fixture.ctx, YEAR)
    const manifest = file(result.files, 'manifest.txt')

    expect(manifest).toContain('UNIVERSAL ACCOUNTANT PACKAGE')
    expect(manifest).toContain('Files as:')
    expect(manifest).toContain('1120-S')
    expect(manifest).toContain('loan and liability schedules')
    expect(manifest).toContain('tax-code mappings')
    // §15's fallback workflow: which file to import first and what it foots to.
    expect(manifest).toContain('Start with trial_balance.csv')
    expect(manifest).toContain('5200.00')
  })

  it('tells a firm which rows it is getting', async () => {
    const result = await exportForAccountant(fixture.ctx, YEAR)
    const manifest = file(result.files, 'manifest.txt')

    expect(manifest).toContain('general_ledger.csv')
    // The manifest describes the package rather than being part of the books,
    // which is why its own row count is zero — the same call §19's export made.
    expect(result.files.find((f) => f.name === 'manifest.txt')?.rowCount).toBe(0)
  })

  it('quotes a field that would otherwise shift every column after it', async () => {
    // RFC 4180, and not optional: an account called `Sales, retail` silently
    // moves the debit column into the name column. The reader this phase wrote
    // for the reconciliation check honours the same rules, so a file that is
    // quoted wrongly fails the check rather than passing it.
    const sales = await fixture.account('4000')
    await db
      .update(chartAccounts)
      .set({ name: 'Sales, retail' })
      .where(eq(chartAccounts.id, sales.id))

    const result = await exportForAccountant(fixture.ctx, YEAR)
    expect(file(result.files, 'trial_balance.csv')).toContain('"Sales, retail"')
    expect(renderedTotals(result.files)?.totalCreditCents).toBe(SALE + TIMBER)
  })
})

describe('the export log §12 requires', () => {
  beforeEach(async () => {
    await setTaxProfile(fixture.ctx, {
      classification: 's_corporation',
      taxIdentifier: '81-4455210',
    })
  })

  it('records who exported what, where to, for when, and with which adapter', async () => {
    const result = await exportForAccountant(fixture.ctx, YEAR)

    const [row] = await db
      .select()
      .from(accountantExports)
      .where(eq(accountantExports.id, result.logId))

    expect(row.destinationKey).toBe('universal')
    expect(row.adapterVersion).toBe(UNIVERSAL_VERSION)
    expect(row.requestedBy).toBe(fixture.userId)
    expect(row.periodStart).toBe('2026-01-01')
    expect(row.periodEnd).toBe('2026-12-31')
    expect(row.readiness).toBe('green')
    expect(row.result).toBe('generated')
    expect(row.fileCount).toBeGreaterThan(5)
    expect(row.byteCount).toBeGreaterThan(0)

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, result.logId))
    expect(audit).toHaveLength(1)
    expect(audit[0].action).toBe('data.export')
  })

  it('records an export that did not happen, which is the row worth having', async () => {
    /**
     * The one design decision in that table. §11 produces red and no file, and
     * that event is the most valuable thing in the log: somebody tried to send
     * these books to professional software and could not, and the exception
     * report says why in sentences.
     *
     * A log that records only successes cannot answer *did anybody try*, which
     * is the first question asked when a filing is late.
     */
    const bare = await createCompanyFixture({ name: 'No Profile Ltd' })

    await expect(exportForAccountant(bare.ctx, YEAR)).rejects.toThrow(Refusal)

    const [row] = await db
      .select()
      .from(accountantExports)
      .where(eq(accountantExports.companyId, bare.companyId))

    expect(row.result).toBe('held')
    expect(row.readiness).toBe('red')
    expect(row.fileCount).toBeNull()
    expect(row.byteCount).toBeNull()
    // The report itself is the refusal, and it is stored. A generic "export
    // failed validation" beside a report somebody then has to find is the shape
    // this project keeps removing (Phase 119).
    expect(row.exceptionReport).toContain('The export is held')
    expect(row.exceptionCount).toBeGreaterThan(0)
  })

  it('refuses in the database to record a red export that produced files', async () => {
    /**
     * §15's *"every export is balanced and validated before release"* as a
     * constraint rather than a check (Phase 116): the path that skipped the
     * validation cannot write the row that records having skipped it.
     */
    const forbidden = db.insert(accountantExports).values({
      companyId: fixture.companyId,
      destinationKey: 'universal',
      adapterVersion: UNIVERSAL_VERSION,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      readiness: 'red',
      exceptionCount: 1,
      exceptionReport: 'RED — and yet here are eleven files.',
      result: 'generated',
      fileCount: 11,
      byteCount: 4096,
    })

    // The constraint's name is on the driver error's `cause` rather than in its
    // message, which is ADR 0074's whole point: the message a person would see
    // carries none of this, and the fact that ends the problem in a minute lives
    // one level down.
    const refused = await forbidden.then(
      () => null,
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause,
    )

    expect(refused?.constraint_name).toBe('accountant_exports_red_is_held')
  })

  it('does not log a request for a destination that is not one', async () => {
    // Nothing was attempted against a client's books — the destination is not a
    // destination, and a row per competitor somebody types into a URL is noise
    // in the record §12 asks for.
    await expect(
      exportForAccountant(fixture.ctx, { ...YEAR, destinationKey: 'quickbooks-online' }),
    ).rejects.toThrow(/not an export destination/)

    expect(await exportHistory(fixture.ctx)).toEqual([])
  })

  it('refuses a planned destination with the sentence that says what is missing', async () => {
    await expect(
      exportForAccountant(fixture.ctx, { ...YEAR, destinationKey: 'cch-axcess-tax' }),
    ).rejects.toThrow(/nobody has established how it actually accepts a trial balance/)
  })

  it('reads back newest first', async () => {
    await exportForAccountant(fixture.ctx, YEAR)
    await exportForAccountant(fixture.ctx, { ...YEAR, endDate: '2026-06-30' })

    const history = await exportHistory(fixture.ctx)
    expect(history).toHaveLength(2)
    expect(history.map((row) => row.periodEnd)).toContain('2026-06-30')
  })
})

describe('what the package does with a permission the caller lacks', () => {
  it('omits the section and names it, rather than failing or over-reaching', async () => {
    /**
     * §12: *"restrict exports by accountant/client permissions."*
     *
     * Two shapes are worse than this one. An export taking the broadest
     * permission in the product would let anybody who can see a report take the
     * payroll home in a file. One calling every producer unconditionally would
     * throw halfway through for a bookkeeper who cannot see payroll — producing
     * no package at all rather than the package they are entitled to.
     *
     * So the section is omitted and the manifest says so. A firm then knows the
     * payroll summary is absent because of who asked rather than because the
     * client has no payroll, which is the one thing a missing file cannot say
     * for itself.
     */
    await setTaxProfile(fixture.ctx, { classification: 's_corporation' })

    // `accountant` holds `reports:financial` and `payroll:view`; `bookkeeper`
    // holds neither, and holds `reports:view` — so one gets every section and
    // the other gets the books without the statements or the payroll.
    const accountant = { ...fixture.ctx, role: 'accountant' as const }
    const bookkeeper = { ...fixture.ctx, role: 'bookkeeper' as const }

    const full = await assemble(accountant, YEAR)
    const partial = await assemble(bookkeeper, YEAR)

    // The bookkeeper is entitled to less, and gets a package rather than an
    // error. Measured rather than asserted by name: whichever sections the role
    // cannot read, there is at least one and it is recorded.
    expect(full.omitted).toEqual([])
    expect(partial.omitted.map((section) => section.key).sort()).toEqual([
      'balance_sheet',
      'cash_flow',
      'payroll_summary',
      'profit_and_loss',
    ])

    // The books themselves are identical. What the bookkeeper loses is the
    // statements and the payroll, not the ledger.
    expect(partial.trialBalance.rows.length).toBe(full.trialBalance.rows.length)
    expect(partial.profitAndLoss).toBeNull()
    expect(partial.payroll).toBeNull()

    // And the manifest says which, in the words a firm needs: the absence says
    // nothing about whether the client has them.
    const note = gapNote(partial.omitted)
    expect(note).toContain('not permitted to read them')
    expect(note).toContain('payroll summaries')
  })
})
