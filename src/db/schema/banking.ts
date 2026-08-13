import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigint,
  integer,
  date,
  jsonb,
  unique,
  index,
  pgEnum,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { companies } from './tenancy'
import { chartAccounts, financialAccounts } from './accounting'
import { reconciliations } from './ledger'
import { projects } from './crm'
import { costCodes } from './jobs'

/** Review states enumerated in spec §3. */
export const reviewStateEnum = pgEnum('review_state', [
  'new',
  'suggested',
  'needs_review',
  'categorized',
  'matched',
  'excluded',
  'reconciled',
])

export const connectionStatusEnum = pgEnum('connection_status', [
  'active',
  'needs_reauth',
  'error',
  'disconnected',
])

/**
 * A link to an institution through an aggregation provider. `provider` names
 * the adapter (spec §3 requires the vendor be swappable), and no bank
 * credentials are ever stored here — only the provider's opaque item id
 * (spec §19).
 */
export const bankConnections = pgTable(
  'bank_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Adapter key, e.g. "mock" or "plaid". */
    provider: text('provider').notNull(),
    /** Opaque provider handle. Tokenized — never a bank login. */
    providerItemId: text('provider_item_id').notNull(),
    institutionName: text('institution_name').notNull(),
    status: connectionStatusEnum('status').notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Provider cursor for incremental sync. */
    syncCursor: text('sync_cursor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('bank_connections_company_idx').on(t.companyId),
    providerItemUnique: unique('bank_connections_provider_item_unique').on(
      t.companyId,
      t.provider,
      t.providerItemId,
    ),
  }),
)

/**
 * An imported bank transaction — the raw feed record, not a ledger entry.
 *
 * Dedup (spec §3, §19) rests on the unique constraint over
 * (companyId, financialAccountId, providerTransactionId): the provider's id is
 * immutable, so re-importing the same window is a no-op at the database level
 * rather than something application code has to remember to check.
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    financialAccountId: uuid('financial_account_id').notNull(),
    /** Immutable identifier from the provider. Never regenerated. */
    providerTransactionId: text('provider_transaction_id').notNull(),
    postedDate: date('posted_date').notNull(),
    /**
     * Signed minor units (cents). Negative = money leaving the account
     * (spend), positive = money arriving (deposit). Integer arithmetic only.
     */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    merchantName: text('merchant_name'),
    /** Provider-supplied category hint. Advisory only — never auto-posted. */
    providerCategory: text('provider_category'),
    pending: boolean('pending').notNull().default(false),

    reviewState: reviewStateEnum('review_state').notNull().default('new'),
    /**
     * Assigned GL account. Null while uncategorized. When the transaction is
     * split this stays null and the splits carry the accounts.
     */
    chartAccountId: uuid('chart_account_id').references(() => chartAccounts.id, {
      onDelete: 'restrict',
    }),
    /**
     * Job costing dimensions (spec §5, Phase 7). Carried on the transaction so
     * the person coding a card purchase for lumber assigns it to a job at the
     * same moment they assign it to an account — the derived journal entry
     * copies both onto its lines.
     */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),

    /** Rule that produced the current categorization, when one did. */
    appliedRuleId: uuid('applied_rule_id'),
    /** True once splits exist; `chartAccountId` is then meaningless. */
    isSplit: boolean('is_split').notNull().default(false),

    /** Transfer identification (spec §3). */
    isTransfer: boolean('is_transfer').notNull().default(false),
    transferPairId: uuid('transfer_pair_id').references((): AnyPgColumn => bankTransactions.id, {
      onDelete: 'set null',
    }),

    excludeReason: text('exclude_reason'),
    notes: text('notes'),

    /**
     * Reconciliation (spec §4). `clearedAt` marks the transaction as seen on a
     * statement; `reconciliationId` binds it to the session that cleared it.
     *
     * There is deliberately no journal-entry column here. The derived entry is
     * found through `journal_entries.source_type/source_id`, so the link lives
     * in one place and cannot drift out of sync.
     */
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    // Nulled rather than cascaded if a reconciliation is ever removed: the
    // transaction outlives the session that cleared it.
    reconciliationId: uuid('reconciliation_id').references(() => reconciliations.id, {
      onDelete: 'set null',
    }),
    /** Receipt/document references (spec §3). */
    attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
    /** Untouched provider payload, kept for audit and re-processing. */
    raw: jsonb('raw').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The dedup guarantee.
    dedupUnique: unique('bank_transactions_dedup_unique').on(
      t.companyId,
      t.financialAccountId,
      t.providerTransactionId,
    ),
    // Named explicitly: the generated name would exceed Postgres's 63-byte
    // identifier limit and be silently truncated.
    financialAccountFk: foreignKey({
      name: 'bank_transactions_financial_account_fk',
      columns: [t.financialAccountId],
      foreignColumns: [financialAccounts.id],
    }).onDelete('cascade'),
    // Drives the inbox query: company + state, newest first.
    inboxIdx: index('bank_transactions_inbox_idx').on(t.companyId, t.reviewState, t.postedDate),
    accountIdx: index('bank_transactions_account_idx').on(t.financialAccountId, t.postedDate),
  }),
)

export type Attachment = {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  storageKey: string
  uploadedAt: string
}

/**
 * One leg of a split transaction (spec §3). The split amounts must sum to the
 * parent transaction's amount; enforced in the service layer and covered by
 * tests, because the invariant spans rows.
 */
export const transactionSplits = pgTable(
  'transaction_splits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => bankTransactions.id, { onDelete: 'cascade' }),
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    /** Signed cents, same sign convention as the parent transaction. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Per-split job costing, so one card purchase can span two jobs. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),
    memo: text('memo'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    transactionIdx: index('transaction_splits_transaction_idx').on(t.transactionId),
  }),
)
