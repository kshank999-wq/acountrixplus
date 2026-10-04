/**
 * What §5's accountant data package is made of, and what of it exists (Phase 158).
 *
 * Exporter spec §5 lists twenty-seven things a *"Standard Accountrix Accountant
 * Data Package"* should contain, and §6 says every adapter must originate from
 * that one normalized model rather than from the operational tables. This
 * registry is the model's table of contents.
 *
 * ## Why this is a registry and not a type
 *
 * A `type AccountantPackage = { trialBalance: …, generalLedger: … }` would say
 * what the package holds and nothing about what it *should* hold, so the four
 * items Accountrix cannot produce today would be invisible — absent from the
 * type, absent from the file, and absent from any list of what is missing. A
 * firm would discover the gap by looking for the loan schedule and not finding
 * one.
 *
 * So each of §5's items is declared with the function that produces it, or with
 * `source: null` and a sentence saying why not. `packageGaps()` is then a thing
 * that can be read, printed into the manifest, and asserted on — which is Phase
 * 141's rule: declare the knowledge, measure the fact.
 *
 * ## What the gaps were when this was written
 *
 * Four of the twenty-seven, measured rather than guessed:
 *
 * | §5 item | why not |
 * | --- | --- |
 * | Loan and liability schedules | `loan` is a *financial account kind*; no amortisation schedule is stored |
 * | Adjusting journal entries, separately | entries carry no adjusting flag, so they cannot be split from the rest |
 * | Tax-code mappings | §10's mapping store does not exist; sales-tax codes are not return-line codes |
 * | Supporting-document references | documents are attached per transaction and not indexed for export |
 *
 * None of those is a defect of this phase. Each is a feature with a §5 clause
 * behind it, which is a better backlog than a list of ideas.
 */

import { RegistryError } from '@/modules/errors/registry'
import type { Permission } from '@/modules/permissions'

/** Where a section's figures come from. */
export type SectionSource = {
  /** The module function that produces it, as `module/file:function`. */
  produces: string
  /**
   * The permission that function requires.
   *
   * Declared here because §12 says *"restrict exports by accountant/client
   * permissions"*, and the alternative shape is worse in both directions: an
   * export that takes the broadest permission in the product would let anyone
   * who can see a report take the payroll out in a file, and one that calls
   * every producer unconditionally would throw halfway through for a
   * bookkeeper who cannot see payroll — producing no package at all rather than
   * the package they are entitled to.
   *
   * So a section the caller may not read is **omitted and named in the
   * manifest**. A firm then knows the payroll summary is absent because of who
   * asked rather than because the client has no payroll, which is the one thing
   * a missing file cannot say for itself.
   *
   * `tests/export-sections.test.ts` asserts each value against the
   * `requirePermission` call in the function named by `produces`, so a producer
   * whose permission tightens cannot leave a stale claim here.
   */
  permission: Permission
  /**
   * Whether it lands in the universal package's files today (§4).
   *
   * Some sections are produced by Accountrix and not yet written into the
   * export — that is a different state from not existing, and conflating the
   * two is how a gap list stops being trusted.
   */
  exported: boolean
}

export type PackageSection = {
  /** Stable key, used for file names and for selecting an export scope. */
  key: string
  /** §5's own wording for the item. */
  item: string
  /**
   * `null` when Accountrix cannot produce this today.
   *
   * The `because` then says what is in the way, in terms somebody could act on.
   */
  source: SectionSource | null
  because: string
}

/**
 * §5's package, item by item, in the specification's own order.
 *
 * Order matters: it is the order the files come out in and the order the
 * manifest lists them, so two exports of the same period can be diffed.
 */
