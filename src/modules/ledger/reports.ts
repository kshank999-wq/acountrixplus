import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  chartAccounts,
  creditNotes,
  customers,
  invoices,
  journalEntries,
  journalLines,
  vendors,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { AccountType } from '@/modules/coa/standard'
import { accountBalances, isDebitNormal, type AccountBalance } from './balances'
import { balancesForBasis, type ReportingBasis } from './cash-basis'
import { buildAging, type AgingReport, type UnappliedCredits } from './aging'
import { openCreditsAsAt, openDocumentsAsAt } from './settlement-history'
import { functionalCurrency } from '@/modules/fx/service'

/**
 * Financial statements (spec §13, §20).
 *
 * Every report derives from posted journal lines. Nothing here reads a cached
 * total, and nothing recomputes money in floating point.
 */

export type StatementSection = {
  title: string
  rows: AccountBalance[]
  totalCents: number
}

export type ProfitAndLoss = {
  /** Which basis produced these figures. Always shown, never assumed. */
  basis: ReportingBasis
  startDate: string
  endDate: string
  revenue: StatementSection
  costOfSales: StatementSection
  grossProfitCents: number
  operatingExpenses: StatementSection
  operatingIncomeCents: number
  otherIncome: StatementSection
  otherExpenses: StatementSection
  netIncomeCents: number
}

function section(title: string, rows: AccountBalance[]): StatementSection {
  return {
    title,
    rows,
    totalCents: rows.reduce((sum, row) => sum + row.balanceCents, 0),
  }
}

function ofTypes(rows: AccountBalance[], types: AccountType[]): AccountBalance[] {
  const wanted = new Set(types)
  return rows.filter((row) => wanted.has(row.type))
}

/**
 * Profit & Loss for a date range.
 *
 * Revenue and expense accounts are period accounts: the range is what gives
 * them meaning, unlike balance-sheet accounts which are cumulative.
 */
export async function profitAndLoss(
  ctx: ActorContext,
  range: { startDate: string; endDate: string; basis?: ReportingBasis },
): Promise<ProfitAndLoss> {
  requirePermission(ctx, 'reports:financial')

  // One seam for both bases (Phase 11). Defaulting to accrual keeps every
  // existing caller — and every existing test — meaning what it used to.
  const basis = range.basis ?? 'accrual'
  const rows = await balancesForBasis(ctx, basis, range)

  const revenue = section('Revenue', ofTypes(rows, ['revenue']))
  const costOfSales = section('Cost of sales', ofTypes(rows, ['cogs']))
  const operatingExpenses = section('Operating expenses', ofTypes(rows, ['expense']))
  const otherIncome = section('Other income', ofTypes(rows, ['other_income']))
  const otherExpenses = section('Other expense', ofTypes(rows, ['other_expense']))

  const grossProfitCents = revenue.totalCents - costOfSales.totalCents
  const operatingIncomeCents = grossProfitCents - operatingExpenses.totalCents
  const netIncomeCents =
    operatingIncomeCents + otherIncome.totalCents - otherExpenses.totalCents

  return {
    startDate: range.startDate,
    endDate: range.endDate,
    basis,
    revenue,
    costOfSales,
    grossProfitCents,
    operatingExpenses,
    operatingIncomeCents,
    otherIncome,
    otherExpenses,
    netIncomeCents,
  }
}

export type BalanceSheet = {
  asOfDate: string
  basis: ReportingBasis
  assets: StatementSection
  liabilities: StatementSection
  equity: StatementSection
  /** Earnings for the current period, not yet rolled into retained earnings. */
  netIncomeCents: number
  totalAssetsCents: number
  totalLiabilitiesAndEquityCents: number
  /** True when assets equal liabilities plus equity, as they must. */
  isBalanced: boolean
}

/**
 * Balance Sheet as of a date.
 *
 * Net income for the year is shown as a separate equity line rather than being
 * folded into Retained Earnings. Closing entries are what move it, and they
 * have not been written yet at the time this report is run — so presenting it
 * separately is both correct and what an accountant expects to see.
 */
export async function balanceSheet(
  ctx: ActorContext,
  opts: { asOfDate: string; fiscalYearStart?: string; basis?: ReportingBasis },
): Promise<BalanceSheet> {
  requirePermission(ctx, 'reports:financial')

  const basis = opts.basis ?? 'accrual'

  // Cumulative from the beginning of the books through the date. On a cash
  // basis this is where Accounts Receivable and Payable disappear — they are
  // the accounts cash basis claims do not exist, and the transformation
  // removes them rather than leaving an unpaid balance on the statement.
  const cumulative = await balancesForBasis(ctx, basis, { endDate: opts.asOfDate })

  const assets = section('Assets', ofTypes(cumulative, ['asset']))
  const liabilities = section('Liabilities', ofTypes(cumulative, ['liability']))
  const equityAccounts = ofTypes(cumulative, ['equity'])

  // Income and expense accumulated over the same window make up current
  // earnings, which belong to equity until they are closed out.
  const income = ofTypes(cumulative, ['revenue', 'other_income'])
  const expenses = ofTypes(cumulative, ['cogs', 'expense', 'other_expense'])
  const netIncomeCents =
    income.reduce((sum, row) => sum + row.balanceCents, 0) -
    expenses.reduce((sum, row) => sum + row.balanceCents, 0)

  const equity = section('Equity', equityAccounts)

  const totalAssetsCents = assets.totalCents
  const totalLiabilitiesAndEquityCents =
    liabilities.totalCents + equity.totalCents + netIncomeCents

  return {
    asOfDate: opts.asOfDate,
    basis,
    assets,
    liabilities,
    equity,
    netIncomeCents,
    totalAssetsCents,
    totalLiabilitiesAndEquityCents,
    isBalanced: totalAssetsCents === totalLiabilitiesAndEquityCents,
  }
}

