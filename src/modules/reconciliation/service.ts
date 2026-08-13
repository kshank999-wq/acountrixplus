import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, financialAccounts, reconciliations } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * Bank and credit-card reconciliation (spec §4).
 *
 * The arithmetic that matters:
 *
 *   cleared balance = beginning balance + sum(cleared transaction amounts)
 *   difference      = statement ending balance − cleared balance
 *
 * A session can only be completed when the difference is exactly zero, so a
 * stored reconciliation is always a claim that the books agreed with the bank
 * on that date. All figures are integer cents, so "exactly zero" means exactly
 * zero — there is no tolerance to tune.
 */

export type ReconciliationSummary = {
  id: string
  financialAccountId: string
  statementStartDate: string
  statementEndDate: string
  statementEndingBalanceCents: number
  beginningBalanceCents: number
  clearedBalanceCents: number
  clearedCount: number
  unclearedCount: number
  differenceCents: number
  isBalanced: boolean
  status: 'in_progress' | 'completed' | 'reopened'
}

/**
 * Starts a session for an account.
 *
 * The beginning balance is taken from the last completed reconciliation for
 * the same account, so consecutive statements chain without re-entry. The
 * first ever reconciliation starts from zero.
 */
export async function startReconciliation(
  ctx: ActorContext,
  input: {
    financialAccountId: string
    statementStartDate: string
    statementEndDate: string
    statementEndingBalanceCents: number
  },
) {
  requirePermission(ctx, 'reconciliation:perform')

  if (input.statementEndDate < input.statementStartDate) {
    throw new Error('The statement end date must be on or after the start date.')
  }

  const [account] = await db
    .select()
    .from(financialAccounts)
    .where(
      scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)),
    )
    .limit(1)

  if (!account) throw new Error('Financial account not found')

  const [openSession] = await db
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(
      scoped(
        ctx,
        reconciliations,
        eq(reconciliations.financialAccountId, input.financialAccountId),
        eq(reconciliations.status, 'in_progress'),
      ),
    )
    .limit(1)

  if (openSession) {
    throw new Error(
      'This account already has a reconciliation in progress. Open it from the list above and finish it first.',
    )
  }

  const beginningBalanceCents = await lastCompletedEndingBalance(ctx, input.financialAccountId)

  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(reconciliations)
      .values({
        companyId: ctx.companyId,
        financialAccountId: input.financialAccountId,
        statementStartDate: input.statementStartDate,
        statementEndDate: input.statementEndDate,
        statementEndingBalanceCents: input.statementEndingBalanceCents,
        beginningBalanceCents,
        status: 'in_progress',
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'reconciliation.start',
        entityType: 'reconciliation',
        entityId: session.id,
        after: {
          account: account.name,
          statementEndDate: input.statementEndDate,
          statementEndingBalanceCents: input.statementEndingBalanceCents,
          beginningBalanceCents,
        },
      },
      tx,
    )

    return session
  })
}

/** Ending balance of the most recent completed reconciliation, or zero. */
async function lastCompletedEndingBalance(
  ctx: ActorContext,
  financialAccountId: string,
): Promise<number> {
  const [previous] = await db
    .select({ balance: reconciliations.statementEndingBalanceCents })
    .from(reconciliations)
    .where(
      scoped(
        ctx,
        reconciliations,
        eq(reconciliations.financialAccountId, financialAccountId),
        eq(reconciliations.status, 'completed'),
      ),
    )
    .orderBy(desc(reconciliations.statementEndDate))
    .limit(1)

  return previous?.balance ?? 0
}

/**
 * Marks transactions cleared or uncleared.
 *
 * Only transactions on the session's own account, dated on or before the
 * statement end date, are eligible — a transaction that had not happened yet
 * cannot appear on that statement.
 */
