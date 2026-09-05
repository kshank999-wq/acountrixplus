import { and, eq, ne, notInArray, sql } from 'drizzle-orm'
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
import { RateError, functionalCurrency, isForeign, rateFor } from '@/modules/fx/service'
import { bankTransactionFunctional } from '@/modules/fx/carriers'
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
  /**
   * The currency the account is held in, which is the currency `feedCents` is
   * in (Phase 128). Money in a bank is denominated by the bank, not by us.
   */
  currency: string
  /** What the ledger says the account holds, from its own chart account. */
  ledgerCents: number
  /** What the feed says, summing the rows that have actually been posted. */
  feedCents: number
  /**
   * The same rows in the books' own money, or `null` when they cannot all be
   * converted (Phase 128).
   *
   * Equal to `feedCents` for a domestic account, and the only figure that can
   * honestly be set beside `ledgerCents` for a foreign one.
   */
  feedFunctionalCents: number | null
  /**
   * The feed less the ledger, in that order, both in the books' own money —
   * or `null` when the feed side could not be converted.
   *
   * Matches the integrity register's own convention — `differenceCents` there
   * is `leftCents - rightCents`, and left is the subledger side. Computing it
   * the other way round here put the opposite sign on the same word in the
   * summary and the detail of one finding.
   */
  differenceCents: number | null
  /** Rows sitting in the inbox, which explain a difference rather than being one. */
  uncategorizedCount: number
  /**
   * Posted-eligible rows on a foreign account with no rate covering the day
   * they moved (Phase 128).
   *
   * They cannot have reached the ledger either — `buildLines` refuses the same
   * way — so they are the reason a difference is unanswerable rather than a
   * difference themselves.
   */
  unconvertibleCount: number
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
 *
 * ## The two sides have to be in the same currency (Phase 128)
 *
 * The ledger is kept in the company's own money. The feed is in the account's,
 * and an account can be foreign. Until Phase 128 that difference was invisible
 * here for the worst possible reason: `buildLines` posted the face amount, so
 * **both sides were euros and the check agreed while the ledger was wrong**. A
 * check that cannot disagree is Phase 121's whole subject.
 *
 * Fixing the posting makes the ledger side dollars, so the feed side has to
 * follow — converted a day at a time, at the same rate `buildLines` used for
 * that day, which is the only rate that can reproduce what was posted. A
 * domestic account short-circuits and its numbers are byte-for-byte what they
 * were.
 *
 * This is not tautological, which is what makes it still a check: a row in the
 * feed that never posted, a row posted then uncategorised, an invoice payment
 * that moved the ledger without a feed row, and a manual journal all still show
 * up. What it cannot catch is a rate edited after the posting — a bank
 * transaction posts at a rate it does not record, unlike every other moving
 * money column since Phase 116.
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
    const converted = await feedInFunctional(ctx, account, feedCents)

    results.push({
      financialAccountId: account.id,
      accountName: account.name,
      chartAccountNumber: account.chartAccountNumber,
      currency: account.currency,
      ledgerCents,
      feedCents,
      feedFunctionalCents: converted.cents,
      differenceCents: converted.cents === null ? null : converted.cents - ledgerCents,
      uncategorizedCount: Number(feed?.uncategorized ?? 0),
      unconvertibleCount: converted.unconvertibleCount,
    })
  }

  return results
}

/**
 * The posted side of one account's feed, in the books' own money (Phase 128).
 *
 * A day at a time, because that is how `buildLines` converts: one rate for the
 * whole of one movement, taken from the day it moved. Summing the face amounts
 * first and converting once would use one day's rate for a year of them.
 */
async function feedInFunctional(
  ctx: ActorContext,
  account: { id: string; currency: string },
  feedCents: number,
): Promise<{ cents: number | null; unconvertibleCount: number }> {
  const home = await functionalCurrency(ctx.companyId)

  // The rate is 1,000,000 and every multiplication a no-op, so this returns
  // exactly the number this function has returned since Phase 40 — and skips
  // a query per account for every company that has never held a foreign one.
  if (!isForeign(account.currency, home)) {
    return { cents: feedCents, unconvertibleCount: 0 }
  }

  const days = await db
    .select({
      postedDate: bankTransactions.postedDate,
      cents: sql<string>`sum(${bankTransactions.amountCents})`,
      rows: sql<string>`count(*)`,
    })
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        and(
          eq(bankTransactions.financialAccountId, account.id),
          notInArray(bankTransactions.reviewState, [
            'new',
            'suggested',
            'needs_review',
            'excluded',
          ]),
        ),
      ),
    )
    .groupBy(bankTransactions.postedDate)

  let cents = 0
  let unconvertibleCount = 0

  for (const day of days) {
    let rateMillionths: number
    try {
      ;({ rateMillionths } = await rateFor(ctx, account.currency, day.postedDate))
    } catch (error) {
      // No rate for that day, so nothing on it reached the ledger either.
      // Counting the rows rather than guessing a rate is the same answer
      // `buildLines` gives, and leaves the difference honestly unanswerable.
      if (!(error instanceof RateError)) throw error
      unconvertibleCount += Number(day.rows)
      continue
    }

    cents += bankTransactionFunctional(Number(day.cents), rateMillionths) as number
  }

  return { cents: unconvertibleCount > 0 ? null : cents, unconvertibleCount }
}

/**
 * `sharedLedgerAccounts` and the `banking.shared_ledger_accounts` check lived
 * here from Phase 40 until Phase 122, and are gone.
 *
 * The query grouped this company's bank accounts by ledger account and returned
 * the groups with more than one name in them. Its doc comment gave the reason
 * it existed:
 *
 * > Kept as a query rather than only a constraint because the constraint can
 * > only refuse *new* ones, and a company migrated from before this existed may
 * > already have a pair.
 *
 * That sentence is the whole argument, and it is false about this codebase. The
 * constraint and the query arrived in **the same commit**, and the migration
 * that installed the constraint says what it does before adding it:
 *
 * > The unique constraint at the bottom is the fix. It cannot be added to books
 * > that already have a sharing pair, so this repairs them first: each account
 * > after the first gets a ledger account of its own.
 *
 * So the migrated books the query was kept for were repaired by the migration
 * that kept it, and every book since has been refused a pair by
 * `financial_accounts_chart_account_unique`. There has never been a moment when
 * this query could return a row — Phase 121 tried to write a falsifier for the
 * check and found it had to `DROP CONSTRAINT` to construct one.
 *
 * A constraint beats a check (Phase 116), and here the constraint arrived first.
 * `new Set(numbers).size === numbers.length` in the tests says what the query
 * said, without a nightly run on every company reporting green about a state
 * the database will not hold.
 */

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
