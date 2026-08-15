import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, journalEntries, journalLines } from '@/db/schema'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import type { AccountType } from '@/modules/coa/standard'

/**
 * Account balances and the trial balance (spec §13).
 *
 * Every figure here comes from summing `journal_lines`. There is no cached
 * balance column anywhere: a stored balance that drifts from the entries that
 * produced it is the classic way an accounting system quietly starts lying.
 */

/**
 * Which side increases each account type.
 *
 * Assets and expenses grow with debits; liabilities, equity, and revenue grow
 * with credits. This is what turns a raw debit/credit total into the signed
 * figure a statement shows.
 */
const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>([
  'asset',
  'cogs',
  'expense',
  'other_expense',
])

export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL.has(type)
}

/**
 * The balance in the direction the account naturally carries.
 *
 * A checking account with more debits than credits returns positive; so does a
 * liability with more credits than debits. A negative result therefore always
 * means "this account is carrying the opposite of what it should", which is a
 * signal worth seeing rather than an artifact of sign convention.
 */
export function normalBalance(
  type: AccountType,
  debitCents: number,
  creditCents: number,
): number {
  return isDebitNormal(type) ? debitCents - creditCents : creditCents - debitCents
}

export type AccountBalance = {
  chartAccountId: string
  number: string
  name: string
  type: AccountType
  /**
   * Carried since Phase 12 because the cash flow statement and cash-basis
   * reporting both classify by it, and a report that has the balances but not
   * the subtype has to go back to the database for something it just read.
   */
  subtype: string | null
  debitCents: number
  creditCents: number
  /** Signed in the account's normal direction. */
  balanceCents: number
}

export type BalanceOptions = {
  /** Inclusive. Omit for balances from the beginning of the books. */
  startDate?: string
  /** Inclusive. Omit for balances through today. */
  endDate?: string
  /** Include accounts with no activity and a zero balance. */
  includeZero?: boolean
}

/**
 * Sums posted journal lines per account.
 *
 * Void and draft entries are excluded — only `status = 'posted'` affects the
 * books.
 */
export async function accountBalances(
  ctx: ActorContext,
  options: BalanceOptions = {},
): Promise<AccountBalance[]> {
  requirePermission(ctx, 'reports:view')

  const conditions: (SQL | undefined)[] = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    options.startDate ? gte(journalEntries.entryDate, options.startDate) : undefined,
    options.endDate ? lte(journalEntries.entryDate, options.endDate) : undefined,
  ]

  // Two straightforward queries merged in code, rather than one left join with
  // the date filter smuggled into its ON clause. The chart of accounts is at
  // most a few hundred rows, so the second round trip costs nothing and the
  // intent stays legible.
  const [accounts, sums] = await Promise.all([
    db
      .select({
        id: chartAccounts.id,
        number: chartAccounts.number,
        name: chartAccounts.name,
        type: chartAccounts.type,
        subtype: chartAccounts.subtype,
      })
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, ctx.companyId))
      .orderBy(asc(chartAccounts.number)),

    db
      .select({
        chartAccountId: journalLines.chartAccountId,
        debitCents: sql<string>`sum(${journalLines.debitCents})`,
        creditCents: sql<string>`sum(${journalLines.creditCents})`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(and(...(conditions.filter(Boolean) as SQL[])))
      .groupBy(journalLines.chartAccountId),
  ])

  const byAccount = new Map(sums.map((row) => [row.chartAccountId, row]))

  return accounts
    .map((account) => {
      const sum = byAccount.get(account.id)
      const debitCents = Number(sum?.debitCents ?? 0)
      const creditCents = Number(sum?.creditCents ?? 0)
      const type = account.type as AccountType

      return {
        chartAccountId: account.id,
        number: account.number,
        name: account.name,
        type,
        subtype: account.subtype,
        debitCents,
        creditCents,
        balanceCents: normalBalance(type, debitCents, creditCents),
      }
    })
    .filter((row) => options.includeZero || row.debitCents !== 0 || row.creditCents !== 0)
}

export type TrialBalance = {
  rows: AccountBalance[]
  totalDebitCents: number
  totalCreditCents: number
  /** True when the two columns agree, as they must in a sound ledger. */
  isBalanced: boolean
  startDate?: string
  endDate?: string
}

/**
 * The trial balance (spec §13, §20).
 *
 * `isBalanced` is the ledger's health check: because every entry is validated
 * as balanced on the way in, the totals can only disagree if something wrote
 * around the journal service. Surfacing it makes that visible instead of
 * letting it hide inside a statement.
 */
export async function trialBalance(
  ctx: ActorContext,
  options: BalanceOptions = {},
): Promise<TrialBalance> {
  const rows = await accountBalances(ctx, options)

  const totalDebitCents = rows.reduce((sum, row) => sum + row.debitCents, 0)
  const totalCreditCents = rows.reduce((sum, row) => sum + row.creditCents, 0)

  return {
    rows,
    totalDebitCents,
    totalCreditCents,
    isBalanced: totalDebitCents === totalCreditCents,
    startDate: options.startDate,
    endDate: options.endDate,
  }
}

/** Balance of one account, for registers and reconciliation. */
export async function balanceForAccount(
  ctx: ActorContext,
  chartAccountId: string,
  options: BalanceOptions = {},
): Promise<number> {
  const balances = await accountBalances(ctx, { ...options, includeZero: true })
  return balances.find((row) => row.chartAccountId === chartAccountId)?.balanceCents ?? 0
}
