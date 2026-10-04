/**
 * The one normalized package every adapter starts from (Phase 158).
 *
 * Exporter spec §6's flow, in order: *"Accountrix operational accounting
 * database → Normalized Accountant Export Model → Validation and balancing
 * engine → Target-system mapping layer → Platform-specific adapter → Export
 * file"*. This module is the second box, and the point of it is that the fifth
 * box never touches the first.
 *
 * ## The decision this file is built around
 *
 * §15 requires that *"the exported totals reconcile exactly to the Accountrix
 * reports for the same period"*, and there are two ways to get there.
 *
 * The exporter could write its own queries and then check its answers against
 * the reports'. That is two answers to one question — the defect this project
 * has named since Phase 100 — and the comparison is a check that will one day
 * disagree, leaving an accountant holding two trial balances with no way to tell
 * which is the books.
 *
 * So `assemble` calls `trialBalance`, `profitAndLoss`, `balanceSheet`,
 * `cashFlowStatement`, `arAging`, `apAging`, `assetRegister`, `salesTaxReturn`,
 * `contractorPayments` and `payrollSummary` — the same functions the screens
 * call. Reconciliation is then structural rather than checked, which is what
 * Phase 116 settled: a constraint beats a check.
 *
 * Exactly one query is written here, and it is written here on purpose: the
 * general ledger detail. `generalLedger` reports one account at a time, so a
 * whole-period detail file through it would be one query per account. That query
 * is the one thing in this package that *can* disagree with the reports, and
 * §11's `detail_ties_to_balances` is the check that catches it.
 *
 * ## Who asked matters (§12)
 *
 * §12 says to *"restrict exports by accountant/client permissions"*, and §5's
 * sections sit behind eight different permissions. Calling every producer
 * unconditionally would throw halfway through for a bookkeeper who cannot see
 * payroll — producing no package rather than the package they are entitled to.
 *
 * So each section's permission is declared in `PACKAGE_SECTIONS`, a section the
 * caller cannot read is omitted, and the manifest names it. A firm then knows
 * the payroll summary is absent because of who asked rather than because the
 * client has no payroll — which is the one thing a missing file cannot say for
 * itself.
 *
 * The trial balance is the exception: without `reports:view` there is no package
 * at all, and `requirePermission` says so.
 */

import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, journalEntries, journalLines } from '@/db/schema'
import { can, requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import {
  accountBalances,
  trialBalance,
  type AccountBalance,
  type TrialBalance,
} from '@/modules/ledger/balances'
import {
  apAging,
  arAging,
  balanceSheet,
  profitAndLoss,
  type BalanceSheet,
  type ProfitAndLoss,
} from '@/modules/ledger/reports'
import { cashFlowStatement, type CashFlowStatement } from '@/modules/ledger/cash-flow'
import type { AgingReport } from '@/modules/ledger/aging'
import { listCloses, staleCloses } from '@/modules/ledger/closing'
import { listAccounts } from '@/modules/coa/service'
import { reconciliationHistory } from '@/modules/reconciliation/service'
import { payrollSummary } from '@/modules/payroll/service'
import { contractorPayments } from '@/modules/payroll/vendor-reporting'
import { salesTaxReturn } from '@/modules/payroll/sales-tax'
import { assetRegister } from '@/modules/assets/service'
import { companyProfile, type CompanyProfile } from './entity'
import { destinationFor, type ExportDestination } from './destinations'
import { PACKAGE_SECTIONS, sectionFor, type PackageSection } from './sections'
import { requiresMapping, type PackageFacts } from './readiness'

/** The day before a date, as a date string. */
function previousDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}

/**
 * One line of general ledger detail.
 *
 * Carries the account's number and name rather than only its id, for the reason
 * §19's portability export carries them: a file whose foreign keys point into
 * another file is a database dump, and one an accountant can read is a set of
 * statements.
 */
export type PackageLedgerLine = {
  entryId: string
  entryDate: string
  /** The company's own sequential number, which is how an entry is referred to. */
  entryNumber: number
  /** What raised it — `manual`, an invoice, a payroll run. §5's audit trail. */
  source: string
  memo: string | null
  accountNumber: string
  accountName: string
  lineMemo: string | null
  debitCents: number
  creditCents: number
}

/**
 * The normalized package (§5).
 *
 * `null` on a section means the person running the export may not read it. An
 * empty array means they may and the client has none — and keeping those two
 * apart is the whole reason the type is shaped this way.
 */
