import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  chartAccounts,
  customers,
  invoices,
  journalEntries,
  journalLines,
  vendors,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { AccountType } from '@/modules/coa/standard'
import { accountBalances, isDebitNormal, type AccountBalance } from './balances'

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
  range: { startDate: string; endDate: string },
): Promise<ProfitAndLoss> {
  requirePermission(ctx, 'reports:financial')

  const rows = await accountBalances(ctx, range)

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
    ...range,
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
  opts: { asOfDate: string; fiscalYearStart?: string },
): Promise<BalanceSheet> {
  requirePermission(ctx, 'reports:financial')

  // Cumulative from the beginning of the books through the date.
  const cumulative = await accountBalances(ctx, { endDate: opts.asOfDate })

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

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus'

export type AgingRow = {
  partyId: string
  partyName: string
  current: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90_plus: number
  totalCents: number
}

export type AgingReport = {
  asOfDate: string
  rows: AgingRow[]
  totals: Omit<AgingRow, 'partyId' | 'partyName'>
}

/** Which bucket an unpaid document falls into, by days past due. */
export function agingBucket(dueDate: string, asOfDate: string): AgingBucket {
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`)
  const daysPastDue = Math.floor((asOf - due) / 86_400_000)

  if (daysPastDue <= 0) return 'current'
  if (daysPastDue <= 30) return 'd1_30'
  if (daysPastDue <= 60) return 'd31_60'
  if (daysPastDue <= 90) return 'd61_90'
  return 'd90_plus'
}

function emptyBuckets() {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, totalCents: 0 }
}

/**
 * Accounts receivable aging (spec §13).
 *
 * Reads outstanding balances from the invoices themselves rather than the AR
 * control account, because aging needs per-customer, per-due-date detail that
 * a single ledger account does not carry.
 */
export async function arAging(
  ctx: ActorContext,
  opts: { asOfDate: string },
): Promise<AgingReport> {
  requirePermission(ctx, 'reports:view')

  const rows = await db
    .select({
      partyId: customers.id,
      partyName: customers.name,
      dueDate: invoices.dueDate,
      balanceCents: invoices.balanceCents,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      scoped(
        ctx,
        invoices,
        // Drafts are not yet obligations; voided and paid ones are settled.
        sql`${invoices.status} IN ('open', 'partial')`,
        lte(invoices.issueDate, opts.asOfDate),
      ),
    )

  return buildAging(rows, opts.asOfDate)
}

/** Accounts payable aging (spec §13). Mirror of AR, over bills and vendors. */
export async function apAging(
  ctx: ActorContext,
  opts: { asOfDate: string },
): Promise<AgingReport> {
  requirePermission(ctx, 'reports:view')

  const rows = await db
    .select({
      partyId: vendors.id,
      partyName: vendors.name,
      dueDate: bills.dueDate,
      balanceCents: bills.balanceCents,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(
      scoped(
        ctx,
        bills,
        sql`${bills.status} IN ('open', 'partial')`,
        lte(bills.issueDate, opts.asOfDate),
      ),
    )

  return buildAging(rows, opts.asOfDate)
}

function buildAging(
  documents: Array<{ partyId: string; partyName: string; dueDate: string; balanceCents: number }>,
  asOfDate: string,
): AgingReport {
  const byParty = new Map<string, AgingRow>()
  const totals = emptyBuckets()

  for (const document of documents) {
    if (document.balanceCents === 0) continue

    let row = byParty.get(document.partyId)
    if (!row) {
      row = { partyId: document.partyId, partyName: document.partyName, ...emptyBuckets() }
      byParty.set(document.partyId, row)
    }

    const bucket = agingBucket(document.dueDate, asOfDate)
    row[bucket] += document.balanceCents
    row.totalCents += document.balanceCents
    totals[bucket] += document.balanceCents
    totals.totalCents += document.balanceCents
  }

  return {
    asOfDate,
    rows: [...byParty.values()].sort((a, b) => a.partyName.localeCompare(b.partyName)),
    totals,
  }
}
