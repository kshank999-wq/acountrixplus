import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  auditEvents,
  bankTransactions,
  categorizationRules,
  chartAccounts,
  financialAccounts,
  transactionSplits,
} from '@/db/schema'
import {
  eventsInBatch,
  lastUndoableEvent,
  markUndone,
  newBatchId,
  recordAudit,
} from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  syncLedgerForTransaction,
  syncLedgerForTransferPair,
  unpostTransaction,
} from '@/modules/ledger/posting'
import { rememberVendor } from './rules-engine'
import { DomainError } from '@/modules/errors'

export type ReviewState =
  | 'new'
  | 'suggested'
  | 'needs_review'
  | 'categorized'
  | 'matched'
  | 'excluded'
  | 'reconciled'

export type InboxFilters = {
  /** Defaults to the unreviewed states — the inbox's reason for existing. */
  states?: ReviewState[]
  financialAccountId?: string
  search?: string
  startDate?: string
  endDate?: string
  minCents?: number
  maxCents?: number
  direction?: 'debit' | 'credit'
  limit?: number
  offset?: number
}

/** States that still need a human decision. */
export const UNREVIEWED_STATES: ReviewState[] = ['new', 'suggested', 'needs_review']

/**
 * The Transaction Inbox query (spec §3).
 *
 * Joins the assigned chart account and owning bank account so the list renders
 * without N+1 lookups, and returns a total count for pagination.
 */
