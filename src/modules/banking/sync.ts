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
import { mintChartAccount } from './accounts'
import { getBankProvider } from './registry'
import { recordRevisions } from './revision-service'
import { decryptSecret, encryptSecret } from '@/modules/auth/secret-box'
import type { ProviderAccount, ProviderTransaction } from './provider'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

export type ImportSummary = {
  connectionId: string
  /** Rows actually written. */
  imported: number
  /** Rows skipped because the provider id was already present. */
  duplicates: number
  /** Of the imported rows, how many a rule categorized or suggested for. */
  autoCategorized: number
  suggested: number
  /**
   * What the feed changed about transactions it had already sent (Phase 177).
   *
   * `duplicates` used to be the whole story about a re-sent transaction, and it
   * was the wrong story: a provider that revises a pending transaction into a
   * posted one was counted as a duplicate and dropped. These three split that
   * count into what actually happened.
   */
  revisionsApplied: number
  /** Recorded and not applied, because something was derived from the stored row. */
  revisionsHeld: number
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

  /*
    The credential travels with the id and is never separated from it
    (Phase 176). `ProviderConnection` exists so a caller cannot pass the id of
    one connection and the credential of another, which the type system can
    prevent and a second positional argument could not.
  */
  const handle = {
    providerItemId: exchanged.providerItemId,
    credential: exchanged.credential,
  }

  const providerAccounts = await provider.listAccounts(handle)

  return db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(bankConnections)
      .values({
        companyId: ctx.companyId,
        provider: provider.key,
        providerItemId: exchanged.providerItemId,
        institutionName: exchanged.institutionName,
        status: 'active',
        /*
          Encrypted on the way in, with the envelope that protects TOTP seeds.
          A Plaid `access_token` is a long-lived bearer credential for the whole
          of a business's banking history, and §19 requires it encrypted at
          rest — a leaked database without this is embarrassing and with it is a
          disclosure.

          `null` rather than an empty string when the adapter issues none, so
          "needs no credential" and "has an empty one" stay distinguishable.
        */
        credentialCipher: exchanged.credential ? encryptSecret(exchanged.credential) : null,
      })
      .returning()

    const accountsCreated = await createFinancialAccounts(
      ctx,
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
 * Maps provider accounts onto financial accounts, each with a ledger account
 * of its own.
 *
 * This used to point every account that was not a credit card at `1000
 * Checking Account`, so a business with a current account and a deposit
 * account had one balance-sheet line covering both — and the ledger could not
 * say what either held, which is the only question a bank statement asks. Each
 * account now gets its own line, in the band its kind belongs to
 * (`numbering.ts`), and the first of each kind lands on the number the
 * standard chart already names.
 */
async function createFinancialAccounts(
  ctx: ActorContext,
  connectionId: string,
  providerAccounts: ProviderAccount[],
  exec: Executor,
): Promise<number> {
  const companyId = ctx.companyId

  // Still checked, because a company with no chart at all is a company that
  // was not onboarded, and the error should say that rather than surfacing as
  // a numbering surprise later.
  const checking = await accountByNumber(companyId, SYSTEM_ACCOUNTS.defaultChecking, exec)
  if (!checking) {
    throw new Refusal(
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

  // One at a time rather than one bulk insert: each needs its own ledger
  // account, and the number for the second depends on the first having taken
  // one.
  for (const account of pending) {
    const mask = account.mask ?? null
    const chartAccountId = await mintChartAccount(
      ctx,
      { name: account.name, mask, kind: account.kind },
      exec,
    )

    await exec.insert(financialAccounts).values({
      companyId,
      bankConnectionId: connectionId,
      chartAccountId,
      name: account.name,
      mask,
      kind: account.kind,
      currency: account.currency,
      currentBalanceCents: account.currentBalanceCents,
      availableBalanceCents: account.availableBalanceCents ?? null,
      providerAccountId: account.providerAccountId,
    })
  }

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

  if (!connection) throw missing('bankConnection')

  const provider = getBankProvider(connection.provider)

  /*
    Decrypted here and not stored in this shape. The plaintext exists for the
    length of one provider call, which is the narrowest window the flow allows:
    the adapter needs it to authenticate and nothing else in the request does.
  */
  const page = await provider.fetchTransactions(
    {
      providerItemId: connection.providerItemId,
      credential: connection.credentialCipher
        ? decryptSecret(connection.credentialCipher)
        : undefined,
    },
    {
      cursor: connection.syncCursor ?? undefined,
      startDate: opts.startDate,
      endDate: opts.endDate,
    },
  )

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

  /*
    Kept so a transaction the insert declined can be compared against what is
    stored (Phase 177). Keyed by the dedup key's own two columns, because the
    same provider id on two accounts is two transactions.
  */
  const incomingByKey = new Map<string, ProviderTransaction>()

  const rows = input.transactions
    .map((transaction) => {
      const account = input.accountByProviderId.get(transaction.providerAccountId)
      // A transaction for an account the user did not import is skipped rather
      // than guessed at.
      if (!account) return null

      incomingByKey.set(`${account.id}:${transaction.providerTransactionId}`, transaction)

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
      revisionsApplied: 0,
      revisionsHeld: 0,
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
    .returning({
      id: bankTransactions.id,
      financialAccountId: bankTransactions.financialAccountId,
      providerTransactionId: bankTransactions.providerTransactionId,
    })

  const insertedIds = inserted.map((row) => row.id)

  /*
    Whatever the insert declined, the provider had already sent — and that is the
    set to compare, whatever the provider *called* them (Phase 177). Plaid's own
    `added`/`modified` split is deliberately not consulted: a provider may
    re-send an `added` transaction, and comparing content is right whether or not
    the label is.

    `onConflictDoNothing` is kept exactly as it was, so the dedup guarantee this
    function has carried since Phase 1 does not move. What changes is that
    "declined" stops being the end of the story.
  */
  for (const row of inserted) {
    incomingByKey.delete(`${row.financialAccountId}:${row.providerTransactionId}`)
  }

  const revisions = await recordRevisions(ctx, {
    connectionId: input.connectionId,
    incoming: incomingByKey,
  })

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
    revisionsApplied: revisions.applied,
    revisionsHeld: revisions.held,
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
