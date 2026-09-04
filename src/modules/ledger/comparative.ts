import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import type { AccountType } from '@/modules/coa/standard'
import { balanceSheet, profitAndLoss, type StatementSection } from './reports'
import type { ReportingBasis } from './cash-basis'
import { Refusal } from '@/modules/errors'

/**
 * Comparative periods (spec §13: "...transaction detail, and comparative
 * periods").
 *
 * ## The one decision worth recording
 *
 * A comparative statement is not a report — it is a *pairing* of reports.
 * Building it as a report would have meant a second query path returning
 * multiple columns per account, and the moment either path was fixed the two
 * would disagree about something. So the columns here are the existing
 * `profitAndLoss` and `balanceSheet` run once per window, and this module's
 * only job is the alignment: putting the same account on the same row when one
 * period has activity on it and the other does not.
 *
 * That alignment is the part that is easy to get wrong and invisible when it
 * is. An account that existed only in the prior year has to appear with a zero
 * in the current column rather than vanish, because "we stopped spending on
 * this" is exactly what somebody reads a comparative statement to find out.
 *
 * The cost is one query set per column, so a five-year comparison is five
 * times the work of one year. Nothing here caches, and with a small number of
 * columns that is the right trade: the figures are always current, and a
 * comparative statement built from a stale column is worse than a slow one.
 */

/** A window a comparative column covers. */
export type PeriodWindow = {
  label: string
  startDate: string
  endDate: string
}

export type ComparativeRow = {
  chartAccountId: string
  number: string
  name: string
  type: AccountType
  /** One entry per column, in the same order the windows were given. */
  amountsCents: number[]
  /**
   * First column minus the last, which is how a comparative is read: the
   * current period against the one being compared to.
   */
  varianceCents: number
  /**
   * Variance as a share of the comparison figure, in basis points, or null
   * when the comparison figure is zero.
   *
   * Null rather than zero or Infinity: going from nothing to something has no
   * meaningful percentage, and printing one invites somebody to act on it.
   */
  varianceBasisPoints: number | null
}

export type ComparativeSection = {
  title: string
  rows: ComparativeRow[]
  totalsCents: number[]
  varianceCents: number
  varianceBasisPoints: number | null
}

export type ComparativeProfitAndLoss = {
  basis: ReportingBasis
  periods: PeriodWindow[]
  revenue: ComparativeSection
  costOfSales: ComparativeSection
  grossProfitCents: number[]
  operatingExpenses: ComparativeSection
  operatingIncomeCents: number[]
  otherIncome: ComparativeSection
  otherExpenses: ComparativeSection
  netIncomeCents: number[]
}

/** Variance in basis points, or null when there is nothing to compare against. */
export function varianceBasisPoints(currentCents: number, priorCents: number): number | null {
  if (priorCents === 0) return null
  return Math.round(((currentCents - priorCents) * 10_000) / Math.abs(priorCents))
}

/**
 * Aligns the same section across columns.
 *
 * Row order follows account number, so the statement reads in chart order
 * regardless of which column an account happened to first appear in.
 */
function alignSections(title: string, columns: StatementSection[]): ComparativeSection {
  const rows = new Map<string, ComparativeRow>()

  columns.forEach((column, index) => {
    for (const row of column.rows) {
      let existing = rows.get(row.chartAccountId)
      if (!existing) {
        existing = {
          chartAccountId: row.chartAccountId,
          number: row.number,
          name: row.name,
          type: row.type,
          amountsCents: new Array(columns.length).fill(0),
          varianceCents: 0,
          varianceBasisPoints: null,
        }
        rows.set(row.chartAccountId, existing)
      }
      existing.amountsCents[index] = row.balanceCents
    }
  })

  const ordered = [...rows.values()].sort((a, b) => a.number.localeCompare(b.number))
  const last = columns.length - 1

  for (const row of ordered) {
    row.varianceCents = row.amountsCents[0] - row.amountsCents[last]
    row.varianceBasisPoints = varianceBasisPoints(row.amountsCents[0], row.amountsCents[last])
  }

  const totalsCents = columns.map((column) => column.totalCents)

  return {
    title,
    rows: ordered,
    totalsCents,
    varianceCents: totalsCents[0] - totalsCents[last],
    varianceBasisPoints: varianceBasisPoints(totalsCents[0], totalsCents[last]),
  }
}

