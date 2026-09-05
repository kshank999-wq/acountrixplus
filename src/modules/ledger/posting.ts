import { and, eq, inArray } from 'drizzle-orm'
import { type Executor } from '@/db'
import {
  bankTransactions,
  financialAccounts,
  transactionSplits,
} from '@/db/schema'
import type { ActorContext } from '@/modules/tenancy/context'
import { createJournalEntry, entryForSource, voidJournalEntry, type JournalLineInput } from './journal'
import { missing } from '@/modules/errors/missing'
import { bankTransactionFunctional } from '@/modules/fx/carriers'
import { keptRate } from '@/modules/fx/posted-rate'
import { rateFor } from '@/modules/fx/service'
import { Refusal } from '@/modules/errors'

/**
 * Derives ledger entries from bank transactions (ADR 0001).
 *
 * The bank feed stays the immutable source record; the journal entry is the
 * accounting consequence of a person deciding what a transaction was. Owners
 * never write journal entries by hand to keep their books — that follows from
 * the "reduce duplicate entry" rule in spec §23.
 *
 * ## Sign convention
 *
 * `bankTransactions.amountCents` is signed from the account holder's view:
 * negative means money left the account, positive means it arrived. The
 * posting rule is uniform:
 *
 *   amount < 0  →  Dr category account,  Cr the account's GL account
 *   amount > 0  →  Dr the account's GL account,  Cr category account
 *
 * This is correct for both asset and liability accounts without special
 * casing. Spending on a credit card credits the card's liability account,
 * increasing what is owed; spending from checking credits the asset account,
 * reducing cash. Both are the same entry shape.
 */

/** Review states whose transactions belong in the ledger. */
const POSTABLE_STATES = new Set(['categorized', 'reconciled'])

/**
 * The entry a transaction produces, and what it went into the books at.
 *
 * The rate travels back with the lines so the caller can write it down (Phase
 * 129). Deriving it here and again anywhere else is what let a re-categorised
 * transaction restate its own cost.
 */
type PostedLines = {
  lines: JournalLineInput[]
  rateMillionths: number
  /** Signed the way the statement reads it, matching `amountCents`. */
  functionalCents: number
}

/**
 * Brings the ledger in line with a bank transaction's current state.
 *
 * Idempotent: voids whatever entry the transaction had, then posts a fresh one
 * if it is currently postable. Recategorizing therefore replaces the entry
 * rather than stacking a second one, and excluding removes the ledger effect
 * entirely.
 *
 * Runs inside the caller's transaction, so the bookkeeping change and its
 * ledger consequence commit together or not at all.
 */
export async function syncLedgerForTransaction(
  ctx: ActorContext,
  transactionId: string,
  exec: Executor,
): Promise<{ posted: boolean; entryId?: string }> {
  const [transaction] = await exec
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.id, transactionId),
        eq(bankTransactions.companyId, ctx.companyId),
      ),
    )
    .limit(1)

  if (!transaction) throw missing('transaction')

  const existing = await entryForSource(ctx, 'bank_transaction', transactionId, exec)
  if (existing) {
    await voidJournalEntry(ctx, existing.id, exec)
  }

  const built = await buildLines(ctx, transaction, exec)
  if (!built) return { posted: false }

  const entry = await createJournalEntry(
    ctx,
    {
      entryDate: transaction.postedDate,
      memo: transaction.merchantName ?? transaction.description,
      source: 'bank_transaction',
      sourceType: 'bank_transaction',
      sourceId: transactionId,
      lines: built.lines,
    },
    exec,
  )

  // Written after the entry exists, so the row never claims a rate for a
  // posting that failed. On a re-post `rateForPosting` has already handed back
  // the rate that is here, so this rewrites it with itself.
  await recordPostedRate(exec, transactionId, {
    rateMillionths: built.rateMillionths,
    functionalCents: built.functionalCents,
  })

  return { posted: true, entryId: entry.id }
}

/**
 * Writes down what a posting went into the books at (Phase 129).
 *
 * Signed the way the statement reads it, so face and functional agree on
 * direction and a tie-out can add the column up without re-deriving anything.
 */
async function recordPostedRate(
  exec: Executor,
  transactionId: string,
  posted: { rateMillionths: number; functionalCents: number },
): Promise<void> {
  await exec
    .update(bankTransactions)
    .set({
      rateMillionths: posted.rateMillionths,
      functionalAmountCents: posted.functionalCents,
    })
    .where(eq(bankTransactions.id, transactionId))
}

/**
 * Builds the lines for a transaction, or returns null when it should not be in
 * the ledger at all.
 *
 * Nothing posts for a transaction that is excluded, still awaiting review, or
 * marked as a transfer — transfers are posted once for the pair by
 * `syncLedgerForTransferPair`, so posting each leg here would double-count.
 */
