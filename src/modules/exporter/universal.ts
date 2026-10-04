/**
 * The universal accountant package (Phase 158).
 *
 * Exporter spec §4 requires that *"in addition to platform-specific adapters,
 * Accountrix Plus must always support a universal accountant package. This
 * allows a firm to import or manipulate the data even if its exact professional
 * system does not yet have a native adapter."* §15 asks for the same thing from
 * the other end: *"the exporter provides a clear fallback file workflow where no
 * supported API exists."*
 *
 * Today it is also the only thing exportable at all, because §13 requires a
 * vendor integration worksheet before any adapter code and none has been done.
 * That is the honest position and it is not a small one: a firm that receives a
 * balanced trial balance, the detail behind it, the three statements and the
 * agings, in CSV, can get those into any professional system it owns.
 *
 * ## CSV and delimited text, and what is deferred
 *
 * §4 lists four formats and an optional fifth: XLSX, CSV, delimited text, a PDF
 * reporting package, and an optional ZIP. This phase does CSV and delimited
 * text, and says plainly why not the others.
 *
 * - **XLSX** is a ZIP of XML with a shared-string table and a styles part.
 *   Accountrix has nine dependencies and no spreadsheet library, and it wrote
 *   its own PDF writer rather than pulling one in. So XLSX is either a new
 *   dependency or a file of its own, and both are decisions for somebody who
 *   knows which the project wants — not something to slip into a phase about
 *   validation. Every spreadsheet opens CSV in the meantime.
 * - **A PDF reporting package** is a composition of statements this project can
 *   already render; it is a screen and a layout rather than an exporter
 *   question.
 * - **ZIP** needs the same archive writer XLSX does, and is explicitly
 *   *"optional"* in §4.
 *
 * ## Why the rendering is the thing checked
 *
 * `assemble` builds from the same report functions the screens call, so the
 * figures in the package cannot differ from the reports. The one step where a
 * figure can change is here: cents to units. `renderedTotals` reads the trial
 * balance file back and foots it, and §11's `totals_reconcile_to_source`
 * compares that against what `trialBalance` reported — so the check tests the
 * only thing that can actually fail.
 */

import { toCsv } from '@/modules/tenancy/export'
import { decimal } from '@/modules/tenancy/exported-money'
import { gapNote } from './sections'
import { assess } from './readiness'
import { registerAdapter, type ExportAdapter, type ExportFile } from './adapter'
import { sectionsIn, type AccountantPackage } from './package'

/**
 * This adapter's version (§6: independently versioned).
 *
 * `1.0`. It moves when the files or their columns move, not when the
 * application does — a firm that scripted an import against `trial_balance.csv`
 * cares about this number and nothing else.
 */
export const UNIVERSAL_VERSION = '1.0'

/** One CSV file from a set of rows. */
function csv(name: string, columns: string[], rows: Array<Record<string, unknown>>): ExportFile {
  return { name, content: toCsv(rows, columns), rowCount: rows.length }
}

/**
 * The trial balance file.
 *
 * Both columns rather than one signed figure, because §7 asks of every target
 * whether it wants *"signed amount rules or separate debit/credit columns"* and
 * separate columns can always be collapsed into a signed figure while the
 * reverse needs to know each account's normal side. The signed balance is
 * carried too, in its own column, so neither reader has to compute anything.
 */
function trialBalanceFile(pkg: AccountantPackage): ExportFile {
  return csv(
    'trial_balance.csv',
    ['account_number', 'account_name', 'account_type', 'account_subtype', 'debit', 'credit', 'balance'],
    pkg.trialBalance.rows.map((row) => ({
      account_number: row.number,
      account_name: row.name,
      account_type: row.type,
      account_subtype: row.subtype ?? '',
      debit: decimal(row.debitCents),
      credit: decimal(row.creditCents),
      balance: decimal(row.balanceCents),
    })),
  )
}

/**
 * What the rendered trial balance foots to, read back out of the file.
 *
 * Parsed rather than recomputed from the package, which is the whole point: a
 * figure computed twice from the same source agrees with itself whatever the
 * rendering did to it. This reads the text a firm will receive.
 *
 * Returns `null` when the file is not in the set, so a caller that renders a
 * subset gets no opinion rather than a zero.
 */