export async function comparativeProfitAndLoss(
  ctx: ActorContext,
  opts: { periods: PeriodWindow[]; basis?: ReportingBasis },
): Promise<ComparativeProfitAndLoss> {
  requirePermission(ctx, 'reports:financial')

  if (opts.periods.length < 2) {
    throw new Refusal('A comparative statement needs at least two periods.')
  }

  const basis = opts.basis ?? 'accrual'

  // Sequential rather than concurrent on purpose. Cash basis reads the whole
  // ledger per column (ADR 0011), and firing five of those at one connection
  // pool to save wall-clock on a report nobody watches load is a poor trade.
  const columns = []
  for (const period of opts.periods) {
    columns.push(
      await profitAndLoss(ctx, {
        startDate: period.startDate,
        endDate: period.endDate,
        basis,
      }),
    )
  }

  return {
    basis,
    periods: opts.periods,
    revenue: alignSections('Revenue', columns.map((c) => c.revenue)),
    costOfSales: alignSections('Cost of sales', columns.map((c) => c.costOfSales)),
    grossProfitCents: columns.map((c) => c.grossProfitCents),
    operatingExpenses: alignSections('Operating expenses', columns.map((c) => c.operatingExpenses)),
    operatingIncomeCents: columns.map((c) => c.operatingIncomeCents),
    otherIncome: alignSections('Other income', columns.map((c) => c.otherIncome)),
    otherExpenses: alignSections('Other expense', columns.map((c) => c.otherExpenses)),
    netIncomeCents: columns.map((c) => c.netIncomeCents),
  }
}

export type ComparativeBalanceSheet = {
  basis: ReportingBasis
  /** Balance-sheet columns are dates, not ranges. */
  asOfDates: string[]
  labels: string[]
  assets: ComparativeSection
  liabilities: ComparativeSection
  equity: ComparativeSection
  netIncomeCents: number[]
  totalAssetsCents: number[]
  totalLiabilitiesAndEquityCents: number[]
  /** One per column. A comparative that balances in only one column is broken. */
  isBalanced: boolean[]
}

export async function comparativeBalanceSheet(
  ctx: ActorContext,
  opts: { columns: Array<{ label: string; asOfDate: string }>; basis?: ReportingBasis },
): Promise<ComparativeBalanceSheet> {
  requirePermission(ctx, 'reports:financial')

  if (opts.columns.length < 2) {
    throw new Refusal('A comparative statement needs at least two dates.')
  }

  const basis = opts.basis ?? 'accrual'

  const sheets = []
  for (const column of opts.columns) {
    sheets.push(await balanceSheet(ctx, { asOfDate: column.asOfDate, basis }))
  }

  return {
    basis,
    asOfDates: opts.columns.map((c) => c.asOfDate),
    labels: opts.columns.map((c) => c.label),
    assets: alignSections('Assets', sheets.map((s) => s.assets)),
    liabilities: alignSections('Liabilities', sheets.map((s) => s.liabilities)),
    equity: alignSections('Equity', sheets.map((s) => s.equity)),
    netIncomeCents: sheets.map((s) => s.netIncomeCents),
    totalAssetsCents: sheets.map((s) => s.totalAssetsCents),
    totalLiabilitiesAndEquityCents: sheets.map((s) => s.totalLiabilitiesAndEquityCents),
    isBalanced: sheets.map((s) => s.isBalanced),
  }
}

/**
 * The windows a comparative statement is normally run over.
 *
 * These are pure date arithmetic, kept here and exported so the UI offers the
 * same three comparisons an accountant would ask for by name rather than
 * making somebody type four dates.
 */
export type ComparisonKind = 'prior_period' | 'prior_year' | 'year_to_date_prior_year'

export const COMPARISON_LABELS: Record<ComparisonKind, string> = {
  prior_period: 'Prior period',
  prior_year: 'Same period last year',
  year_to_date_prior_year: 'Year to date vs last year',
}