export type AccountantPackage = {
  destination: ExportDestination
  profile: CompanyProfile
  period: { startDate: string; endDate: string }

  /** Sections `assemble` left out for want of a permission (§12). */
  omitted: PackageSection[]

  /** §5 "Chart of accounts". */
  accounts: Array<{
    number: string
    name: string
    type: string
    subtype: string | null
    isActive: boolean
  }>
  /** §5 "Opening balances" — balances to the day before the window opens. */
  openingBalances: AccountBalance[]
  /** §5 "Unadjusted" and "Adjusted trial balance", which are the same report. */
  trialBalance: TrialBalance
  /** §5 "General ledger detail" and "Journal entries" — one query, two orderings. */
  ledgerLines: PackageLedgerLine[]

  profitAndLoss: ProfitAndLoss | null
  balanceSheet: BalanceSheet | null
  cashFlow: CashFlowStatement | null
  arAging: AgingReport | null
  apAging: AgingReport | null

  /** §5 "Closing entries" and "Retained earnings activity". */
  closes: Awaited<ReturnType<typeof listCloses>> | null
  reconciliations: Awaited<ReturnType<typeof reconciliationHistory>> | null
  payroll: Awaited<ReturnType<typeof payrollSummary>> | null
  contractors: Awaited<ReturnType<typeof contractorPayments>> | null
  salesTax: Awaited<ReturnType<typeof salesTaxReturn>> | null
  assets: Awaited<ReturnType<typeof assetRegister>> | null

  /** What §11 judges, derived from everything above. */
  facts: PackageFacts
}

export type AssembleOptions = {
  destinationKey: string
  startDate: string
  endDate: string
}

/**
 * Reads a company's books into §5's normalized package.
 *
 * Does not validate: `assess` does that, from `facts`. Keeping them apart is
 * what lets §9's workflow ask for a readiness opinion before generating
 * anything, and what lets a held export still write an audit row saying why.
 */
export async function assemble(
  ctx: ActorContext,
  opts: AssembleOptions,
): Promise<AccountantPackage> {
  // The spine. Without it there is no package to omit sections from, so this is
  // a refusal rather than an omission.
  requirePermission(ctx, 'reports:view')

  const destination = destinationFor(opts.destinationKey)
  const { startDate, endDate } = opts

  if (endDate < startDate) {
    // Refused here as well as checked in §11, and deliberately: a reversed
    // window makes every query below return nothing, and a package of empty
    // files with one red exception buried in it reads as a client with no
    // activity. The check exists for the case where somebody assesses without
    // assembling.
    throw new Refusal(
      `The export period ends on ${endDate}, before it starts on ${startDate}. Nothing falls inside it.`,
    )
  }

  const omitted: PackageSection[] = []
  /** Whether the caller may read a section, recording the omission if not. */
  const mayRead = (key: string): boolean => {
    const section = sectionFor(key)
    if (section.source === null || !section.source.exported) return false
    if (can(ctx, section.source.permission)) return true
    if (!omitted.some((already) => already.key === section.key)) omitted.push(section)
    return false
  }

  const range = { startDate, endDate }
  const openingAsAt = previousDay(startDate)

  const profile = await companyProfile(ctx)

  const [accountRows, openingBalances, tb, ledgerLines, detailTotals, orphanLineCount, unpostedEntryCount] =
    await Promise.all([
      mayRead('chart_of_accounts') ? listAccounts(ctx) : Promise.resolve([]),
      accountBalances(ctx, { endDate: openingAsAt, includeZero: true }),
      trialBalance(ctx, range),
      detailLines(ctx, range),
      detailSums(ctx, range),
      orphanLines(ctx),
      unpostedEntries(ctx, range),
    ])

  const [
    pl,
    bs,
    cf,
    ar,
    ap,
    closes,
    staleBefore,
    reconciliations,
    payroll,
    contractors,
    salesTax,
    assets,
  ] = await Promise.all([
    mayRead('profit_and_loss') ? profitAndLoss(ctx, range) : Promise.resolve(null),
    mayRead('balance_sheet') ? balanceSheet(ctx, { asOfDate: endDate }) : Promise.resolve(null),
    mayRead('cash_flow') ? cashFlowStatement(ctx, range) : Promise.resolve(null),
    mayRead('ar_aging') ? arAging(ctx, { asOfDate: endDate }) : Promise.resolve(null),
    mayRead('ap_aging') ? apAging(ctx, { asOfDate: endDate }) : Promise.resolve(null),
    mayRead('closing_entries') ? listCloses(ctx) : Promise.resolve(null),
    // Same permission as the closes, and asked separately because this is the
    // continuity fact rather than a section of the package.
    can(ctx, 'accounting:view') ? staleCloses(ctx) : Promise.resolve(null),
    mayRead('bank_reconciliation') ? reconciliationHistory(ctx) : Promise.resolve(null),
    mayRead('payroll_summary') ? payrollSummary(ctx, range) : Promise.resolve(null),
    mayRead('vendor_1099')
      ? contractorPayments(ctx, { year: Number(endDate.slice(0, 4)) })
      : Promise.resolve(null),
    mayRead('sales_tax')
      ? salesTaxReturn(ctx, { periodStart: startDate, periodEnd: endDate })
      : Promise.resolve(null),
    mayRead('fixed_assets') ? assetRegister(ctx, { asOf: endDate }) : Promise.resolve(null),
  ])

  const mapped = requiresMapping(destination.kind)

  const facts: PackageFacts = {
    destinationKey: destination.key,
    entity: {
      name: profile.legalName ?? profile.name,
      taxClassification: profile.classification?.key ?? null,
      fiscalYearEndMonth: profile.fiscalYearEndMonth,
      hasTaxIdentifier: profile.hasTaxIdentifier,
    },
    period: range,
    trialBalance: {
      totalDebitCents: tb.totalDebitCents,
      totalCreditCents: tb.totalCreditCents,
      rowCount: tb.rows.length,
    },
    continuity:
      staleBefore === null
        ? null
        : staleBefore
            // Only years that end before the export window: drift inside the
            // window is this period's problem and shows up in its own figures,
            // while drift before it is carried into the opening balances.
            .filter((close) => close.closingDate < startDate)
            .map((close) => ({
              fiscalYear: close.fiscalYear,
              driftCents: close.netIncomeDriftCents,
              entriesSinceCloseCount: close.entriesSinceCloseCount,
            })),
    orphanLineCount,
    unpostedEntryCount,
    accountNumbers: tb.rows.map((row) => row.number),
    // Null rather than zero, and the distinction is the point: nobody has
    // established a mapping for any §3 target, which is not the same as having
    // established that nothing is unmapped. §10's store is what changes this.
    unmappedAccountCount: mapped ? null : 0,
    missingTaxCodeCount: mapped ? null : 0,
    formatVersionConfirmed: mapped ? null : true,
    // Filled in by the adapter once it has written the files.
    rendered: null,
    detail: detailTotals,
  }

  return {
    destination,
    profile,
    period: range,
    omitted,
    accounts: accountRows.map((row) => ({
      number: row.number,
      name: row.name,
      type: row.type,
      subtype: row.subtype,
      isActive: row.isActive,
    })),
    openingBalances,
    trialBalance: tb,
    ledgerLines,
    profitAndLoss: pl,
    balanceSheet: bs,
    cashFlow: cf,
    arAging: ar,
    apAging: ap,
    closes,
    reconciliations,
    payroll,
    contractors,
    salesTax,
    assets,
    facts,
  }
}