async function buildLines(
  ctx: ActorContext,
  transaction: typeof bankTransactions.$inferSelect,
  exec: Executor,
): Promise<PostedLines | null> {
  if (transaction.isTransfer) return null
  if (!POSTABLE_STATES.has(transaction.reviewState)) return null

  const glAccountId = await bankGlAccount(transaction.financialAccountId, exec)
  const isOutflow = transaction.amountCents < 0

  /**
   * What the ledger takes, in the company's own money (Phase 128).
   *
   * `bank_transactions` has no currency of its own; it inherits the account's,
   * and `financial_accounts.currency` has existed since the banking schema was
   * first written. Until this, `Math.abs(transaction.amountCents)` went
   * straight into `debitCents` — so every categorised transaction on a euro
   * account put euros into a ledger kept in dollars. `banking.cash_tie_out`
   * agreed all the while, because the feed side it compares against is the
   * same face amount; `cashTieOut` converts that side too now, at the rate
   * used here, or the fix would turn a blind check into a nightly false alarm.
   *
   * Phase 127's scan could not see it: its list of currency-bearing tables was
   * typed by hand and left `financial_accounts` out. `fx/carriers.ts` is now
   * the list, and its test asks the schema rather than a person.
   *
   * `rateFor` refuses when the account is foreign and no rate covers the day
   * the money moved, and that refusal is allowed to reach the person
   * categorising the transaction — the same answer Phase 64 gave an invoice
   * that cannot be raised without one, in a sentence that already says what to
   * do about it. A domestic account short-circuits at 1,000,000, which is why
   * the multiplication was a no-op for everybody who ever ran this.
   */
  const books = await booksConverter(ctx, transaction, exec)
  const toBooks = books.toBooks

  const magnitude = toBooks(Math.abs(transaction.amountCents))
  if (magnitude === 0) return null
  const posted = {
    rateMillionths: books.rateMillionths,
    functionalCents: transaction.amountCents < 0 ? -magnitude : magnitude,
  }

  // A split carries its own category lines; the bank side is one line for the
  // total, which is why the split amounts must sum exactly to the parent.
  if (transaction.isSplit) {
    const splits = await exec
      .select()
      .from(transactionSplits)
      .where(
        and(
          eq(transactionSplits.transactionId, transaction.id),
          eq(transactionSplits.companyId, ctx.companyId),
        ),
      )
      .orderBy(transactionSplits.sortOrder)

    if (splits.length === 0) return null

    // Each split carries its own job and cost code, so a single card charge
    // covering two sites lands on both jobs without a second document.
    const categoryLines: JournalLineInput[] = splits.map((split) => {
      // Each split at the same rate as its parent: they are one movement of
      // money on one day, and converting them apart could leave the entry a
      // cent out against the bank line above.
      const amount = toBooks(Math.abs(split.amountCents))
      const dimensions = {
        projectId: split.projectId ?? transaction.projectId,
        costCodeId: split.projectId ? split.costCodeId : transaction.costCodeId,
      }
      return split.amountCents < 0
        ? {
            chartAccountId: split.chartAccountId,
            debitCents: amount,
            memo: split.memo,
            ...dimensions,
          }
        : {
            chartAccountId: split.chartAccountId,
            creditCents: amount,
            memo: split.memo,
            ...dimensions,
          }
    })

    const bankLine: JournalLineInput = isOutflow
      ? { chartAccountId: glAccountId, creditCents: magnitude }
      : { chartAccountId: glAccountId, debitCents: magnitude }

    return { lines: [...categoryLines, bankLine], ...posted }
  }

  if (!transaction.chartAccountId) return null

  // The dimensions ride on the category line, never on the bank line: a job
  // costs money, a checking account does not belong to one.
  const dimensions = {
    projectId: transaction.projectId,
    costCodeId: transaction.costCodeId,
  }

  return {
    lines: isOutflow
      ? [
          { chartAccountId: transaction.chartAccountId, debitCents: magnitude, ...dimensions },
          { chartAccountId: glAccountId, creditCents: magnitude },
        ]
      : [
          { chartAccountId: glAccountId, debitCents: magnitude },
          { chartAccountId: transaction.chartAccountId, creditCents: magnitude, ...dimensions },
        ],
    ...posted,
  }
}

/**
 * Posts a matched transfer as a single entry between the two bank accounts.
 *
 * A transfer is one movement of money that the feed reports twice, once from
 * each side. Posting it once — debiting the receiving account's GL account and
 * crediting the sending one — keeps it out of income and expense entirely,
 * which is the whole point of identifying transfers (spec §3).
 *
 * Both legs point at the same entry through `sourceId`, so voiding one voids
 * the pair.
 */