/**
 * Builds the two windows for a comparison.
 *
 * `prior_period` shifts back a whole calendar period when the window is one —
 * Q2 compares to Q1, March to February — and by the window's own day count
 * when it is not.
 *
 * The day-count rule alone looked simpler and was wrong in a way that only
 * shows up on unequal periods: Q2 is 91 days, so shifting Q2 back by its own
 * length lands on 31 December, and the comparison column straddles a year end.
 * Nobody asking to compare against "the prior period" means that. Where the
 * window is not a calendar period there is nothing to name, so the day count
 * is the honest fallback.
 */
export function comparisonWindows(
  current: { startDate: string; endDate: string },
  kind: ComparisonKind,
): PeriodWindow[] {
  const currentWindow: PeriodWindow = {
    label: `${current.startDate} to ${current.endDate}`,
    startDate: current.startDate,
    endDate: current.endDate,
  }

  if (kind === 'prior_period') {
    const calendar = priorCalendarPeriod(current)
    if (calendar) return [currentWindow, calendar]

    const days = dayCount(current.startDate, current.endDate)
    const priorEnd = addDays(current.startDate, -1)
    const priorStart = addDays(priorEnd, -(days - 1))
    return [currentWindow, { label: `${priorStart} to ${priorEnd}`, startDate: priorStart, endDate: priorEnd }]
  }

  const priorStart = shiftYear(current.startDate, -1)
  const priorEnd = shiftYear(current.endDate, -1)

  if (kind === 'prior_year') {
    return [currentWindow, { label: `${priorStart} to ${priorEnd}`, startDate: priorStart, endDate: priorEnd }]
  }

  // Year to date against the same span of the prior year: same end date, both
  // running from the start of their own year.
  const currentYearStart = `${current.endDate.slice(0, 4)}-01-01`
  const priorYearStart = `${Number(current.endDate.slice(0, 4)) - 1}-01-01`

  return [
    { label: `${currentYearStart} to ${current.endDate}`, startDate: currentYearStart, endDate: current.endDate },
    { label: `${priorYearStart} to ${priorEnd}`, startDate: priorYearStart, endDate: priorEnd },
  ]
}

/**
 * The calendar period before this one, when the window is a whole month,
 * quarter, or year. Null when it is not, which is the signal to fall back to
 * shifting by day count.
 */
function priorCalendarPeriod(current: {
  startDate: string
  endDate: string
}): PeriodWindow | null {
  const [startYear, startMonth, startDay] = current.startDate.split('-').map(Number)
  const [endYear, endMonth, endDay] = current.endDate.split('-').map(Number)

  if (startDay !== 1) return null
  if (endDay !== lastDayOfMonth(endYear, endMonth)) return null

  const months = (endYear - startYear) * 12 + (endMonth - startMonth) + 1
  // A month, a quarter, a half, or a year. Anything else (five months, say)
  // has no name and no obvious predecessor.
  if (![1, 3, 6, 12].includes(months)) return null
  // A quarter has to start where a quarter starts, or "the prior quarter" is
  // a phrase for something that is not a quarter.
  if (months > 1 && (startMonth - 1) % months !== 0) return null

  const priorStartIndex = startYear * 12 + (startMonth - 1) - months
  const priorStartYear = Math.floor(priorStartIndex / 12)
  const priorStartMonth = (priorStartIndex % 12) + 1

  const priorEndIndex = priorStartIndex + months - 1
  const priorEndYear = Math.floor(priorEndIndex / 12)
  const priorEndMonth = (priorEndIndex % 12) + 1

  const startDate = `${pad4(priorStartYear)}-${pad2(priorStartMonth)}-01`
  const endDate = `${pad4(priorEndYear)}-${pad2(priorEndMonth)}-${pad2(
    lastDayOfMonth(priorEndYear, priorEndMonth),
  )}`

  return { label: `${startDate} to ${endDate}`, startDate, endDate }
}

/** Day 0 of the next month is the last day of this one. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

function dayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  return Math.floor((end - start) / 86_400_000) + 1
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * The same calendar date a year earlier, clamped for 29 February.
 *
 * `setUTCFullYear` would turn 2024-02-29 into 2023-03-01, quietly moving a
 * comparison window into the wrong month once every four years.
 */
function shiftYear(isoDate: string, years: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const targetYear = year + years
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate()
  const clamped = Math.min(day, lastDay)
  return `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`
}