export const PACKAGE_SECTIONS: readonly PackageSection[] = [
  {
    key: 'client_entity',
    item: 'Client / entity information',
    source: { produces: 'exporter/entity:companyProfile', permission: 'reports:view', exported: true },
    because:
      'The company row plus its address. Every target keys a client record on some part of this, ' +
      'and §11 makes an incomplete one a red exception rather than a blank column.',
  },
  {
    key: 'entity_classification',
    item: 'Entity type and tax classification',
    source: { produces: 'exporter/entity:companyProfile', permission: 'reports:view', exported: true },
    because:
      'Carried with the entity rather than as its own file, because it is one or two fields and a ' +
      'firm reading a separate CSV for them would wonder what it was missing.',
  },
  {
    key: 'fiscal_year',
    item: 'Fiscal year and tax year',
    source: { produces: 'exporter/entity:companyProfile', permission: 'reports:view', exported: true },
    because:
      'The fiscal year end decides which year the figures land in. Tax year is derived from it and ' +
      'the export window rather than stored twice.',
  },
  {
    key: 'chart_of_accounts',
    item: 'Chart of accounts',
    source: { produces: 'coa/service:listAccounts', permission: 'bookkeeping:view', exported: true },
    because:
      'The spine of every adapter. Account number, name, type and subtype — the subtype because the ' +
      'cash flow statement and cash-basis reporting both classify by it, so a target that groups ' +
      'accounts needs it too.',
  },
  {
    key: 'opening_balances',
    item: 'Opening balances',
    source: { produces: 'ledger/balances:accountBalances', permission: 'reports:view', exported: true },
    because:
      'Balances to the day before the window opens. The same function as the trial balance with a ' +
      'different end date, which is why §11 can check continuity without a second source of truth.',
  },
  {
    key: 'unadjusted_trial_balance',
    item: 'Unadjusted trial balance',
    source: { produces: 'ledger/balances:trialBalance', permission: 'reports:view', exported: true },
    because:
      'What Accountrix holds *is* the unadjusted trial balance from a firm’s point of view: the ' +
      'client’s own books before the accountant’s adjustments. Saying so is more honest than ' +
      'offering both columns and filling them with the same figures.',
  },
  {
    key: 'adjusted_trial_balance',
    item: 'Adjusted trial balance',
    source: { produces: 'ledger/balances:trialBalance', permission: 'reports:view', exported: true },
    because:
      'The same report, and deliberately so. Accountrix posts its own adjustments into the ledger, ' +
      'so its trial balance is adjusted for everything it knows about; the firm’s adjustments are ' +
      'made in the firm’s system and are not in here. A workpaper program expects to receive the ' +
      'client balance and add its own column, which is exactly this.',
  },
  {
    key: 'general_ledger_detail',
    item: 'General ledger detail',
    source: { produces: 'ledger/reports:generalLedger', permission: 'reports:view', exported: true },
    because:
      'The detail behind every balance, carrying the account number and name on each line rather ' +
      'than an id — the same decision §19’s portability export made, for the same reason: a file ' +
      'whose foreign keys point into another file is a database dump.',
  },
  {
    key: 'journal_entries',
    item: 'Journal entries',
    source: { produces: 'ledger/reports:generalLedger', permission: 'reports:view', exported: true },
    because:
      'The same rows as the general ledger detail, grouped by entry rather than by account. One ' +
      'query, two orderings — not two queries, which would be two answers to one question.',
  },
  {
    key: 'adjusting_journal_entries',
    item: 'Adjusting journal entries',
    source: null,
    because:
      'A journal entry carries a source and a memo but no flag saying it is an adjustment, so the ' +
      'adjusting ones cannot be separated from the rest. §8 asks adapters whether a target accepts ' +
      'adjustments *separately from balances*, which is the question this gap blocks. Guessing from ' +
      'the memo text would be worse than saying it is not available.',
  },
  {
    key: 'closing_entries',
    item: 'Closing entries where applicable',
    source: { produces: 'ledger/closing:listCloses', permission: 'accounting:view', exported: true },
    because:
      'Closes are recorded rows with their own entries, so these can be named precisely — which is ' +
      'the contrast with adjusting entries above, and the reason that gap is a gap rather than an ' +
      'oversight.',
  },
  {
    key: 'profit_and_loss',
    item: 'Profit & Loss / Income Statement',
    source: { produces: 'ledger/reports:profitAndLoss', permission: 'reports:financial', exported: true },
    because: 'The statement, with its sections, not a re-grouping of the trial balance.',
  },
  {
    key: 'balance_sheet',
    item: 'Balance Sheet',
    source: { produces: 'ledger/reports:balanceSheet', permission: 'reports:financial', exported: true },
    because: 'As above.',
  },
  {
    key: 'cash_flow',
    item: 'Statement of Cash Flows',
    source: { produces: 'ledger/cash-flow:cashFlowStatement', permission: 'reports:financial', exported: true },
    because:
      'Classified by account subtype, which is why the chart of accounts section carries the ' +
      'subtype out with it — a firm rebuilding the statement needs the same classification.',
  },
  {
    key: 'ar_aging',
    item: 'Accounts Receivable aging',
    source: { produces: 'ledger/reports:arAging', permission: 'reports:view', exported: true },
    because:
      'Bucketed as at the window’s end date. Carries the foreign-currency note `foreignNote` ' +
      'produces, because an aging total that silently mixes currencies is Phase 122’s defect.',
  },
  {
    key: 'ap_aging',
    item: 'Accounts Payable aging',
    source: { produces: 'ledger/reports:apAging', permission: 'reports:view', exported: true },
    because: 'As above, the other side.',
  },
  {
    key: 'bank_reconciliation',
    item: 'Bank reconciliation summaries',
    source: { produces: 'reconciliation/service:reconciliationHistory', permission: 'reconciliation:view', exported: true },
    because:
      'Summaries rather than the cleared-item detail: §5 asks for summaries, and the detail is ' +
      'already in the general ledger. An audit that wants the items has the bank statement.',
  },
  {
    key: 'payroll_summary',
    item: 'Payroll summaries',
    source: { produces: 'payroll/service:payrollSummary', permission: 'payroll:view', exported: true },
    because:
      'Gross, taxes and net by period. Not the per-employee detail — §12 says not to include ' +
      'sensitive fields a target does not require, and a trial-balance import requires none of it.',
  },
  {
    key: 'vendor_1099',
    item: '1099/vendor information',
    source: { produces: 'payroll/vendor-reporting:contractorPayments', permission: 'tax:view', exported: true },
    because:
      'Reportable payments by vendor, which is the figure a firm puts on a 1099 and the one it will ' +
      'ask for by email if the package does not have it.',
  },
  {
    key: 'sales_tax',
    item: 'Sales-tax summaries',
    source: { produces: 'payroll/sales-tax:salesTaxReturn', permission: 'tax:view', exported: true },
    because:
      'Taxable and tax by code and period. These are Accountrix’s own sales-tax codes, which are ' +
      'not the return-line codes a tax program maps to — see the tax-code mapping gap below.',
  },
  {
    key: 'fixed_assets',
    item: 'Fixed-asset and depreciation schedule',
    source: { produces: 'assets/service:assetRegister', permission: 'accounting:view', exported: true },
    because:
      'Cost, accumulated depreciation, method and this period’s charge. The section a tax ' +
      'preparer reaches for first and the one most often sent as a separate spreadsheet.',
  },
  {
    key: 'loan_schedules',
    item: 'Loan and liability schedules',
    source: null,
    because:
      '`loan` is a kind of financial account, so a loan has a balance and transactions but no stored ' +
      'amortisation schedule — no rate, no term, no split of a payment into interest and principal. ' +
      'The balance is in the trial balance; the schedule a firm wants does not exist to export. ' +
      'This is the largest of the four gaps and the clearest feature behind one.',
  },
  {
    key: 'equity_activity',
    item: 'Owner / shareholder equity activity',
    source: { produces: 'ledger/reports:generalLedger', permission: 'reports:view', exported: true },
    because:
      'Ledger detail filtered to the equity accounts. A distinct file because a firm reads it as a ' +
      'statement of changes rather than as part of the ledger, and the same rows either way.',
  },
  {
    key: 'retained_earnings',
    item: 'Retained earnings activity',
    source: { produces: 'ledger/closing:listCloses', permission: 'accounting:view', exported: true },
    because:
      'The closing entries are what moves retained earnings, so this is those entries with the ' +
      'account’s opening and closing balance either side of them.',
  },
  {
    key: 'tax_code_mappings',
    item: 'Tax-code mappings',
    source: null,
    because:
      'Nothing to export yet. §10’s mapping store — firm templates, client overrides, prior-year ' +
      'reuse, entity-type-aware mappings — is a subsystem of its own, and until it exists there is ' +
      'no mapping to put in a file. §11’s `accounts_mapped` and `tax_codes_present` checks read ' +
      '`null` for exactly this reason and refuse a tax destination because of it, so the gap is ' +
      'enforced rather than merely recorded.',
  },
  {
    key: 'dimensions',
    item: 'Class / department / location / project dimensions where applicable',
    source: { produces: 'dimensions/reporting:dimensionalProfitAndLoss', permission: 'reports:financial', exported: false },
    because:
      'Produced and not yet exported, which is the state `exported: false` exists to hold. ' +
      '`dimensionalProfitAndLoss` reports one dimension at a time — class, or department, or ' +
      'location — so a package would carry one file per dimension, and "where applicable" means a ' +
      'company with none should get no file rather than an empty one. Which dimensions a firm wants ' +
      'is a selection, and this phase exports the whole-company package with nothing to select ' +
      'from. Recorded here rather than left out, because a reader comparing this registry to §5 ' +
      'should find the item and its reason in the same place.',
  },
  {
    key: 'document_references',
    item: 'Supporting-document references',
    source: null,
    because:
      'Documents are attached to transactions and reachable from them, but nothing indexes them for ' +
      'export, and §7 asks of every target whether documents *can* be linked or transferred — a ' +
      'question with no answer yet for any of them. Listing file names without the files, or links ' +
      'that only work while somebody is logged in, would be worse than the honest absence.',
  },
]