export async function syncLedgerForTransferPair(
  ctx: ActorContext,
  transactionId: string,
  pairTransactionId: string,
  exec: Executor,
): Promise<{ posted: boolean; entryId?: string }> {
  const legs = await exec
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        inArray(bankTransactions.id, [transactionId, pairTransactionId]),
      ),
    )

  const outgoing = legs.find((leg) => leg.id === transactionId)
  const incoming = legs.find((leg) => leg.id === pairTransactionId)
  if (!outgoing || !incoming) return { posted: false }

  // Void any entry either leg previously had, so re-pairing cannot double-post.
  for (const leg of [outgoing, incoming]) {
    const existing = await entryForSource(ctx, 'bank_transaction', leg.id, exec)
    if (existing) await voidJournalEntry(ctx, existing.id, exec)
  }

  const source = outgoing.amountCents < 0 ? outgoing : incoming
  const destination = outgoing.amountCents < 0 ? incoming : outgoing

  /**
   * One movement, one currency (Phase 128).
   *
   * A transfer posts a single magnitude to both legs, which is only a movement
   * of money if both accounts hold the same thing. Between a euro account and
   * a dollar one it is a *conversion*: the bank takes one amount out and puts a
   * different one in, and the difference is a realised gain or loss somebody
   * has to decide to recognise.
   *
   * Refused rather than converted, on Phase 117's rule and Phase 123's
   * precedent for a deposit of two currencies. Posting the source magnitude to
   * both sides would balance the entry and misstate both accounts; converting
   * one side at today's rate would invent a figure neither bank statement
   * shows. Two accounts in two currencies is two transactions.
   */
  const [sourceAccount, destinationAccount] = await Promise.all([
    accountCurrency(source.financialAccountId, exec),
    accountCurrency(destination.financialAccountId, exec),
  ])

  if (sourceAccount !== destinationAccount) {
    throw new Refusal(
      `Those accounts are held in ${sourceAccount} and ${destinationAccount}, so this is a ` +
        'currency conversion rather than a transfer — the bank takes one amount out and puts a ' +
        'different one in. Categorise each side on its own.',
    )
  }

  const books = await booksConverter(ctx, source, exec)
  const magnitude = books.toBooks(Math.abs(source.amountCents))
  if (magnitude === 0) return { posted: false }

  const sourceGl = await bankGlAccount(source.financialAccountId, exec)
  const destinationGl = await bankGlAccount(destination.financialAccountId, exec)

  const entry = await createJournalEntry(
    ctx,
    {
      // The later of the two dates, so the entry is not dated before the money
      // has actually arrived.
      entryDate:
        source.postedDate > destination.postedDate ? source.postedDate : destination.postedDate,
      memo: `Transfer between accounts`,
      source: 'bank_transaction',
      sourceType: 'bank_transaction',
      sourceId: source.id,
      lines: [
        { chartAccountId: destinationGl, debitCents: magnitude },
        { chartAccountId: sourceGl, creditCents: magnitude },
      ],
    },
    exec,
  )

  // Both legs, so neither can be re-derived apart from the other (Phase 129).
  // They are the same money on the same day in the same currency — Phase 128
  // refuses the pair otherwise — so one rate covers both, signed the way each
  // statement reads its own side.
  for (const leg of [source, destination]) {
    await recordPostedRate(exec, leg.id, {
      rateMillionths: books.rateMillionths,
      functionalCents: leg.amountCents < 0 ? -magnitude : magnitude,
    })
  }

  return { posted: true, entryId: entry.id }
}

/** Voids the ledger entry derived from a transaction, if there is one. */
export async function unpostTransaction(
  ctx: ActorContext,
  transactionId: string,
  exec: Executor,
): Promise<void> {
  const existing = await entryForSource(ctx, 'bank_transaction', transactionId, exec)
  if (existing) await voidJournalEntry(ctx, existing.id, exec)
}

/** The GL account a bank or credit-card account posts through. */
/**
 * How to put an account's money into the books (Phase 128).
 *
 * One rate for the whole transaction, fetched once: a transaction and its
 * splits are one movement of money on one day, and converting them at
 * separately-fetched rates could leave the entry a cent out against itself.
 */
async function booksConverter(
  ctx: ActorContext,
  transaction: Pick<
    typeof bankTransactions.$inferSelect,
    'financialAccountId' | 'postedDate' | 'rateMillionths'
  >,
  exec: Executor,
): Promise<{ toBooks: (faceCents: number) => number; rateMillionths: number }> {
  const [account] = await exec
    .select({ currency: financialAccounts.currency })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, transaction.financialAccountId))
    .limit(1)

  if (!account) throw missing('financialAccount')

  /**
   * A rate already recorded wins over anything the table says today (Phase
   * 129).
   *
   * `rateFor` is still asked when nothing has been recorded, and it still
   * refuses rather than guessing — but it is asked **once**. Re-posting is how
   * this function is normally reached, since `syncLedgerForTransaction` voids
   * and rebuilds on every re-categorisation, and re-deriving there silently
   * restated the books whenever the rate table had grown in between.
   */
  const rateMillionths =
    keptRate(transaction.rateMillionths) ??
    (await rateFor(ctx, account.currency, transaction.postedDate, exec)).rateMillionths

  return {
    rateMillionths,
    toBooks: (faceCents) => bankTransactionFunctional(faceCents, rateMillionths) as number,
  }
}

async function accountCurrency(financialAccountId: string, exec: Executor): Promise<string> {
  const [account] = await exec
    .select({ currency: financialAccounts.currency })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, financialAccountId))
    .limit(1)

  if (!account) throw missing('financialAccount')
  return account.currency
}

async function bankGlAccount(financialAccountId: string, exec: Executor): Promise<string> {
  const [account] = await exec
    .select({ chartAccountId: financialAccounts.chartAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, financialAccountId))
    .limit(1)

  if (!account) throw missing('financialAccount')
  return account.chartAccountId
}
