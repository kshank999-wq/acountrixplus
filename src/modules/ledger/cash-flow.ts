import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { cashFlowClass, type CashFlowClass } from '@/modules/coa/classification'
import { accountBalances, type AccountBalance } from './balances'

/**
 * Statement of Cash Flows, indirect method (spec §13).
 *
 * ## What the indirect method actually is
 *
 * It reads like a list of adjustments to net income, and it is usually taught
 * that way — add back depreciation, subtract the increase in receivables, and
 * so on, each with its own justification. That framing makes it look like a
 * pile of conventions, and it is the reason the statement has a reputation for
 * being the hard one.
 *
 * It falls out of one fact instead. Over any period, every account has a net
 * movement, and because every entry balances, those movements sum to zero:
 *
 * ```
 *   Σ movement(all accounts) = 0
 * ```
 *
 * Split the accounts into cash and not-cash and rearrange:
 *
 * ```
 *   Σ movement(cash) = − Σ movement(everything else)
 * ```
 *
 * That is the whole statement. The change in cash *is* the negated movement of
 * every other account, and the sections are nothing more than a grouping of
 * those accounts into three buckets. "Add back depreciation" is not a rule to
 * remember: Accumulated Depreciation moved by a credit, so its negated
 * movement is a positive number, and it lands in operating because that is
 * where the account is classified.
 *
 * Written this way the statement cannot silently disagree with the balance
 * sheet, because it is derived from the same movements. `reconciles` asserts
 * it anyway — see below.
 *
 * ## Why there is no basis switch here
 *
 * The indirect method exists to explain the gap between accrual profit and
 * cash. On a cash basis there is no gap worth a statement: net income already
 * *is* the cash movement, so every adjustment line would be zero and the
 * report would be a P&L with extra ceremony. Offering the switch would imply a
 * choice that does not exist, which is the same argument that keeps a basis
 * off the trial balance.
 */

export type CashFlowLine = {
  chartAccountId: string
  number: string
  name: string
  /**
   * The cash effect, signed so positive always means "cash came in".
   *
   * This is the negated ledger movement, which is why an increase in
   * receivables shows as a negative: the sale was in net income, the money was
   * not.
   */
  cashEffectCents: number
}

export type CashFlowSection = {
  title: string
  lines: CashFlowLine[]
  /** Section subtotal, including net income for the operating section. */
  totalCents: number
}

export type CashFlowStatement = {
  startDate: string
  endDate: string
  /** Accrual net income for the window. The operating section starts here. */
  netIncomeCents: number
  operating: CashFlowSection
  investing: CashFlowSection
  financing: CashFlowSection
  /** Operating + investing + financing. */
  netChangeInCashCents: number
  openingCashCents: number
  closingCashCents: number
  /** The cash accounts and what each of them actually moved by. */
  cashAccounts: CashFlowLine[]
  /**
   * True when the three sections sum to the movement the cash accounts
   * actually recorded.
   *
   * The derivation guarantees it, so this can only be false if something wrote
   * to the ledger around the journal service. That is worth surfacing rather
   * than assuming away — the same reason `trialBalance` reports `isBalanced`
   * even though every entry is validated on the way in.
   */
  reconciles: boolean
}

/** Ledger movement in debit-positive terms. */
function signedMovement(row: AccountBalance): number {
  return row.debitCents - row.creditCents
}

function toLine(row: AccountBalance): CashFlowLine {
  const cashEffectCents = -signedMovement(row)

  return {
    chartAccountId: row.chartAccountId,
    number: row.number,
    name: row.name,
    // Negated: a debit to an asset consumes cash, a credit to a liability
    // provides it, and both come out with the right sign this way.
    //
    // `|| 0` collapses negative zero, which is what -0 formats as: an account
    // that moved and came back — an accrual raised and settled in the same
    // window — nets to nothing and would otherwise print as "-$0.00".
    cashEffectCents: cashEffectCents || 0,
  }
}

/**
 * Drops accounts that moved and netted to nothing.
 *
 * They have activity, so `accountBalances` returns them, but a cash flow line
 * of zero says nothing: no cash came in and none went out. Listing them buries
 * the lines that matter under the ones that do not.
 */
function withEffect(lines: CashFlowLine[]): CashFlowLine[] {
  return lines.filter((line) => line.cashEffectCents !== 0)
}

function section(title: string, lines: CashFlowLine[], openingCents = 0): CashFlowSection {
  return {
    title,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.cashEffectCents, openingCents),
  }
}

export async function cashFlowStatement(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
): Promise<CashFlowStatement> {
  requirePermission(ctx, 'reports:financial')

  const [movements, openingRows] = await Promise.all([
    accountBalances(ctx, range),
    // Everything before the window, so the statement can state where cash
    // started rather than only how much it moved.
    accountBalances(ctx, { endDate: previousDay(range.startDate) }),
  ])

  const byClass = new Map<CashFlowClass, AccountBalance[]>()
  for (const row of movements) {
    const cls = cashFlowClass(row.type, row.subtype)
    const bucket = byClass.get(cls) ?? []
    bucket.push(row)
    byClass.set(cls, bucket)
  }

  const income = byClass.get('income') ?? []
  // Expenses are debits and revenue credits, so the income accounts' signed
  // movement is the negative of profit.
  const netIncomeCents = -income.reduce((sum, row) => sum + signedMovement(row), 0)

  const cashRows = byClass.get('cash') ?? []
  const actualCashMovementCents = cashRows.reduce((sum, row) => sum + signedMovement(row), 0)

  const operating = section(
    'Operating activities',
    withEffect((byClass.get('operating') ?? []).map(toLine)),
    netIncomeCents,
  )
  const investing = section(
    'Investing activities',
    withEffect((byClass.get('investing') ?? []).map(toLine)),
  )
  const financing = section(
    'Financing activities',
    withEffect((byClass.get('financing') ?? []).map(toLine)),
  )

  const netChangeInCashCents = operating.totalCents + investing.totalCents + financing.totalCents

  const openingCashCents = openingRows
    .filter((row) => cashFlowClass(row.type, row.subtype) === 'cash')
    .reduce((sum, row) => sum + signedMovement(row), 0)

  return {
    startDate: range.startDate,
    endDate: range.endDate,
    netIncomeCents,
    operating,
    investing,
    financing,
    netChangeInCashCents,
    openingCashCents,
    closingCashCents: openingCashCents + actualCashMovementCents,
    cashAccounts: cashRows.map((row) => ({
      chartAccountId: row.chartAccountId,
      number: row.number,
      name: row.name,
      // Not negated: for a cash account the movement *is* the cash.
      cashEffectCents: signedMovement(row),
    })),
    reconciles: netChangeInCashCents === actualCashMovementCents,
  }
}

/** The day before an ISO date, for the opening-balance cutoff. */
function previousDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}