export function renderedTotals(
  files: readonly ExportFile[],
): { totalDebitCents: number; totalCreditCents: number } | null {
  const file = files.find((candidate) => candidate.name === 'trial_balance.csv')
  if (!file) return null

  const lines = file.content.split(/\r?\n/).filter((line) => line.length > 0)
  const header = lines.shift()
  if (!header) return null

  const columns = header.split(',')
  const debitAt = columns.indexOf('debit')
  const creditAt = columns.indexOf('credit')
  if (debitAt === -1 || creditAt === -1) return null

  let totalDebitCents = 0
  let totalCreditCents = 0

  for (const line of lines) {
    const fields = splitCsvLine(line)
    totalDebitCents += cents(fields[debitAt])
    totalCreditCents += cents(fields[creditAt])
  }

  return { totalDebitCents, totalCreditCents }
}

/**
 * One CSV line into its fields, honouring RFC 4180 quoting.
 *
 * Written rather than split on commas because `toCsv` quotes any field holding a
 * comma — an account called `Sales, retail` — and a naive split would shift
 * every column after it. Reading the file back with a parser that does not
 * understand the writer's quoting would make the reconciliation check report a
 * difference that is in the reader.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false

  for (let at = 0; at < line.length; at += 1) {
    const character = line[at]
    if (quoted) {
      if (character === '"') {
        if (line[at + 1] === '"') {
          field += '"'
          at += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }

  fields.push(field)
  return fields
}

/**
 * A rendered decimal back to cents.
 *
 * Deliberately strict about what it accepts: a thousands separator, a currency
 * symbol or three decimal places all return `NaN`-free nonsense if parsed
 * loosely, and the reconciliation check would then pass on a file no spreadsheet
 * would foot correctly. Anything that is not `-?digits.dd` counts as zero, which
 * makes the totals disagree and the check fire — which is the right outcome,
 * because the file is wrong.
 */
function cents(field: string | undefined): number {
  if (!field) return 0
  const match = /^(-?)(\d+)\.(\d\d)$/.exec(field.trim())
  if (!match) return 0
  const magnitude = Number(match[2]) * 100 + Number(match[3])
  return match[1] === '-' ? -magnitude : magnitude
}