/**
 * The general ledger detail, in one query.
 *
 * The only query this module writes. `generalLedger` reports one account at a
 * time — it has an opening balance and a running total, which is what a register
 * screen needs — so a whole-period detail file through it would be one round
 * trip per account and a different shape besides.
 *
 * The filters are deliberately the same three `accountBalances` applies: the
 * company, posted status, and the window inclusive at both ends. They are
 * written twice and §11's `detail_ties_to_balances` is what notices if they ever
 * stop matching.
 */
async function detailLines(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<PackageLedgerLine[]> {
  const rows = await db
    .select({
      entryId: journalEntries.id,
      entryDate: journalEntries.entryDate,
      entryNumber: journalEntries.entryNumber,
      source: journalEntries.source,
      memo: journalEntries.memo,
      accountNumber: chartAccounts.number,
      accountName: chartAccounts.name,
      lineMemo: journalLines.memo,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        gte(journalEntries.entryDate, range.startDate),
        lte(journalEntries.entryDate, range.endDate),
      ),
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id), asc(chartAccounts.number))

  return rows
}

/** What the detail foots to, for §11's reconciliation. */
async function detailSums(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<{ totalDebitCents: number; totalCreditCents: number }> {
  const [row] = await db
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.debitCents}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.creditCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        gte(journalEntries.entryDate, range.startDate),
        lte(journalEntries.entryDate, range.endDate),
      ),
    )

  return {
    totalDebitCents: Number(row?.debit ?? 0),
    totalCreditCents: Number(row?.credit ?? 0),
  }
}

/**
 * Lines whose entry or account has gone (§11 "no orphan journal lines").
 *
 * Both foreign keys are declared, so in a sound database this is zero and stays
 * zero — which is Phase 121's objection, and the answer to it is that the two
 * joins above are what make this worth asking. `detailLines` uses inner joins,
 * so an orphan line is *silently absent from the detail file while its figures
 * remain in the balances*, and the two halves of the package stop tying with
 * nothing on screen to say why. This check names the cause; the reconciliation
 * check would only report the symptom.
 *
 * Asked across the whole company rather than the window, because an orphan has
 * no entry and therefore no date to be inside it.
 */
async function orphanLines(ctx: ActorContext): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(journalLines)
    .leftJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .leftJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        or(isNull(journalEntries.id), isNull(chartAccounts.id)),
      ),
    )

  return Number(row?.count ?? 0)
}

/** Drafted entries inside the window (§11, as a yellow). */
async function unpostedEntries(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'draft'),
        gte(journalEntries.entryDate, range.startDate),
        lte(journalEntries.entryDate, range.endDate),
      ),
    )

  return Number(row?.count ?? 0)
}

/**
 * Which §5 sections this package actually carries.
 *
 * Measured from the package rather than declared, so the manifest describes the
 * files that are there. A section whose producer returned an empty array is
 * still carried: the firm is being told the client has none of something, which
 * is information.
 */
export function sectionsIn(pkg: AccountantPackage): PackageSection[] {
  const absent = new Set(pkg.omitted.map((section) => section.key))
  return PACKAGE_SECTIONS.filter(
    (section) => section.source?.exported === true && !absent.has(section.key),
  )
}