export type LedgerLine = {
  entryId: string
  entryNumber: number
  entryDate: string
  memo: string | null
  source: string
  lineMemo: string | null
  debitCents: number
  creditCents: number
  /** Balance after this line, in the account's normal direction. */
  runningBalanceCents: number
}

/**
 * General ledger for one account, with a running balance (spec §13).
 *
 * The opening balance is everything before `startDate`, so a mid-year range
 * still reads as a continuous account history rather than starting from zero.
 */
export async function generalLedger(
  ctx: ActorContext,
  chartAccountId: string,
  range: { startDate?: string; endDate?: string } = {},
): Promise<{
  account: { id: string; number: string; name: string; type: AccountType }
  openingBalanceCents: number
  lines: LedgerLine[]
  closingBalanceCents: number
}> {
  requirePermission(ctx, 'reports:view')

  const [account] = await db
    .select()
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, chartAccountId)))
    .limit(1)

  if (!account) throw new Error('Chart account not found')

  const type = account.type as AccountType
  const sign = isDebitNormal(type) ? 1 : -1

  let openingBalanceCents = 0
  if (range.startDate) {
    const prior = await accountBalances(ctx, {
      endDate: previousDay(range.startDate),
      includeZero: true,
    })
    openingBalanceCents = prior.find((row) => row.chartAccountId === chartAccountId)?.balanceCents ?? 0
  }

  const conditions: (SQL | undefined)[] = [
    eq(journalLines.companyId, ctx.companyId),
    eq(journalLines.chartAccountId, chartAccountId),
    eq(journalEntries.status, 'posted'),
    range.startDate ? gte(journalEntries.entryDate, range.startDate) : undefined,
    range.endDate ? lte(journalEntries.entryDate, range.endDate) : undefined,
  ]

  const rows = await db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      memo: journalEntries.memo,
      source: journalEntries.source,
      lineMemo: journalLines.memo,
      debitCents: journalLines.debitCents,
      creditCents: journalLines.creditCents,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(and(...(conditions.filter(Boolean) as SQL[])))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNumber))

  let running = openingBalanceCents
  const lines: LedgerLine[] = rows.map((row) => {
    running += sign * (row.debitCents - row.creditCents)
    return { ...row, runningBalanceCents: running }
  })

  return {
    account: { id: account.id, number: account.number, name: account.name, type },
    openingBalanceCents,
    lines,
    closingBalanceCents: running,
  }
}

/** The day before an ISO date, for opening-balance cutoffs. */
function previousDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/**
 * Aging: what is owed, by age (spec §13, §35).
 *
 * The decisions — which figure ages, which bucket, what a foreign row says it
 * was invoiced, and where unapplied credits sit relative to the total — live in
 * `./aging`, which has no database and no clock. These two functions fetch.
 *
 * Re-exported here because `statements.ts` and the reports page have imported
 * `agingBucket` and `AgingReport` from this module since Phase 13; there is one
 * definition, in `./aging`.
 */
export {
  agingBucket,
  BUCKETS,
  foreignNote,
  creditNote,
  type AgingBucket,
  type AgingRow,
  type AgingReport,
} from './aging'

/**
 * Accounts receivable aging (spec §13).
 *
 * Reads the documents rather than the AR control account, because aging needs
 * per-customer, per-due-date detail a single ledger account does not carry —
 * and reads them **as at the date asked about** (Phase 108), which is what
 * `openDocumentsAsAt` restores. The same function feeds the control-account
 * check, so the two reports cannot disagree about what was open then.
 */
export async function arAging(
  ctx: ActorContext,
  opts: { asOfDate: string },
): Promise<AgingReport> {
  requirePermission(ctx, 'reports:view')

  const [documents, currency, credits] = await Promise.all([
    openDocumentsAsAt(ctx, 'invoice', opts.asOfDate),
    functionalCurrency(ctx.companyId),
    unappliedCredits(ctx, 'customer', opts.asOfDate),
  ])

  return buildAging(documents, { asOfDate: opts.asOfDate, currency, credits })
}

/** Accounts payable aging (spec §13). Mirror of AR, over bills and vendors. */
export async function apAging(
  ctx: ActorContext,
  opts: { asOfDate: string },
): Promise<AgingReport> {
  requirePermission(ctx, 'reports:view')

  const [documents, currency, credits] = await Promise.all([
    openDocumentsAsAt(ctx, 'bill', opts.asOfDate),
    functionalCurrency(ctx.companyId),
    unappliedCredits(ctx, 'vendor', opts.asOfDate),
  ])

  return buildAging(documents, { asOfDate: opts.asOfDate, currency, credits })
}

/**
 * Credits issued and not yet applied, as at the date (Phases 106, 108).
 *
 * A credit note reduces the control account when it is issued, so without this
 * the aging total and the balance sheet differ by an amount neither report
 * mentions. Restored to `asOf` by the same shared function the control-account
 * check uses, because a credit applied since was still unapplied then.
 */
async function unappliedCredits(
  ctx: ActorContext,
  party: 'customer' | 'vendor',
  asOf: string,
): Promise<UnappliedCredits> {
  const rows = await openCreditsAsAt(ctx, party, asOf)

  return {
    count: rows.reduce((sum, row) => sum + row.documents, 0),
    functionalCents: rows.reduce((sum, row) => sum + row.cents, 0),
  }
}
