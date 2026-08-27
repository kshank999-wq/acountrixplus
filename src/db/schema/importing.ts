import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  index,
  pgEnum,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'
import { journalEntries } from './ledger'

/**
 * Bringing an existing business's books in (spec §20 Phase 8).
 *
 * A company that has been trading for six years does not adopt a new
 * accounting system by starting from zero — it brings its chart, its
 * customers, what it owes and is owed, and the balances that make those
 * figures true. Until this existed, the only company that could use
 * Accountrix Plus was one that had never traded.
 */

export const importKindEnum = pgEnum('import_kind', [
  'chart_of_accounts',
  'customers',
  'vendors',
  'trial_balance',
  'open_invoices',
  'open_bills',
  /**
   * A downloaded bank statement (Phase 39).
   *
   * Unlike the others, this one imports into a *feed* rather than the ledger:
   * rows land in the transaction inbox exactly where a bank connection would
   * have put them, and nothing posts until somebody categorises them. So a
   * reversal removes uncategorised rows and refuses once they carry entries,
   * which is the same rule the other kinds follow for a different reason.
   */
  'bank_statement',
])

export const importStatusEnum = pgEnum('import_status', [
  /** Written and in effect. */
  'committed',
  /** Undone. The rows and entries it made are gone or reversed. */
  'reverted',
])

/**
 * One file, imported once.
 *
 * The run is kept whether or not it is later reverted, because "where did
 * these four hundred customers come from" is a question somebody asks, and
 * "an import on the 3rd, by Dana, from customers.csv" is the answer.
 */
export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    kind: importKindEnum('kind').notNull(),
    status: importStatusEnum('status').notNull().default('committed'),

    /** What the user called the file. For the history list, nothing else. */
    fileName: text('file_name'),
    /** The header row as it arrived, so a later reader can see what was mapped. */
    headers: text('headers'),
    /** JSON: which of our fields each column was read as. */
    columnMapping: text('column_mapping'),

    rowCount: integer('row_count').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),

    /** Total value the run moved, where that means anything. */
    totalCents: bigint('total_cents', { mode: 'number' }),

    /** The opening-balance entry, for a trial balance import. */
    journalEntryId: uuid('journal_entry_id'),

    /**
     * What the trial balance said the control accounts were, for the two
     * accounts it deliberately does not post (see `opening-balances.ts`).
     *
     * Kept because they are the only figures that can answer "does the
     * customer detail agree with the receivables balance the old system
     * reported" — the control account itself is built from the detail, so
     * comparing it to the detail is vacuous.
     */
    receivableControlCents: bigint('receivable_control_cents', { mode: 'number' }),
    payableControlCents: bigint('payable_control_cents', { mode: 'number' }),

    /** JSON: warnings kept for the record. Errors never get this far. */
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBy: uuid('reverted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    companyIdx: index('import_runs_company_idx').on(t.companyId, t.createdAt),
    kindIdx: index('import_runs_kind_idx').on(t.companyId, t.kind, t.status),
    // Named explicitly to stay inside Postgres's 63-byte identifier limit.
    entryFk: foreignKey({
      name: 'import_runs_journal_fk',
      columns: [t.journalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete('set null'),
  }),
)

/**
 * One thing an import created, so the import can be undone.
 *
 * ## Why a record per row rather than a timestamp range
 *
 * "Delete everything created between 14:32:01 and 14:32:09" catches whatever
 * else happened to be created in those eight seconds — an invoice somebody
 * raised in another tab, a customer added on a phone. A bulk write is the
 * highest-stakes operation in the application and its undo has to be exact,
 * so each row is named.
 *
 * `updated` rows are recorded too, and deliberately **not** reverted: an
 * account that already existed and had its name corrected by an import is not
 * the import's to delete, and restoring the old name would undo a correction
 * somebody may have since built on. Reversal says so rather than guessing.
 */
export const importRecords = pgTable(
  'import_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    importRunId: uuid('import_run_id')
      .notNull()
      .references(() => importRuns.id, { onDelete: 'cascade' }),

    /** `chart_account`, `customer`, `vendor`, `invoice`, `bill`, `bank_transaction`. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** `created` or `updated`. Only `created` rows are reversible. */
    action: text('action').notNull(),
    /** 1-based line in the source file, for tracing a row back. */
    sourceRow: integer('source_row'),
  },
  (t) => ({
    runIdx: index('import_records_run_idx').on(t.importRunId),
    entityIdx: index('import_records_entity_idx').on(t.companyId, t.entityType, t.entityId),
  }),
)