export async function setCleared(
  ctx: ActorContext,
  reconciliationId: string,
  transactionIds: string[],
  cleared: boolean,
) {
  requirePermission(ctx, 'reconciliation:perform')
  if (transactionIds.length === 0) return { updated: 0 }

  const session = await loadOpenSession(ctx, reconciliationId)

  const eligible = await db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        inArray(bankTransactions.id, transactionIds),
        eq(bankTransactions.financialAccountId, session.financialAccountId),
        lte(bankTransactions.postedDate, session.statementEndDate),
      ),
    )

  if (eligible.length === 0) return { updated: 0 }
  const eligibleIds = eligible.map((row) => row.id)

  await db.transaction(async (tx) => {
    await tx
      .update(bankTransactions)
      .set({
        clearedAt: cleared ? new Date() : null,
        reconciliationId: cleared ? reconciliationId : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.companyId, ctx.companyId),
          inArray(bankTransactions.id, eligibleIds),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: cleared ? 'reconciliation.clear' : 'reconciliation.unclear',
        entityType: 'reconciliation',
        entityId: reconciliationId,
        after: { transactionIds: eligibleIds, count: eligibleIds.length },
      },
      tx,
    )
  })

  return { updated: eligibleIds.length }
}

/**
 * Live figures for the session (spec §4: difference calculated in real time).
 */
