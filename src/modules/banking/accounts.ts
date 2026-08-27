import { and, eq, ne, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  bankTransactions,
  chartAccounts,
  financialAccounts,
  journalLines,
  reconciliations,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'
import { bandFor, ledgerNameFor, nextAccountNumber, type FinancialAccountKind } from './numbering'

/**
 * Bank accounts somebody owns, rather than ones a vendor invented (spec §3, §5).
 *
 * ## What was missing
 *
 * `financial_accounts` rows were only ever written by `connectInstitution` —
 * that is, by an aggregator — and by the seed. A business that signed up and
 * banked somewhere the aggregator does not reach had **no way to make one at
 * all**, and without one there is no statement import, no reconciliation, no
 * deposit, no counter takings and no payroll remittance. Every one of those
 * features needs an account to point at.
 *
 * ## One account, one ledger account
 *
 * `connectInstitution` pointed every account that was not a credit card at
 * `1000 Checking Account`. A business with a current account and a deposit
 * account therefore had **one balance-sheet line covering both**, which cannot
 * answer the question a bank statement asks: *does the ledger agree with this
 * account?* The ledger could only ever answer for the two of them together.
 *
 * So the pairing is now exclusive, enforced by a unique index rather than by
 * remembering: `(company_id, chart_account_id)`. Creating an account mints its
 * own chart account by default, in the band its kind belongs to (see
 * `numbering.ts`), so nobody has to know what a chart account is to open one.
 */

export class FinancialAccountError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'FinancialAccountError'
  }
}

export type FinancialAccountSummary = {
  id: string
  name: string
  kind: FinancialAccountKind
  mask: string | null
  currency: string
  isActive: boolean
  /** Null when the account was made by hand and no aggregator knows it. */
  bankConnectionId: string | null
  chartAccountId: string
  chartAccountNumber: string
  chartAccountName: string
  /** What the bank last said, for a connected account. Zero for a manual one. */
  currentBalanceCents: number
  /** Rows in the feed, so an empty account can say so. */
  transactionCount: number
}

export async function listFinancialAccounts(
  ctx: ActorContext,
  opts: { activeOnly?: boolean } = {},
): Promise<FinancialAccountSummary[]> {
  requirePermission(ctx, 'bookkeeping:view')

  const rows = await db
    .select({
      id: financialAccounts.id,
      name: financialAccounts.name,
      kind: financialAccounts.kind,
      mask: financialAccounts.mask,
      currency: financialAccounts.currency,
      isActive: financialAccounts.isActive,
      bankConnectionId: financialAccounts.bankConnectionId,
      chartAccountId: financialAccounts.chartAccountId,
      chartAccountNumber: chartAccounts.number,
      chartAccountName: chartAccounts.name,
      currentBalanceCents: financialAccounts.currentBalanceCents,
      transactionCount: sql<string>`(
        select count(*) from ${bankTransactions}
        where ${bankTransactions.financialAccountId} = ${financialAccounts.id}
      )`,
    })
    .from(financialAccounts)
    .innerJoin(chartAccounts, eq(chartAccounts.id, financialAccounts.chartAccountId))
    .where(
      scoped(
        ctx,
        financialAccounts,
        opts.activeOnly ? eq(financialAccounts.isActive, true) : undefined,
      ),
    )
    .orderBy(chartAccounts.number)

  return rows.map((row) => ({
    ...row,
    kind: row.kind as FinancialAccountKind,
    transactionCount: Number(row.transactionCount),
  }))
}

export type CreateFinancialAccountInput = {
  name: string
  kind: FinancialAccountKind
  /** Last four digits. Never the full number — spec §19. */
  mask?: string | null
  currency?: string
  /**
   * An existing chart account to post to, when somebody has already made one.
   * Left out, a new one is minted in the right band.
   */
  chartAccountId?: string | null
}

/**
 * Opens an account by hand.
 *
 * The chart account is created in the same transaction, so a failure anywhere
 * leaves neither — a chart account with no bank account behind it is a line on
 * the balance sheet nobody can explain.
 */