/** Every file of the universal package (§4, §5). */
function generate(pkg: AccountantPackage): ExportFile[] {
  const files: ExportFile[] = []

  // §5 "Client / entity information", "Entity type and tax classification",
  // "Fiscal year and tax year" — one file, because they are a handful of fields
  // and three files for them would read as three things a firm might be missing.
  files.push(
    csv(
      'entity.csv',
      [
        'name',
        'legal_name',
        'industry',
        'functional_currency',
        'fiscal_year_start_month',
        'fiscal_year_end_month',
        'tax_classification',
        'files_as',
        'period_start',
        'period_end',
      ],
      [
        {
          name: pkg.profile.name,
          legal_name: pkg.profile.legalName ?? '',
          industry: pkg.profile.industry,
          functional_currency: pkg.profile.currency,
          fiscal_year_start_month: pkg.profile.fiscalYearStartMonth,
          fiscal_year_end_month: pkg.profile.fiscalYearEndMonth,
          tax_classification: pkg.profile.classification?.label ?? '',
          files_as: pkg.profile.classification?.filesAs ?? '',
          period_start: pkg.period.startDate,
          period_end: pkg.period.endDate,
        },
      ],
    ),
  )
  // The EIN is not here. §12: do not move sensitive fields a target does not
  // require, and a CSV emailed to a firm that already holds the EIN on its
  // engagement letter requires nothing. A destination whose own import needs it
  // is a destination whose worksheet will say so.

  if (pkg.accounts.length > 0) {
    files.push(
      csv(
        'chart_of_accounts.csv',
        ['account_number', 'account_name', 'account_type', 'account_subtype', 'active'],
        pkg.accounts.map((row) => ({
          account_number: row.number,
          account_name: row.name,
          account_type: row.type,
          account_subtype: row.subtype ?? '',
          active: row.isActive ? 'yes' : 'no',
        })),
      ),
    )
  }

  // §5 "Opening balances". Zero-balance accounts included, because an opening
  // balance file a firm ties to last year's signed trial balance has to have a
  // row for every account on it.
  files.push(
    csv(
      'opening_balances.csv',
      ['account_number', 'account_name', 'account_type', 'balance'],
      pkg.openingBalances.map((row) => ({
        account_number: row.number,
        account_name: row.name,
        account_type: row.type,
        balance: decimal(row.balanceCents),
      })),
    ),
  )

  files.push(trialBalanceFile(pkg))

  // §5 "General ledger detail" and "Journal entries" — the same rows, and one
  // file. Two files with identical content in different orders is the kind of
  // package that makes a firm wonder which one is authoritative; the entry
  // number and the account number are both columns, so either sort is a click.
  files.push(
    csv(
      'general_ledger.csv',
      [
        'entry_number',
        'entry_date',
        'source',
        'entry_memo',
        'account_number',
        'account_name',
        'line_memo',
        'debit',
        'credit',
      ],
      pkg.ledgerLines.map((line) => ({
        entry_number: line.entryNumber,
        entry_date: line.entryDate,
        source: line.source,
        entry_memo: line.memo ?? '',
        account_number: line.accountNumber,
        account_name: line.accountName,
        line_memo: line.lineMemo ?? '',
        debit: decimal(line.debitCents),
        credit: decimal(line.creditCents),
      })),
    ),
  )

  if (pkg.profitAndLoss) {
    const pl = pkg.profitAndLoss
    files.push(
      csv(
        'profit_and_loss.csv',
        ['section', 'account_number', 'account_name', 'amount'],
        [
          ...statementRows('Revenue', pl.revenue.rows),
          ...statementRows('Cost of sales', pl.costOfSales.rows),
          ...statementRows('Operating expenses', pl.operatingExpenses.rows),
          ...statementRows('Other income', pl.otherIncome.rows),
          ...statementRows('Other expenses', pl.otherExpenses.rows),
          // Totals as rows rather than as a trailing block, so a firm sorting
          // the file does not lose them. `account_number` empty is what marks
          // them, which a spreadsheet filter handles.
          total('Gross profit', pl.grossProfitCents),
          total('Operating income', pl.operatingIncomeCents),
          total('Net income', pl.netIncomeCents),
        ],
      ),
    )
  }

  if (pkg.balanceSheet) {
    const bs = pkg.balanceSheet
    files.push(
      csv(
        'balance_sheet.csv',
        ['section', 'account_number', 'account_name', 'amount'],
        [
          ...statementRows('Assets', bs.assets.rows),
          ...statementRows('Liabilities', bs.liabilities.rows),
          ...statementRows('Equity', bs.equity.rows),
          total('Net income for the period', bs.netIncomeCents),
          total('Total assets', bs.totalAssetsCents),
          total('Total liabilities and equity', bs.totalLiabilitiesAndEquityCents),
        ],
      ),
    )
  }

  if (pkg.cashFlow) {
    const cf = pkg.cashFlow
    files.push(
      csv(
        'cash_flow.csv',
        ['section', 'account_number', 'account_name', 'cash_effect'],
        [
          { section: 'Operating', account_number: '', account_name: 'Net income', cash_effect: decimal(cf.netIncomeCents) },
          ...cashFlowRows('Operating', cf.operating.lines),
          ...cashFlowRows('Investing', cf.investing.lines),
          ...cashFlowRows('Financing', cf.financing.lines),
          { section: 'Total', account_number: '', account_name: 'Net change in cash', cash_effect: decimal(cf.netChangeInCashCents) },
        ],
      ),
    )
  }

  for (const [name, report] of [
    ['ar_aging.csv', pkg.arAging],
    ['ap_aging.csv', pkg.apAging],
  ] as const) {
    if (!report) continue
    files.push(
      csv(
        name,
        ['party', 'current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_over_90', 'total'],
        report.rows.map((row) => ({
          party: row.partyName,
          current: decimal(row.current),
          days_1_30: decimal(row.d1_30),
          days_31_60: decimal(row.d31_60),
          days_61_90: decimal(row.d61_90),
          days_over_90: decimal(row.d90_plus),
          total: decimal(row.totalCents),
        })),
      ),
    )
  }

  if (pkg.assets && pkg.assets.length > 0) {
    files.push(
      csv(
        'fixed_assets.csv',
        [
          'tag',
          'description',
          'acquired_on',
          'cost',
          'method',
          'life_months',
          'salvage_value',
          'accumulated_depreciation',
          'book_value',
          'status',
          'disposed_on',
        ],
        pkg.assets.map((asset) => ({
          tag: asset.tag,
          description: asset.name,
          acquired_on: asset.acquiredDate,
          cost: decimal(asset.costCents),
          method: asset.method,
          life_months: asset.lifeMonths,
          salvage_value: decimal(asset.salvageValueCents),
          accumulated_depreciation: decimal(asset.accumulatedCents),
          book_value: decimal(asset.bookValueCents),
          status: asset.status,
          disposed_on: asset.disposedOn ?? '',
        })),
      ),
    )
  }

  if (pkg.closes && pkg.closes.length > 0) {
    // §5 "Closing entries" and "Retained earnings activity" — one file, because
    // the close *is* the retained earnings movement.
    files.push(
      csv(
        'closes.csv',
        ['fiscal_year', 'closing_date', 'net_income_closed', 'reopened'],
        pkg.closes.map((close) => ({
          fiscal_year: close.fiscalYear,
          closing_date: close.closingDate,
          net_income_closed: decimal(close.netIncomeCents),
          reopened: close.reopenedAt ? 'yes' : 'no',
        })),
      ),
    )
  }

  if (pkg.payroll) {
    files.push(
      csv(
        'payroll_summary.csv',
        ['runs', 'gross_pay', 'employee_withholding', 'employee_deductions', 'employer_tax', 'net_pay'],
        [
          {
            runs: pkg.payroll.runs,
            gross_pay: decimal(pkg.payroll.grossPayCents),
            employee_withholding: decimal(pkg.payroll.employeeWithholdingCents),
            employee_deductions: decimal(pkg.payroll.employeeDeductionCents),
            employer_tax: decimal(pkg.payroll.employerTaxCents),
            net_pay: decimal(pkg.payroll.netPayCents),
          },
        ],
      ),
    )
  }

  if (pkg.contractors && pkg.contractors.rows.length > 0) {
    files.push(
      csv(
        'contractor_payments.csv',
        ['vendor', 'has_tax_id', 'reportable', 'paid'],
        pkg.contractors.rows.map((row) => ({
          vendor: row.vendorName,
          // Whether, not which. §12 again: a 1099 worksheet needs the figure and
          // the firm already holds the W-9.
          has_tax_id: row.hasTaxId ? 'yes' : 'no',
          reportable: row.isReportable ? 'yes' : 'no',
          paid: decimal(row.paidCents),
        })),
      ),
    )
  }

  if (pkg.salesTax && pkg.salesTax.lines.length > 0) {
    files.push(
      csv(
        'sales_tax.csv',
        ['code', 'name', 'jurisdiction', 'rate_bp', 'gross_sales', 'taxable', 'exempt', 'tax_collected'],
        pkg.salesTax.lines.map((line) => ({
          code: line.code,
          name: line.name,
          jurisdiction: line.jurisdiction,
          rate_bp: line.rateBp,
          gross_sales: decimal(line.grossSalesCents),
          taxable: decimal(line.taxableCents),
          exempt: decimal(line.exemptCents),
          tax_collected: decimal(line.taxCollectedCents),
        })),
      ),
    )
  }

  if (pkg.reconciliations && pkg.reconciliations.length > 0) {
    files.push(
      csv(
        'bank_reconciliations.csv',
        ['statement_start', 'statement_end', 'beginning_balance', 'ending_balance', 'status'],
        pkg.reconciliations.map((row) => ({
          statement_start: row.statementStartDate,
          statement_end: row.statementEndDate,
          beginning_balance: decimal(row.beginningBalanceCents),
          ending_balance: decimal(row.statementEndingBalanceCents),
          status: row.status,
        })),
      ),
    )
  }

  // Last, because it describes the others.
  files.push(manifest(pkg, files))

  return files
}