/** The section a key names. Throws on one nobody declared. */
export function sectionFor(key: string): PackageSection {
  const found = PACKAGE_SECTIONS.find((section) => section.key === key)
  if (!found) {
    throw new RegistryError({
      registry: 'PACKAGE_SECTIONS',
      key,
      message:
        `No package section is declared as "${key}". Exporter spec §5 is the list, and §6 requires ` +
        'every adapter to originate from that one normalized model — so a section an adapter needs ' +
        'is an entry here with the function that produces it, or with the reason it cannot be.',
    })
  }
  return found
}

/** Sections Accountrix can produce and does write into the package. */
export function exportedSections(): PackageSection[] {
  return PACKAGE_SECTIONS.filter((section) => section.source?.exported === true)
}

/**
 * §5 items Accountrix cannot produce, with the reason.
 *
 * Printed into the export manifest, so a firm reading the package learns what is
 * absent from the package rather than from its own search for it.
 */
export function packageGaps(): PackageSection[] {
  return PACKAGE_SECTIONS.filter((section) => section.source === null)
}

/**
 * Sections Accountrix produces and does not yet write into a package.
 *
 * The middle state, kept distinct from both of the others. A firm told that a
 * section is *absent* reads it as "the client does not have this"; told that it
 * is *not exported yet* it reads it as "ask Accountrix" — and those are
 * different phone calls.
 */