export async function createFinancialAccount(
  ctx: ActorContext,
  input: CreateFinancialAccountInput,
): Promise<FinancialAccountSummary> {
  requirePermission(ctx, 'accounting:journal')

  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new FinancialAccountError('Give the account a name.')

  const mask = normalizeMask(input.mask)

  return db.transaction(async (tx) => {
    const chartAccountId = input.chartAccountId
      ? await claimExistingChartAccount(ctx, input.chartAccountId, tx)
      : await mintChartAccount(ctx, { name, mask, kind: input.kind }, tx)

    const [account] = await tx
      .insert(financialAccounts)
      .values({
        companyId: ctx.companyId,
        chartAccountId,
        name,
        mask,
        kind: input.kind,
        currency: (input.currency ?? 'USD').toUpperCase(),
        // No aggregator knows this account, and nothing has told us a balance.
        // Zero is honest; the feed is what will say what is in it.
        currentBalanceCents: 0,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'account.create',
        entityType: 'financial_account',
        entityId: account.id,
        after: { name, kind: input.kind, mask, chartAccountId },
      },
      tx,
    )

    const [chart] = await tx
      .select({ number: chartAccounts.number, name: chartAccounts.name })
      .from(chartAccounts)
      .where(eq(chartAccounts.id, chartAccountId))

    return {
      id: account.id,
      name: account.name,
      kind: account.kind as FinancialAccountKind,
      mask: account.mask,
      currency: account.currency,
      isActive: account.isActive,
      bankConnectionId: account.bankConnectionId,
      chartAccountId,
      chartAccountNumber: chart.number,
      chartAccountName: chart.name,
      currentBalanceCents: account.currentBalanceCents,
      transactionCount: 0,
    }
  })
}

/** Four digits at most, and only digits. A full account number is not evidence. */
function normalizeMask(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (!digits) return null
  return digits.slice(-4)
}

/**
 * Makes the chart account for a new bank account.
 *
 * Exported for `sync.ts`, which needs exactly this when an aggregator hands
 * over accounts nobody has made a ledger account for yet.
 */
export async function mintChartAccount(
  ctx: ActorContext,
  input: { name: string; mask: string | null; kind: FinancialAccountKind },
  tx: Executor,
): Promise<string> {
  const band = bandFor(input.kind)

  // A first account of its kind belongs on the number the standard chart
  // already names — 1000 Checking Account, 2100 Credit Card — rather than on a
  // new line beside an unused one. Deliberately only `band.from`: an account
  // somebody created themselves at 1015 is theirs, and renaming it out from
  // under them would be worse than an extra line.
  const placeholder = await unusedPlaceholder(ctx, String(band.from), tx)
  if (placeholder) {
    await tx
      .update(chartAccounts)
      .set({ name: ledgerNameFor({ name: input.name, mask: input.mask }) })
      .where(eq(chartAccounts.id, placeholder))
    return placeholder
  }

  // Every number in the chart, not just this band's: a number is unique per
  // company, so a collision anywhere is a collision.
  const taken = await tx
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(eq(chartAccounts.companyId, ctx.companyId))

  const number = nextAccountNumber(
    taken.map((row) => row.number),
    band,
  )

  if (!number) {
    throw new FinancialAccountError(
      `There is no room left in the ${band.from}–${band.to} range for another ${input.kind.replace('_', ' ')} account.`,
    )
  }

  const [created] = await tx
    .insert(chartAccounts)
    .values({
      companyId: ctx.companyId,
      number,
      name: ledgerNameFor({ name: input.name, mask: input.mask }),
      type: band.type,
      subtype: band.subtype,
      // Not a system account. The standard chart's own 1000 is; a second
      // current account somebody opened is theirs to rename or retire.
      isSystem: false,
    })
    .returning({ id: chartAccounts.id })

  return created.id
}

/**
 * The chart's own account at this number, if it is genuinely free.
 *
 * Free means: it exists, it is active, no bank account posts to it, and
 * **nothing has ever been posted to it**. The last one is what makes reuse
 * safe — renaming an account that already carries a balance would relabel
 * history, and the figures under the old name would silently become figures
 * under the new one.
 */
async function unusedPlaceholder(
  ctx: ActorContext,
  number: string,
  tx: Executor,
): Promise<string | null> {
  const [account] = await tx
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(
      and(
        eq(chartAccounts.companyId, ctx.companyId),
        eq(chartAccounts.number, number),
        eq(chartAccounts.isActive, true),
      ),
    )
    .limit(1)

  if (!account) return null

  const [attached] = await tx
    .select({ id: financialAccounts.id })
    .from(financialAccounts)
    .where(
      and(
        eq(financialAccounts.companyId, ctx.companyId),
        eq(financialAccounts.chartAccountId, account.id),
      ),
    )
    .limit(1)

  if (attached) return null

  const [posted] = await tx
    .select({ id: journalLines.id })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalLines.chartAccountId, account.id),
      ),
    )
    .limit(1)

  return posted ? null : account.id
}