function statementRows(
  section: string,
  rows: Array<{ number: string; name: string; balanceCents: number }>,
): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    section,
    account_number: row.number,
    account_name: row.name,
    amount: decimal(row.balanceCents),
  }))
}

function total(name: string, cents: number): Record<string, unknown> {
  return { section: 'Total', account_number: '', account_name: name, amount: decimal(cents) }
}

function cashFlowRows(
  section: string,
  lines: Array<{ number: string; name: string; cashEffectCents: number }>,
): Array<Record<string, unknown>> {
  return lines.map((line) => ({
    section,
    account_number: line.number,
    account_name: line.name,
    cash_effect: decimal(line.cashEffectCents),
  }))
}

/**
 * The manifest, which is the file a firm reads first.
 *
 * It carries the readiness report and the gap note, so what is *not* in the
 * package is as legible as what is. A package whose absences have to be
 * discovered by searching for them is the failure §5's list exists to prevent.
 */
function manifest(pkg: AccountantPackage, files: readonly ExportFile[]): ExportFile {
  const assessment = assess(pkg.facts)
  const carried = sectionsIn(pkg)

  const lines = [
    'ACCOUNTRIX PLUS — UNIVERSAL ACCOUNTANT PACKAGE',
    '',
    `Client:        ${pkg.profile.legalName ?? pkg.profile.name}`,
    `Entity type:   ${pkg.profile.classification?.label ?? 'not recorded'}`,
    `Files as:      ${pkg.profile.classification?.filesAs ?? 'not recorded'}`,
    `Period:        ${pkg.period.startDate} to ${pkg.period.endDate}`,
    `Currency:      ${pkg.profile.currency}`,
    `Adapter:       universal ${UNIVERSAL_VERSION}`,
    '',
    'CONTENTS',
    ...files.map((file) => `  ${file.name.padEnd(28)}${file.rowCount} row${file.rowCount === 1 ? '' : 's'}`),
    '',
    'WHAT IS AND IS NOT HERE',
    '',
    wrap(gapNote(pkg.omitted)),
    '',
    `Sections carried: ${carried.length}.`,
    '',
    'READINESS',
    '',
    assessment.exceptions.length === 0
      ? 'Every pre-export check passed.'
      : `${assessment.status.toUpperCase()} — see the exception report below.`,
    '',
    'HOW TO USE THESE FILES',
    '',
    wrap(instructions(pkg)),
  ]

  // Row count zero: the manifest describes the package rather than being part
  // of the books, which is the same decision §19's export made about its own.
  return { name: 'manifest.txt', content: `${lines.join('\n')}\n`, rowCount: 0 }
}