export async function listInbox(ctx: ActorContext, filters: InboxFilters = {}) {
  requirePermission(ctx, 'bookkeeping:view')

  const limit = Math.min(filters.limit ?? 50, 200)
  const offset = filters.offset ?? 0
  const conditions: (SQL | undefined)[] = [
    inArray(bankTransactions.reviewState, filters.states ?? UNREVIEWED_STATES),
  ]

  if (filters.financialAccountId) {
    conditions.push(eq(bankTransactions.financialAccountId, filters.financialAccountId))
  }
  if (filters.startDate) conditions.push(gte(bankTransactions.postedDate, filters.startDate))
  if (filters.endDate) conditions.push(lte(bankTransactions.postedDate, filters.endDate))
  if (filters.minCents !== undefined) {
    conditions.push(gte(bankTransactions.amountCents, filters.minCents))
  }
  if (filters.maxCents !== undefined) {
    conditions.push(lte(bankTransactions.amountCents, filters.maxCents))
  }
  if (filters.direction === 'debit') {
    conditions.push(sql`${bankTransactions.amountCents} < 0`)
  } else if (filters.direction === 'credit') {
    conditions.push(sql`${bankTransactions.amountCents} >= 0`)
  }

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`
    conditions.push(
      or(
        ilike(bankTransactions.description, term),
        ilike(bankTransactions.merchantName, term),
      ),
    )
  }

  const where = scoped(ctx, bankTransactions, ...conditions)

  const rows = await db
    .select({
      id: bankTransactions.id,
      postedDate: bankTransactions.postedDate,
      amountCents: bankTransactions.amountCents,
      description: bankTransactions.description,
      merchantName: bankTransactions.merchantName,
      providerCategory: bankTransactions.providerCategory,
      pending: bankTransactions.pending,
      reviewState: bankTransactions.reviewState,
      chartAccountId: bankTransactions.chartAccountId,
      chartAccountName: chartAccounts.name,
      chartAccountNumber: chartAccounts.number,
      appliedRuleId: bankTransactions.appliedRuleId,
      isSplit: bankTransactions.isSplit,
      isTransfer: bankTransactions.isTransfer,
      notes: bankTransactions.notes,
      financialAccountId: bankTransactions.financialAccountId,
      financialAccountName: financialAccounts.name,
      financialAccountMask: financialAccounts.mask,
    })
    .from(bankTransactions)
    .leftJoin(chartAccounts, eq(chartAccounts.id, bankTransactions.chartAccountId))
    .innerJoin(financialAccounts, eq(financialAccounts.id, bankTransactions.financialAccountId))
    .where(where)
    .orderBy(desc(bankTransactions.postedDate), desc(bankTransactions.createdAt))
    .limit(limit)
    .offset(offset)

  const [{ total }] = await db
    .select({ total: count() })
    .from(bankTransactions)
    .where(where)

  return { rows, total: Number(total), limit, offset }
}

/** Per-state counts for the inbox header. */
export async function inboxCounts(ctx: ActorContext) {
  requirePermission(ctx, 'bookkeeping:view')

  const rows = await db
    .select({ state: bankTransactions.reviewState, total: count() })
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions))
    .groupBy(bankTransactions.reviewState)

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.state] = Number(row.total)
  return counts
}

async function loadTransaction(ctx: ActorContext, transactionId: string) {
  const [transaction] = await db
    .select()
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions, eq(bankTransactions.id, transactionId)))
    .limit(1)

  if (!transaction) throw new Error('Transaction not found')
  return transaction
}

/** Raised when a transaction is locked by a completed reconciliation. */
export class ReconciledTransactionError extends DomainError {
  readonly status = 409
  constructor() {
    super(
      'This transaction is part of a completed reconciliation. ' +
        'Reopen the reconciliation before changing it.',
    )
    this.name = 'ReconciledTransactionError'
  }
}

/**
 * Blocks changes to a transaction that a completed reconciliation has locked
 * (spec §4).
 *
 * Without this, recategorizing a reconciled transaction would move money
 * between accounts after someone had already certified that the books agreed
 * with the bank statement.
 */
function assertEditable(transaction: typeof bankTransactions.$inferSelect) {
  if (transaction.reviewState === 'reconciled') {
    throw new ReconciledTransactionError()
  }
}

/**
 * Loads a transaction and confirms it can still be changed.
 *
 * Period locks are enforced separately, by the ledger: posting an entry dated
 * inside a closed period throws `ClosedPeriodError`, and because the ledger
 * sync runs in the same database transaction as the bookkeeping change, the
 * whole thing rolls back together.
 */
async function loadEditableTransaction(ctx: ActorContext, transactionId: string) {
  const transaction = await loadTransaction(ctx, transactionId)
  assertEditable(transaction)
  return transaction
}

/** Snapshot of the fields undo needs to restore. */
function snapshot(transaction: typeof bankTransactions.$inferSelect) {
  return {
    reviewState: transaction.reviewState,
    chartAccountId: transaction.chartAccountId,
    appliedRuleId: transaction.appliedRuleId,
    isSplit: transaction.isSplit,
    isTransfer: transaction.isTransfer,
    excludeReason: transaction.excludeReason,
    notes: transaction.notes,
  }
}

/**
 * Assigns a category (spec §3).
 *
 * `rememberVendor` turns this one decision into a recurring rule, which is the
 * mechanism behind "one-tap now, automatic next month".
 */
export async function categorize(
  ctx: ActorContext,
  transactionId: string,
  chartAccountId: string,
  opts: {
    rememberVendor?: boolean
    vendorRuleAction?: 'auto' | 'suggest'
    /**
     * Job costing dimensions (spec §5, Phase 7).
     *
     * Set at the moment of categorization rather than in a separate step: a
     * contractor deciding a card charge was lumber is deciding which job's
     * lumber in the same breath, and a second screen for the second half of
     * one decision is how job costing goes unused.
     */
    projectId?: string | null
    costCodeId?: string | null
  } = {},
  exec?: Executor,
) {
  requirePermission(ctx, 'bookkeeping:categorize')

  const transaction = await loadEditableTransaction(ctx, transactionId)
  await assertAccountInTenant(ctx, chartAccountId)

  if (opts.costCodeId && !opts.projectId) {
    throw new Error('A cost code needs the job it belongs to. Choose a job as well.')
  }

  const before = snapshot(transaction)
  // When this also creates a vendor rule, both changes share a batch so undo
  // reverses them as the single action the user actually took.
  const batchId = opts.rememberVendor ? newBatchId() : null

  const write = async (tx: Executor) => {
    // Categorizing a previously split transaction replaces the splits.
    if (transaction.isSplit) {
      await tx
        .delete(transactionSplits)
        .where(
          and(
            eq(transactionSplits.transactionId, transactionId),
            eq(transactionSplits.companyId, ctx.companyId),
          ),
        )
    }

    await tx
      .update(bankTransactions)
      .set({
        chartAccountId,
        reviewState: 'categorized',
        isSplit: false,
        // Undefined leaves the existing dimension alone; explicit null clears
        // it. Recategorizing without mentioning the job should not silently
        // drop the job.
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
        ...(opts.costCodeId !== undefined ? { costCodeId: opts.costCodeId } : {}),
        // A human decision supersedes whatever rule proposed it.
        appliedRuleId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.categorize',
        entityType: 'bank_transaction',
        entityId: transactionId,
        batchId,
        before,
        after: {
          ...before,
          reviewState: 'categorized',
          chartAccountId,
          isSplit: false,
          ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
          ...(opts.costCodeId !== undefined ? { costCodeId: opts.costCodeId } : {}),
        },
      },
      tx,
    )

    // Same database transaction, so a closed-period rejection rolls the
    // categorization back with it.
    await syncLedgerForTransaction(ctx, transactionId, tx)
  }

  if (exec) await write(exec)
  else await db.transaction(write)

  let vendorRule = null
  if (opts.rememberVendor) {
    vendorRule = await rememberVendor(ctx, {
      description: transaction.description,
      merchantName: transaction.merchantName,
      chartAccountId,
      action: opts.vendorRuleAction ?? 'suggest',
      batchId,
    })
  }

  return { transactionId, vendorRule }
}

/** Bulk categorization (spec §3). One batch id, so it undoes as one action. */
export async function bulkCategorize(
  ctx: ActorContext,
  transactionIds: string[],
  chartAccountId: string,
) {
  requirePermission(ctx, 'bookkeeping:categorize')
  if (transactionIds.length === 0) return { updated: 0, batchId: null }

  await assertAccountInTenant(ctx, chartAccountId)

  // Scoped select: ids belonging to another tenant simply are not returned.
  const transactions = await db
    .select()
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions, inArray(bankTransactions.id, transactionIds)))

  if (transactions.length === 0) return { updated: 0, batchId: null }

  const batchId = newBatchId()

  await db.transaction(async (tx) => {
    for (const transaction of transactions) {
      assertEditable(transaction)
      const before = snapshot(transaction)

      if (transaction.isSplit) {
        await tx
          .delete(transactionSplits)
          .where(
            and(
              eq(transactionSplits.transactionId, transaction.id),
              eq(transactionSplits.companyId, ctx.companyId),
            ),
          )
      }

      await tx
        .update(bankTransactions)
        .set({
          chartAccountId,
          reviewState: 'categorized',
          isSplit: false,
          appliedRuleId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankTransactions.id, transaction.id),
            eq(bankTransactions.companyId, ctx.companyId),
          ),
        )

      await recordAudit(
        ctx,
        {
          action: 'transaction.categorize',
          entityType: 'bank_transaction',
          entityId: transaction.id,
          batchId,
          before,
          after: { ...before, reviewState: 'categorized', chartAccountId, isSplit: false },
        },
        tx,
      )

      await syncLedgerForTransaction(ctx, transaction.id, tx)
    }
  })

  return { updated: transactions.length, batchId }
}

export type SplitInput = {
  chartAccountId: string
  amountCents: number
  memo?: string
  /** Per-line job costing, so one purchase can be split across two jobs. */
  projectId?: string | null
  costCodeId?: string | null
}

/**
 * Splits a transaction across accounts (spec §3).
 *
 * The split amounts must sum exactly to the parent amount. This invariant
 * spans rows so the database cannot express it — it is enforced here and
 * covered by tests. Integer cents mean the check is exact, with no epsilon.
 */
export async function splitTransaction(
  ctx: ActorContext,
  transactionId: string,
  splits: SplitInput[],
  exec?: Executor,
) {
  requirePermission(ctx, 'bookkeeping:categorize')

  if (splits.length < 2) {
    throw new Error('A split needs at least two lines.')
  }

  const transaction = await loadEditableTransaction(ctx, transactionId)

  const total = splits.reduce((sum, split) => sum + split.amountCents, 0)
  if (total !== transaction.amountCents) {
    throw new Error(
      `Split lines total ${total} but the transaction is ${transaction.amountCents}. They must match exactly.`,
    )
  }

  if (splits.some((split) => split.amountCents === 0)) {
    throw new Error('Split lines cannot be zero.')
  }

  const accountIds = [...new Set(splits.map((s) => s.chartAccountId))]
  await assertAccountsInTenant(ctx, accountIds)

  const before = snapshot(transaction)

  const write = async (tx: Executor) => {
    await tx
      .delete(transactionSplits)
      .where(
        and(
          eq(transactionSplits.transactionId, transactionId),
          eq(transactionSplits.companyId, ctx.companyId),
        ),
      )

    await tx.insert(transactionSplits).values(
      splits.map((split, index) => ({
        companyId: ctx.companyId,
        transactionId,
        chartAccountId: split.chartAccountId,
        amountCents: split.amountCents,
        memo: split.memo ?? null,
        projectId: split.projectId ?? null,
        costCodeId: split.costCodeId ?? null,
        sortOrder: index,
      })),
    )

    await tx
      .update(bankTransactions)
      .set({
        isSplit: true,
        // The splits carry the accounts now.
        chartAccountId: null,
        reviewState: 'categorized',
        appliedRuleId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.split',
        entityType: 'bank_transaction',
        entityId: transactionId,
        before,
        after: { ...before, isSplit: true, chartAccountId: null, reviewState: 'categorized', splits },
      },
      tx,
    )

    await syncLedgerForTransaction(ctx, transactionId, tx)
  }

  if (exec) await write(exec)
  else await db.transaction(write)

  return { transactionId, lines: splits.length }
}

export async function splitsFor(ctx: ActorContext, transactionId: string) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select({
      id: transactionSplits.id,
      chartAccountId: transactionSplits.chartAccountId,
      chartAccountName: chartAccounts.name,
      amountCents: transactionSplits.amountCents,
      memo: transactionSplits.memo,
      sortOrder: transactionSplits.sortOrder,
    })
    .from(transactionSplits)
    .innerJoin(chartAccounts, eq(chartAccounts.id, transactionSplits.chartAccountId))
    .where(
      scoped(ctx, transactionSplits, eq(transactionSplits.transactionId, transactionId)),
    )
    .orderBy(transactionSplits.sortOrder)
}

/** Excludes a transaction from the books (spec §3), e.g. a personal charge. */
export async function excludeTransaction(
  ctx: ActorContext,
  transactionId: string,
  reason?: string,
  exec?: Executor,
) {
  requirePermission(ctx, 'bookkeeping:categorize')

  const transaction = await loadEditableTransaction(ctx, transactionId)
  const before = snapshot(transaction)

  const write = async (tx: Executor) => {
    await tx
      .update(bankTransactions)
      .set({
        reviewState: 'excluded',
        excludeReason: reason ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.exclude',
        entityType: 'bank_transaction',
        entityId: transactionId,
        before,
        after: { ...before, reviewState: 'excluded', excludeReason: reason ?? null },
      },
      tx,
    )

    // Excluded is not a postable state, so this voids any entry the
    // transaction had rather than posting a new one.
    await syncLedgerForTransaction(ctx, transactionId, tx)
  }

  if (exec) await write(exec)
  else await db.transaction(write)
}

/**
 * Marks a transaction as a transfer between the company's own accounts, so it
 * is not miscounted as income or expense (spec §3).
 */
export async function markAsTransfer(
  ctx: ActorContext,
  transactionId: string,
  pairTransactionId?: string,
) {
  requirePermission(ctx, 'bookkeeping:categorize')

  const transaction = await loadEditableTransaction(ctx, transactionId)
  const before = snapshot(transaction)

  if (pairTransactionId) {
    const pair = await loadEditableTransaction(ctx, pairTransactionId)

    // The two legs must offset. Anything else is not a transfer.
    if (pair.amountCents !== -transaction.amountCents) {
      throw new Error('Transfer legs must be equal and opposite.')
    }
    if (pair.financialAccountId === transaction.financialAccountId) {
      throw new Error('A transfer must move between two different accounts.')
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(bankTransactions)
      .set({
        isTransfer: true,
        transferPairId: pairTransactionId ?? null,
        reviewState: 'matched',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    if (pairTransactionId) {
      await tx
        .update(bankTransactions)
        .set({
          isTransfer: true,
          transferPairId: transactionId,
          reviewState: 'matched',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankTransactions.id, pairTransactionId),
            eq(bankTransactions.companyId, ctx.companyId),
          ),
        )
    }

    await recordAudit(
      ctx,
      {
        action: 'transaction.transfer_mark',
        entityType: 'bank_transaction',
        entityId: transactionId,
        before,
        after: { ...before, isTransfer: true, reviewState: 'matched' },
      },
      tx,
    )

    if (pairTransactionId) {
      // One entry for the pair — posting each leg would double-count the move.
      await syncLedgerForTransferPair(ctx, transactionId, pairTransactionId, tx)
    } else {
      // An unmatched transfer has no counterparty yet, so there is nothing
      // correct to post. Any prior entry is withdrawn until it is paired.
      await unpostTransaction(ctx, transactionId, tx)
    }
  })
}

/** Confirms a rule's suggestion, promoting `suggested` to `categorized`. */
export async function acceptSuggestion(ctx: ActorContext, transactionId: string) {
  requirePermission(ctx, 'bookkeeping:categorize')

  const transaction = await loadEditableTransaction(ctx, transactionId)
  if (transaction.reviewState !== 'suggested' || !transaction.chartAccountId) {
    throw new Error('That transaction has no pending suggestion.')
  }

  const before = snapshot(transaction)

  await db.transaction(async (tx) => {
    await tx
      .update(bankTransactions)
      .set({ reviewState: 'categorized', updatedAt: new Date() })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.categorize',
        entityType: 'bank_transaction',
        entityId: transactionId,
        before,
        after: { ...before, reviewState: 'categorized' },
      },
      tx,
    )

    // A suggestion is not in the ledger until someone confirms it.
    await syncLedgerForTransaction(ctx, transactionId, tx)
  })
}

/** Attaches a note. */
export async function setNote(
  ctx: ActorContext,
  transactionId: string,
  note: string | null,
  exec?: Executor,
) {
  requirePermission(ctx, 'bookkeeping:categorize')

  const transaction = await loadTransaction(ctx, transactionId)
  const before = snapshot(transaction)

  const write = async (tx: Executor) => {
    await tx
      .update(bankTransactions)
      .set({ notes: note, updatedAt: new Date() })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'transaction.note',
        entityType: 'bank_transaction',
        entityId: transactionId,
        before,
        after: { ...before, notes: note },
      },
      tx,
    )
  }

  if (exec) await write(exec)
  else await db.transaction(write)
}

/**
 * Undoes the actor's most recent action (spec §3, §22).
 *
 * Undo restores the `before` snapshot recorded on the audit event and writes a
 * *new* event describing the reversal — the log stays append-only, so history
 * shows both the change and its undo (spec §19). Batched actions undo as a
 * unit.
 */
export async function undoLast(ctx: ActorContext) {
  requirePermission(ctx, 'bookkeeping:categorize')

  const event = await lastUndoableEvent(ctx)
  if (!event) return { undone: 0 }

  const events = event.batchId ? await eventsInBatch(ctx, event.batchId) : [event]
  const undoBatchId = newBatchId()
  let undone = 0

  await db.transaction(async (tx) => {
    // Reverse order, so a sequence of changes unwinds correctly.
    for (const target of [...events].reverse()) {
      if (target.undoneByEventId || target.isUndo) continue
      if (!target.entityId) continue

      // Undoing a categorization that also remembered the vendor must retire
      // the rule it created, or the next sync would re-apply the decision the
      // user just took back.
      if (target.entityType === 'categorization_rule') {
        if (target.action !== 'rule.create') continue

        await tx
          .update(categorizationRules)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(categorizationRules.id, target.entityId),
              eq(categorizationRules.companyId, ctx.companyId),
            ),
          )

        const ruleUndoEvent = await recordAudit(
          ctx,
          {
            action: 'rule.delete',
            entityType: 'categorization_rule',
            entityId: target.entityId,
            batchId: undoBatchId,
            isUndo: true,
            before: { isActive: true },
            after: { isActive: false },
          },
          tx,
        )

        await markUndone(ctx, target.id, ruleUndoEvent.id, tx)
        continue
      }

      if (target.entityType !== 'bank_transaction') continue

      const before = target.before as Record<string, unknown> | null
      if (!before) continue

      await tx
        .update(bankTransactions)
        .set({
          reviewState: (before.reviewState as ReviewState | undefined) ?? 'new',
          chartAccountId: (before.chartAccountId as string | null) ?? null,
          appliedRuleId: (before.appliedRuleId as string | null) ?? null,
          isSplit: (before.isSplit as boolean | undefined) ?? false,
          isTransfer: (before.isTransfer as boolean | undefined) ?? false,
          excludeReason: (before.excludeReason as string | null) ?? null,
          notes: (before.notes as string | null) ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankTransactions.id, target.entityId),
            eq(bankTransactions.companyId, ctx.companyId),
          ),
        )

      // Restoring a non-split state means any split rows are now stale.
      if (before.isSplit !== true) {
        await tx
          .delete(transactionSplits)
          .where(
            and(
              eq(transactionSplits.transactionId, target.entityId),
              eq(transactionSplits.companyId, ctx.companyId),
            ),
          )
      }

      const undoEvent = await recordAudit(
        ctx,
        {
          action: 'transaction.uncategorize',
          entityType: 'bank_transaction',
          entityId: target.entityId,
          batchId: undoBatchId,
          isUndo: true,
          before: target.after as Record<string, unknown> | null,
          after: before,
        },
        tx,
      )

      // The restored state decides what the ledger should now say — which for
      // an undone categorization means voiding the entry it created.
      await syncLedgerForTransaction(ctx, target.entityId, tx)

      await markUndone(ctx, target.id, undoEvent.id, tx)
      undone++
    }
  })

  return { undone, batchId: undoBatchId }
}

/** Full history for one transaction, newest first. */
export async function transactionHistory(ctx: ActorContext, transactionId: string) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorName: auditEvents.actorName,
      before: auditEvents.before,
      after: auditEvents.after,
      isUndo: auditEvents.isUndo,
      undoneByEventId: auditEvents.undoneByEventId,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      scoped(
        ctx,
        auditEvents,
        eq(auditEvents.entityType, 'bank_transaction'),
        eq(auditEvents.entityId, transactionId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
}

/**
 * Confirms a chart account belongs to this tenant.
 *
 * Without this a caller could pass another company's account id: the update
 * itself is tenant-scoped, but the *value* being written would not be. That is
 * exactly the kind of cross-tenant leak spec §19 is about.
 */
async function assertAccountInTenant(ctx: ActorContext, chartAccountId: string) {
  const [account] = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, chartAccountId)))
    .limit(1)

  if (!account) throw new Error('Chart account not found')
}

async function assertAccountsInTenant(ctx: ActorContext, chartAccountIds: string[]) {
  const rows = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, inArray(chartAccounts.id, chartAccountIds)))

  if (rows.length !== chartAccountIds.length) {
    throw new Error('One or more chart accounts were not found')
  }
}