export function unexportedSections(): PackageSection[] {
  return PACKAGE_SECTIONS.filter((section) => section.source !== null && !section.source.exported)
}

/** A list of items as a sentence fragment. */
function listOf(sections: PackageSection[]): string {
  const items = sections.map((section) => section.item.toLowerCase())
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The paragraph the manifest carries about what is and is not in the package.
 *
 * One paragraph, because a firm reads the manifest to find out whether it has
 * what it needs, and a bulleted gap analysis invites them to read it as a
 * complaint rather than as a map.
 *
 * `omitted` is the sections the person who ran the export could not read (§12),
 * passed in rather than derived, because it depends on who asked.
 */
export function gapNote(omitted: readonly PackageSection[] = []): string {
  const parts = [
    `This package carries ${exportedSections().length - omitted.length} of the ` +
      `${PACKAGE_SECTIONS.length} sections of the standard accountant data package.`,
  ]

  const gaps = packageGaps()
  if (gaps.length > 0) {
    parts.push(
      `Not held by Accountrix, so absent for every client: ${listOf(gaps)}. The reason for each is ` +
        'recorded against the section in the exporter.',
    )
  }

  const pending = unexportedSections()
  if (pending.length > 0) {
    parts.push(`Held but not yet written into a package: ${listOf(pending)}.`)
  }

  if (omitted.length > 0) {
    parts.push(
      `Omitted because the person who ran this export is not permitted to read them: ` +
        `${listOf([...omitted])}. Their absence says nothing about whether the client has them — ` +
        'an export by somebody with those permissions would include them.',
    )
  }

  return parts.join(' ')
}