/** Soft-wrap a paragraph at 78 columns, for a file somebody opens in a text editor. */
function wrap(text: string): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    if (line.length === 0) {
      line = word
    } else if (line.length + 1 + word.length <= 78) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line.length > 0) lines.push(line)

  return lines.join('\n')
}

/**
 * §8 `generateManualImportInstructions`.
 *
 * Required of this adapter because it does not transmit, and `adapterStands`
 * enforces that: §15 asks for *"a clear fallback file workflow"*, and a folder
 * of CSVs with no word on what to do with them is not one.
 *
 * Deliberately not instructions for any particular product — this adapter does
 * not know which one the firm uses, and §7 forbids assuming. What it can say is
 * which file is the one to import first and what it foots to, which is what a
 * trial-balance import actually needs.
 */
function instructions(pkg: AccountantPackage): string {
  return (
    `Start with trial_balance.csv: it is the client's books for the period and foots to ` +
    `${decimal(pkg.trialBalance.totalDebitCents)} on both sides. Most professional trial-balance ` +
    'imports want the account number, the account name and separate debit and credit columns, ' +
    'which is exactly its shape. opening_balances.csv is the same chart as at ' +
    `${pkg.period.startDate} less one day, for tying to last year's file. general_ledger.csv is ` +
    'the detail behind every balance and foots to the same total, so it can be used to ' +
    'substantiate a line without going back to the client. The statements and agings are ' +
    'reports rather than import sources — they are here so the figures can be checked against ' +
    'what the client sees on screen. Read manifest.txt for what this package does not contain.'
  )
}

/**
 * The universal adapter (§8's contract).
 *
 * `transmits: false` — there is nothing to transmit to. `acceptsJournalEntries:
 * false` is about the *target*, and this one has no concept of accepting
 * anything; `carriesDocuments: false` because §5's supporting-document
 * references are one of the four sections Accountrix does not hold.
 */
export const universalAdapter: ExportAdapter = {
  destinationKey: 'universal',
  version: UNIVERSAL_VERSION,
  capabilities: {
    transmits: false,
    readsImportErrors: false,
    acceptsJournalEntries: false,
    carriesDocuments: false,
    fileTypes: ['csv', 'txt'],
  },
  // Not a version of anybody's product, which is the one honest `null` here.
  supportedVersions: null,
  assess,
  generate,
  instructions,
}

registerAdapter(universalAdapter)