export async function summarize(
  ctx: ActorContext,
  reconciliationId: string,
): Promise<ReconciliationSummary> {
  requirePermission(ctx, 'reconciliation:view')

  const [session] = await db
    .select()
    .from(reconciliations)
    .where(scoped(ctx, reconciliations, eq(reconciliations.id, reconciliationId)))
    .limit(1)

  if (!session) throw new Error('Reconciliation not found')

  const [cleared] = await db
    .select({
      total: sql<string>`coalesce(sum(${bankTransactions.amountCents}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        eq(bankTransactions.reconciliationId, reconciliationId),
      ),
    )

  const [uncleared] = await db
    .select({ count: sql<string>`count(*)` })
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        eq(bankTransactions.financialAccountId, session.financialAccountId),
        lte(bankTransactions.postedDate, session.statementEndDate),
        isNull(bankTransactions.clearedAt),
        // Excluded transactions are not part of the books, so they are not
        // expected to appear on the statement either.
        sql`${bankTransactions.reviewState} <> 'excluded'`,
      ),
    )

  const clearedTotal = Number(cleared?.total ?? 0)
  const clearedBalanceCents = session.beginningBalanceCents + clearedTotal
  const differenceCents = session.statementEndingBalanceCents - clearedBalanceCents

  return {
    id: session.id,
    financialAccountId: session.financialAccountId,
    statementStartDate: session.statementStartDate,
    statementEndDate: session.statementEndDate,
    statementEndingBalanceCents: session.statementEndingBalanceCents,
    beginningBalanceCents: session.beginningBalanceCents,
    clearedBalanceCents,
    clearedCount: Number(cleared?.count ?? 0),
    unclearedCount: Number(uncleared?.count ?? 0),
    differenceCents,
    isBalanced: differenceCents === 0,
    status: session.status,
  }
}

/**
 * Completes the session and locks its transactions.
 *
 * Refuses unless the difference is exactly zero. Cleared transactions move to
 * the `reconciled` review state, which the bookkeeping service treats as
 * read-only until someone reopens the reconciliation.
 */
export async function completeReconciliation(ctx: ActorContext, reconciliationId: string) {
  requirePermission(ctx, 'reconciliation:perform')

  const summary = await summarize(ctx, reconciliationId)
  if (summary.status !== 'in_progress') {
    throw new Error('That reconciliation is not in progress.')
  }

  if (!summary.isBalanced) {
    throw new Error(
      `Cannot complete: the difference is ${summary.differenceCents} cents. ` +
        'Clear or uncheck transactions until the difference is zero.',
    )
  }

  await db.transaction(async (tx) => {
    await tx
      .update(reconciliations)
      .set({
        status: 'completed',
        clearedBalanceCents: summary.clearedBalanceCents,
        clearedCount: summary.clearedCount,
        completedAt: new Date(),
        completedBy: ctx.userId,
      })
      .where(
        and(
          eq(reconciliations.id, reconciliationId),
          eq(reconciliations.companyId, ctx.companyId),
        ),
      )

    // Locks these rows against further bookkeeping edits.
    await tx
      .update(bankTransactions)
      .set({ reviewState: 'reconciled', updatedAt: new Date() })
      .where(
        and(
          eq(bankTransactions.companyId, ctx.companyId),
          eq(bankTransactions.reconciliationId, reconciliationId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'reconciliation.complete',
        entityType: 'reconciliation',
        entityId: reconciliationId,
        after: {
          clearedBalanceCents: summary.clearedBalanceCents,
          clearedCount: summary.clearedCount,
          statementEndingBalanceCents: summary.statementEndingBalanceCents,
        },
      },
      tx,
    )
  })

  return summary
}

/**
 * Reopens a completed reconciliation (spec §4: controlled reopen).
 *
 * Requires `reconciliation:reopen`, which only accountants and owners hold.
 * The session is marked reopened rather than deleted, and its transactions
 * return to `categorized` so they can be corrected.
 */
export async function reopenReconciliation(ctx: ActorContext, reconciliationId: string) {
  requirePermission(ctx, 'reconciliation:reopen')

  const [session] = await db
    .select()
    .from(reconciliations)
    .where(scoped(ctx, reconciliations, eq(reconciliations.id, reconciliationId)))
    .limit(1)

  if (!session) throw new Error('Reconciliation not found')
  if (session.status !== 'completed') {
    throw new Error('Only a completed reconciliation can be reopened.')
  }

  await db.transaction(async (tx) => {
    await tx
      .update(reconciliations)
      .set({ status: 'reopened', reopenedAt: new Date(), reopenedBy: ctx.userId })
      .where(
        and(
          eq(reconciliations.id, reconciliationId),
          eq(reconciliations.companyId, ctx.companyId),
        ),
      )

    await tx
      .update(bankTransactions)
      .set({ reviewState: 'categorized', updatedAt: new Date() })
      .where(
        and(
          eq(bankTransactions.companyId, ctx.companyId),
          eq(bankTransactions.reconciliationId, reconciliationId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'reconciliation.reopen',
        entityType: 'reconciliation',
        entityId: reconciliationId,
        before: { status: 'completed' },
        after: { status: 'reopened' },
      },
      tx,
    )
  })
}

/**
 * Transactions the session should consider: everything on the account up to
 * the statement end date that is not excluded.
 */
export async function reconcilableTransactions(ctx: ActorContext, reconciliationId: string) {
  requirePermission(ctx, 'reconciliation:view')

  const [session] = await db
    .select()
    .from(reconciliations)
    .where(scoped(ctx, reconciliations, eq(reconciliations.id, reconciliationId)))
    .limit(1)

  if (!session) throw new Error('Reconciliation not found')

  return db
    .select({
      id: bankTransactions.id,
      postedDate: bankTransactions.postedDate,
      description: bankTransactions.description,
      merchantName: bankTransactions.merchantName,
      amountCents: bankTransactions.amountCents,
      reviewState: bankTransactions.reviewState,
      clearedAt: bankTransactions.clearedAt,
      reconciliationId: bankTransactions.reconciliationId,
    })
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        eq(bankTransactions.financialAccountId, session.financialAccountId),
        lte(bankTransactions.postedDate, session.statementEndDate),
        sql`${bankTransactions.reviewState} <> 'excluded'`,
        // Rows cleared by an earlier completed session are already settled, so
        // only unassigned rows and this session's own appear.
        or(
          isNull(bankTransactions.reconciliationId),
          eq(bankTransactions.reconciliationId, reconciliationId),
        ),
      ),
    )
    .orderBy(bankTransactions.postedDate)
}

async function loadOpenSession(ctx: ActorContext, reconciliationId: string) {
  const [session] = await db
    .select()
    .from(reconciliations)
    .where(scoped(ctx, reconciliations, eq(reconciliations.id, reconciliationId)))
    .limit(1)

  if (!session) throw new Error('Reconciliation not found')
  if (session.status === 'completed') {
    throw new Error('That reconciliation is completed. Reopen it before making changes.')
  }

  return session
}

/** Reconciliation history for an account (spec §4: store reports and history). */
export async function reconciliationHistory(ctx: ActorContext, financialAccountId?: string) {
  requirePermission(ctx, 'reconciliation:view')

  return db
    .select()
    .from(reconciliations)
    .where(
      scoped(
        ctx,
        reconciliations,
        financialAccountId
          ? eq(reconciliations.financialAccountId, financialAccountId)
          : undefined,
      ),
    )
    .orderBy(desc(reconciliations.statementEndDate))
}
