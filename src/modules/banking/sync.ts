import { and, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  bankConnections,
  bankTransactions,
  chartAccounts,
  financialAccounts,
} from '@/db/schema'
import { newBatchId, recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { accountByNumber } from '@/modules/coa/service'
import { applyRulesToNewTransactions } from '@/modules/bookkeeping/rules-engine'
import { getBankProvider } from './registry'
import type { ProviderAccount, ProviderTransaction } from './provider'

export type ImportSummary = {
  connectionId: string
  /** Rows actually written. */
  imported: number
  /** Rows skipped because the provider id was already present. */
  duplicates: number
  /** Of the imported rows, how many a rule categorized or suggested for. */
  autoCategorized: number
  suggested: number
}

/**
 * Connects an institution and imports its history.
 *
 * The link/exchange handshake is the provider's business; everything after it
 * is vendor-neutral.
 */
export async function connectInstitution(
  ctx: ActorContext,
  opts: { publicToken: string; providerKey?: string },
): Promise<{ connectionId: string; accountsCreated: number }> {
  requirePermission(ctx, 'bookkeeping:import')

  const provider = getBankProvider(opts.providerKey)
  const exchanged = await provider.exchangePublicToken(opts.publicToken)
  const providerAccounts = await provider.listAccounts(exchanged.providerItemId)

  return db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(bankConnections)
      .values({
        companyId: ctx.companyId,
        provider: provider.key,
        providerItemId: exchanged.providerItemId,
        institutionName: exchanged.institutionName,
        status: 'active',
      })
      .returning()

    const accountsCreated = await createFinancialAccounts(
      ctx.companyId,
      connection.id,
      providerAccounts,
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'account.create',
        entityType: 'bank_connection',
        entityId: connection.id,
        after: {
          institution: connection.institutionName,
          provider: provider.key,
          accounts: accountsCreated,
        },
      },
      tx,
    )

    return { connectionId: connection.id, accountsCreated }
  })
}

/**
 * Maps provider accounts onto financial accounts, each pointing at a suitable
 * GL account. Credit cards post to the card liability, everything else to the
 * default checking asset.
 */
async function createFinancialAccounts(
  companyId: string,
  connectionId: string,
  providerAccounts: ProviderAccount[],
  exec: Executor,
): Promise<number> {
  const checking = await accountByNumber(companyId, SYSTEM_ACCOUNTS.defaultChecking, exec)
  const card = await accountByNumber(companyId, SYSTEM_ACCOUNTS.defaultCreditCard, exec)

  if (!checking || !card) {
    throw new Error(
      'Chart of accounts is not installed for this company. Run onboarding before connecting a bank.',
    )
  }

  const existing = await exec
    .select({ providerAccountId: financialAccounts.providerAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.companyId, companyId))

  const known = new Set(existing.map((row) => row.providerAccountId))
  const pending = providerAccounts.filter((a) => !known.has(a.providerAccountId))
  if (pending.length === 0) return 0

  await exec.insert(financialAccounts).values(
    pending.map((account) => ({
      companyId,
      bankConnectionId: connectionId,
      chartAccountId: account.kind === 'credit_card' ? card.id : checking.id,
      name: account.name,
      mask: account.mask ?? null,
      kind: account.kind,
      currency: account.currency,
      currentBalanceCents: account.currentBalanceCents,
      availableBalanceCents: account.availableBalanceCents ?? null,
      providerAccountId: account.providerAccountId,
    })),
  )

  return pending.length
}

/**
 * Pulls transactions for a connection and imports them.
 *
 * Idempotent by construction (spec §3, §19): the insert is guarded by the
 * unique index on (companyId, financialAccountId, providerTransactionId) via
 * ON CONFLICT DO NOTHING, so running this twice over the same window is safe
 * even under concurrency — two simultaneous syncs cannot both win the race.
 */