/**
 * Takes an existing chart account for a bank account, if nothing else has it.
 *
 * The check is here as well as in the database because the message matters:
 * "Business Savings already posts to that account" is something somebody can
 * act on, and a unique-violation stack trace is not. The index is what makes
 * it true under concurrency.
 */
async function claimExistingChartAccount(
  ctx: ActorContext,
  chartAccountId: string,
  tx: Executor,
): Promise<string> {
  const [account] = await tx
    .select({ id: chartAccounts.id, type: chartAccounts.type, name: chartAccounts.name })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, chartAccountId)))
    .limit(1)

  if (!account) throw new FinancialAccountError('That ledger account is not on these books.')

  if (account.type !== 'asset' && account.type !== 'liability') {
    throw new FinancialAccountError(
      `A bank account has to post to an asset or a liability. “${account.name}” is ${account.type}.`,
    )
  }

  const [taken] = await tx
    .select({ name: financialAccounts.name })
    .from(financialAccounts)
    .where(
      scoped(ctx, financialAccounts, eq(financialAccounts.chartAccountId, chartAccountId)),
    )
    .limit(1)

  if (taken) {
    throw new FinancialAccountError(
      `“${taken.name}” already posts to that ledger account. Two bank accounts sharing one ledger account means the balance sheet cannot say what is in either.`,
    )
  }

  return account.id
}

/**
 * Renames an account, and its ledger account with it.
 *
 * Both, because they are one thing under two names and letting them drift is
 * how somebody reconciles the wrong one. The ledger account keeps its number,
 * which is what every report and every import refers to.
 */
export async function renameFinancialAccount(
  ctx: ActorContext,
  id: string,
  input: { name: string; mask?: string | null },
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new FinancialAccountError('Give the account a name.')

  const account = await requireAccount(ctx, id)
  const mask = input.mask === undefined ? account.mask : normalizeMask(input.mask)

  await db.transaction(async (tx) => {
    await tx
      .update(financialAccounts)
      .set({ name, mask })
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, id)))

    await tx
      .update(chartAccounts)
      .set({ name: ledgerNameFor({ name, mask }) })
      .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, account.chartAccountId)))

    await recordAudit(
      ctx,
      {
        action: 'account.update',
        entityType: 'financial_account',
        entityId: id,
        before: { name: account.name, mask: account.mask },
        after: { name, mask },
      },
      tx,
    )
  })
}

/**
 * Closes an account without destroying what it holds.
 *
 * Never a delete. The transactions are posted, the reconciliations happened,
 * and a closed account's history is exactly what somebody looks at a year
 * later. Deactivating takes it off every picker and leaves every figure.
 *
 * Refused while a reconciliation is open, because an in-progress session on an
 * account nobody can reach is a session nobody can finish or abandon.
 */
export async function setFinancialAccountActive(
  ctx: ActorContext,
  id: string,
  isActive: boolean,
): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  const account = await requireAccount(ctx, id)
  if (account.isActive === isActive) return

  if (!isActive) {
    const [open] = await db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(
        scoped(
          ctx,
          reconciliations,
          eq(reconciliations.financialAccountId, id),
          eq(reconciliations.status, 'in_progress'),
        ),
      )
      .limit(1)

    if (open) {
      throw new FinancialAccountError(
        'Finish or abandon the open reconciliation on this account before closing it.',
      )
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(financialAccounts)
      .set({ isActive })
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, id)))

    // The ledger account goes with it. A closed bank account whose ledger
    // account is still offered for categorisation is a line somebody will post
    // to by accident, and it will not reconcile against anything.
    await tx
      .update(chartAccounts)
      .set({ isActive })
      .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, account.chartAccountId)))

    await recordAudit(
      ctx,
      {
        action: 'account.update',
        entityType: 'financial_account',
        entityId: id,
        before: { isActive: account.isActive },
        after: { isActive },
      },
      tx,
    )
  })
}

async function requireAccount(ctx: ActorContext, id: string) {
  const [account] = await db
    .select()
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, id)))
    .limit(1)

  if (!account) throw new FinancialAccountError('That account is not on these books.')
  return account
}

export type CashTieOut = {
  financialAccountId: string
  accountName: string
  chartAccountNumber: string
  /** What the ledger says the account holds, from its own chart account. */
  ledgerCents: number
  /** What the feed says, summing the rows that have actually been posted. */
  feedCents: number
  /**
   * The feed less the ledger, in that order.
   *
   * Matches the integrity register's own convention — `differenceCents` there
   * is `leftCents - rightCents`, and left is the subledger side. Computing it
   * the other way round here put the opposite sign on the same word in the
   * summary and the detail of one finding.
   */
  differenceCents: number
  /** Rows sitting in the inbox, which explain a difference rather than being one. */
  uncategorizedCount: number
}

