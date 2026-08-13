import { and, eq, inArray } from 'drizzle-orm'
import { type Executor } from '@/db'
import {
  bankTransactions,
  financialAccounts,
  transactionSplits,
} from '@/db/schema'
import type { ActorContext } from '@/modules/tenancy/context'
import { createJournalEntry, entryForSource, voidJournalEntry, type JournalLineInput } from './journal'

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

  if (!transaction) throw new Error('Transaction not found')

  const existing = await entryForSource(ctx, 'bank_transaction', transactionId, exec)
  if (existing) {
    await voidJournalEntry(ctx, existing.id, exec)
  }

  const lines = await buildLines(ctx, transaction, exec)
  if (!lines) return { posted: false }

  const entry = await createJournalEntry(
    ctx,
    {
      entryDate: transaction.postedDate,
      memo: transaction.merchantName ?? transaction.description,
      source: 'bank_transaction',
      sourceType: 'bank_transaction',
      sourceId: transactionId,
      lines,
    },
    exec,
  )

  return { posted: true, entryId: entry.id }
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
): Promise<JournalLineInput[] | null> {
  if (transaction.isTransfer) return null
  if (!POSTABLE_STATES.has(transaction.reviewState)) return null

  const glAccountId = await bankGlAccount(transaction.financialAccountId, exec)
  const isOutflow = transaction.amountCents < 0
  const magnitude = Math.abs(transaction.amountCents)
  if (magnitude === 0) return null

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

    const categoryLines: JournalLineInput[] = splits.map((split) => {
      const amount = Math.abs(split.amountCents)
      return split.amountCents < 0
        ? { chartAccountId: split.chartAccountId, debitCents: amount, memo: split.memo }
        : { chartAccountId: split.chartAccountId, creditCents: amount, memo: split.memo }
    })

    const bankLine: JournalLineInput = isOutflow
      ? { chartAccountId: glAccountId, creditCents: magnitude }
      : { chartAccountId: glAccountId, debitCents: magnitude }

    return [...categoryLines, bankLine]
  }

  if (!transaction.chartAccountId) return null

  return isOutflow
    ? [
        { chartAccountId: transaction.chartAccountId, debitCents: magnitude },
        { chartAccountId: glAccountId, creditCents: magnitude },
      ]
    : [
        { chartAccountId: glAccountId, debitCents: magnitude },
        { chartAccountId: transaction.chartAccountId, creditCents: magnitude },
      ]
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
  const magnitude = Math.abs(source.amountCents)
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
async function bankGlAccount(financialAccountId: string, exec: Executor): Promise<string> {
  const [account] = await exec
    .select({ chartAccountId: financialAccounts.chartAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, financialAccountId))
    .limit(1)

  if (!account) throw new Error('Financial account not found')
  return account.chartAccountId
}