export async function syncConnection(
  ctx: ActorContext,
  connectionId: string,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<ImportSummary> {
  requirePermission(ctx, 'bookkeeping:import')

  const [connection] = await db
    .select()
    .from(bankConnections)
    .where(scoped(ctx, bankConnections, eq(bankConnections.id, connectionId)))
    .limit(1)

  if (!connection) throw new Error('Bank connection not found')

  const provider = getBankProvider(connection.provider)
  const page = await provider.fetchTransactions(connection.providerItemId, {
    cursor: connection.syncCursor ?? undefined,
    startDate: opts.startDate,
    endDate: opts.endDate,
  })

  const accounts = await db
    .select()
    .from(financialAccounts)
    .where(
      and(
        eq(financialAccounts.companyId, ctx.companyId),
        eq(financialAccounts.bankConnectionId, connectionId),
      ),
    )

  const accountByProviderId = new Map(
    accounts.map((account) => [account.providerAccountId, account]),
  )

  const summary = await importTransactions(ctx, {
    connectionId,
    transactions: page.transactions,
    accountByProviderId,
  })

  await db
    .update(bankConnections)
    .set({ lastSyncedAt: new Date(), syncCursor: page.nextCursor ?? null })
    .where(scoped(ctx, bankConnections, eq(bankConnections.id, connectionId)))

  return summary
}

/**
 * Writes provider transactions into the inbox, then runs the rules engine over
 * whatever was newly inserted.
 */
export async function importTransactions(
  ctx: ActorContext,
  input: {
    connectionId: string
    transactions: ProviderTransaction[]
    accountByProviderId: Map<string | null, { id: string }>
  },
): Promise<ImportSummary> {
  const batchId = newBatchId()

  const rows = input.transactions
    .map((transaction) => {
      const account = input.accountByProviderId.get(transaction.providerAccountId)
      // A transaction for an account the user did not import is skipped rather
      // than guessed at.
      if (!account) return null

      return {
        companyId: ctx.companyId,
        financialAccountId: account.id,
        providerTransactionId: transaction.providerTransactionId,
        postedDate: transaction.postedDate,
        amountCents: transaction.amountCents,
        description: transaction.description,
        merchantName: transaction.merchantName ?? null,
        providerCategory: transaction.category ?? null,
        pending: transaction.pending,
        raw: transaction.raw ?? null,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  if (rows.length === 0) {
    return {
      connectionId: input.connectionId,
      imported: 0,
      duplicates: 0,
      autoCategorized: 0,
      suggested: 0,
    }
  }

  // ON CONFLICT DO NOTHING makes the database the arbiter of duplicates, so
  // the guarantee holds regardless of what the caller does.
  const inserted = await db
    .insert(bankTransactions)
    .values(rows)
    .onConflictDoNothing({
      target: [
        bankTransactions.companyId,
        bankTransactions.financialAccountId,
        bankTransactions.providerTransactionId,
      ],
    })
    .returning({ id: bankTransactions.id })

  const insertedIds = inserted.map((row) => row.id)

  const ruleResult =
    insertedIds.length > 0
      ? await applyRulesToNewTransactions(ctx, insertedIds, batchId)
      : { autoCategorized: 0, suggested: 0 }

  if (insertedIds.length > 0) {
    await recordAudit(ctx, {
      action: 'transaction.import',
      entityType: 'bank_connection',
      entityId: input.connectionId,
      batchId,
      after: {
        imported: insertedIds.length,
        duplicates: rows.length - insertedIds.length,
        autoCategorized: ruleResult.autoCategorized,
        suggested: ruleResult.suggested,
      },
    })
  }

  return {
    connectionId: input.connectionId,
    imported: insertedIds.length,
    duplicates: rows.length - insertedIds.length,
    autoCategorized: ruleResult.autoCategorized,
    suggested: ruleResult.suggested,
  }
}

/** Bank/card accounts for the company, for inbox filters and account pickers. */
export async function listFinancialAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select({
      id: financialAccounts.id,
      name: financialAccounts.name,
      mask: financialAccounts.mask,
      kind: financialAccounts.kind,
      currentBalanceCents: financialAccounts.currentBalanceCents,
      currency: financialAccounts.currency,
      chartAccountName: chartAccounts.name,
    })
    .from(financialAccounts)
    .innerJoin(chartAccounts, eq(chartAccounts.id, financialAccounts.chartAccountId))
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.isActive, true)))
    .orderBy(financialAccounts.name)
}

/** Connections for the company. */
export async function listConnections(ctx: ActorContext) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select()
    .from(bankConnections)
    .where(scoped(ctx, bankConnections))
    .orderBy(bankConnections.createdAt)
}

/** Loads transactions by id within the tenant. Foreign ids drop out. */
export async function transactionsByIds(ctx: ActorContext, ids: string[]) {
  if (ids.length === 0) return []
  return db
    .select()
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions, inArray(bankTransactions.id, ids)))
}