/**
 * What the ledger says each bank account holds, against what its feed says.
 *
 * Only answerable because each account now has a ledger account of its own —
 * with two accounts sharing one, the ledger figure covers both and the
 * comparison is meaningless in exactly the case where it matters.
 *
 * A difference is not automatically wrong: rows still in the inbox have not
 * posted, and money can enter a bank account from an invoice payment that
 * never appeared in the feed. So the uncategorised count is reported beside
 * it, and the judgement is left to a person.
 */
export async function cashTieOut(ctx: ActorContext): Promise<CashTieOut[]> {
  requirePermission(ctx, 'accounting:view')

  const accounts = await listFinancialAccounts(ctx)
  if (accounts.length === 0) return []

  const results: CashTieOut[] = []

  for (const account of accounts) {
    const [ledger] = await db
      .select({
        // Debits less credits. An asset's balance is positive when held; a
        // card's is negative, which is the same convention the feed uses —
        // money you owe is money that has left.
        cents: sql<string>`coalesce(sum(${journalLines.debitCents} - ${journalLines.creditCents}), 0)`,
      })
      .from(journalLines)
      .where(scoped(ctx, journalLines, eq(journalLines.chartAccountId, account.chartAccountId)))

    const [feed] = await db
      .select({
        cents: sql<string>`coalesce(sum(${bankTransactions.amountCents}) filter (
          where ${bankTransactions.reviewState} not in ('new', 'suggested', 'needs_review', 'excluded')
        ), 0)`,
        uncategorized: sql<string>`count(*) filter (
          where ${bankTransactions.reviewState} in ('new', 'suggested', 'needs_review')
        )`,
      })
      .from(bankTransactions)
      .where(
        scoped(ctx, bankTransactions, eq(bankTransactions.financialAccountId, account.id)),
      )

    const ledgerCents = Number(ledger?.cents ?? 0)
    const feedCents = Number(feed?.cents ?? 0)

    results.push({
      financialAccountId: account.id,
      accountName: account.name,
      chartAccountNumber: account.chartAccountNumber,
      ledgerCents,
      feedCents,
      differenceCents: feedCents - ledgerCents,
      uncategorizedCount: Number(feed?.uncategorized ?? 0),
    })
  }

  return results
}

/**
 * Bank accounts that share a ledger account with another one.
 *
 * Kept as a query rather than only a constraint because the constraint can
 * only refuse *new* ones, and a company migrated from before this existed may
 * already have a pair. The integrity check reports them; the repair is a
 * person's decision, because splitting them means deciding which of the
 * postings belonged to which account.
 */
export async function sharedLedgerAccounts(
  ctx: ActorContext,
  exec: Executor = db,
): Promise<Array<{ chartAccountNumber: string; names: string[] }>> {
  requirePermission(ctx, 'accounting:view')

  const rows = await exec
    .select({
      number: chartAccounts.number,
      name: financialAccounts.name,
      chartAccountId: financialAccounts.chartAccountId,
    })
    .from(financialAccounts)
    .innerJoin(chartAccounts, eq(chartAccounts.id, financialAccounts.chartAccountId))
    .where(scoped(ctx, financialAccounts))
    .orderBy(chartAccounts.number, financialAccounts.name)

  const byChart = new Map<string, { number: string; names: string[] }>()
  for (const row of rows) {
    const entry = byChart.get(row.chartAccountId) ?? { number: row.number, names: [] }
    entry.names.push(row.name)
    byChart.set(row.chartAccountId, entry)
  }

  return [...byChart.values()]
    .filter((entry) => entry.names.length > 1)
    .map((entry) => ({ chartAccountNumber: entry.number, names: entry.names }))
}

/** Kept for the rare case where an account was attached to the wrong ledger line. */
export async function ledgerAccountsAvailable(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  const used = db
    .select({ id: financialAccounts.chartAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.companyId, ctx.companyId))

  return db
    .select({
      id: chartAccounts.id,
      number: chartAccounts.number,
      name: chartAccounts.name,
      type: chartAccounts.type,
    })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        eq(chartAccounts.isActive, true),
        sql`${chartAccounts.type} in ('asset', 'liability')`,
        sql`${chartAccounts.id} not in ${used}`,
        ne(chartAccounts.number, ''),
      ),
    )
    .orderBy(chartAccounts.number)
}
