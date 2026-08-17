import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  date,
  index,
  unique,
  pgEnum,
  check,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts, financialAccounts } from './accounting'
import { projects } from './crm'
import { costCodes } from './jobs'

/**
 * Where a journal entry came from (spec §13).
 *
 * Most entries are derived from a source document — a bank transaction, an
 * invoice, a payment — rather than typed by hand. Recording the origin is what
 * lets the ledger stay in sync when the source changes, and what makes cash-
 * basis reporting possible.
 */
export const journalSourceEnum = pgEnum('journal_source', [
  'manual',
  'bank_transaction',
  'invoice',
  'bill',
  'payment',
  'adjusting',
  'closing',
  // Phase 9. Payroll and tax remittances are named sources rather than
  // `manual`, so "show me every payroll posting" is a filter rather than a
  // text search through memos.
  'payroll',
  'remittance',
  // Phase 26. A contribution and a release are named for the Phase 9 reason:
  // "show me every donation" and "show me every release of restriction" are
  // the two questions a charity's auditor opens with, and neither should be a
  // text search through memos.
  'contribution',
  'release',
  // Phase 28. A day's takings, so "show me every daily summary" is a filter
  // rather than a text search through memos.
  'takings',
])

/**
 * Entry lifecycle. Posted entries affect the books; draft entries do not.
 * Voided entries stay in the database — accounting integrity calls for
 * reversal over deletion (spec §16).
 */
export const journalStatusEnum = pgEnum('journal_status', ['draft', 'posted', 'void'])

/**
 * A double-entry journal entry (spec §13).
 *
 * The invariant that every entry's debits equal its credits spans rows, so it
 * is enforced in the service layer and covered by tests. Individual lines are
 * still constrained here: a line must be a debit or a credit, never both and
 * never neither.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Sequential per company, assigned at post time. */
    entryNumber: integer('entry_number').notNull(),
    /** The accounting date, which drives which period the entry falls in. */
    entryDate: date('entry_date').notNull(),
    memo: text('memo'),

    source: journalSourceEnum('source').notNull().default('manual'),
    /** Table name of the originating document, when there is one. */
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),

    status: journalStatusEnum('status').notNull().default('posted'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
    /** Set on a reversing entry, pointing at the entry it reverses. */
    reversalOfId: uuid('reversal_of_id').references((): AnyPgColumn => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryNumberUnique: unique('journal_entries_number_unique').on(t.companyId, t.entryNumber),
    // Drives the trial balance and statement queries: company + date range.
    companyDateIdx: index('journal_entries_company_date_idx').on(
      t.companyId,
      t.status,
      t.entryDate,
    ),
    // Finds the entry derived from a given source document.
    sourceIdx: index('journal_entries_source_idx').on(t.companyId, t.sourceType, t.sourceId),
  }),
)

/**
 * One line of a journal entry.
 *
 * Debits and credits are separate non-negative columns rather than one signed
 * amount. That is the form accountants read, it makes the trial balance a
 * direct sum of two columns, and it removes any ambiguity about what a
 * negative number would have meant on a credit-normal account.
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),

    /** Minor units, never negative. Exactly one of the two is non-zero. */
    debitCents: bigint('debit_cents', { mode: 'number' }).notNull().default(0),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),

    /**
     * Accounting dimension (spec §13). A project is also the job a won
     * proposal creates (spec §6), so one record serves both — which is why
     * this is the same `projects` table the CRM uses.
     */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),

    /**
     * The second accounting dimension, added in Phase 7 (spec §5 job costing).
     *
     * Job cost reporting is a `GROUP BY` over these two columns — not a
     * separate cost ledger. That is what spec §20's "without forking the core
     * ledger" means concretely: a job's costs and the trial balance are sums
     * over the same rows, so they cannot disagree.
     */
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),

    memo: text('memo'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryIdx: index('journal_lines_entry_idx').on(t.journalEntryId),
    projectIdx: index('journal_lines_project_idx').on(t.companyId, t.projectId),
    costCodeIdx: index('journal_lines_cost_code_idx').on(t.companyId, t.costCodeId),
    // A cost code says which part of *a job* the money went to, so one without
    // a job is not a partial answer — it is an unanswerable one.
    costCodeNeedsProject: check(
      'journal_lines_cost_code_needs_project',
      sql`${t.costCodeId} IS NULL OR ${t.projectId} IS NOT NULL`,
    ),
    // Drives the general ledger and account balances.
    accountIdx: index('journal_lines_account_idx').on(t.companyId, t.chartAccountId),
    // A line is a debit or a credit — never both, never neither, never negative.
    sideCheck: check(
      'journal_lines_single_side',
      sql`${t.debitCents} >= 0 AND ${t.creditCents} >= 0
          AND (${t.debitCents} = 0) <> (${t.creditCents} = 0)`,
    ),
  }),
)

/**
 * A closed accounting period (spec §13, §14).
 *
 * Only closed periods get a row. An entry dated inside one cannot be created,
 * changed, or voided until someone with reopen permission lifts the close —
 * which is recorded rather than erased.
 */
export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    /** 'closed' blocks changes; 'reopened' keeps the history but lifts the block. */
    status: text('status', { enum: ['closed', 'reopened'] })
      .notNull()
      .default('closed'),
    notes: text('notes'),

    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    companyIdx: index('accounting_periods_company_idx').on(t.companyId, t.periodEnd),
  }),
)

/**
 * A reconciliation session for one bank or credit-card account (spec §4).
 *
 * Completion requires the difference to be exactly zero, so a stored
 * reconciliation is always a statement that the books agreed with the bank on
 * that date.
 */
export const reconciliations = pgTable(
  'reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    financialAccountId: uuid('financial_account_id').notNull(),

    statementStartDate: date('statement_start_date').notNull(),
    statementEndDate: date('statement_end_date').notNull(),
    /** Taken from the bank statement, in minor units. */
    statementEndingBalanceCents: bigint('statement_ending_balance_cents', {
      mode: 'number',
    }).notNull(),
    /** Ending balance of the previous completed reconciliation, or zero. */
    beginningBalanceCents: bigint('beginning_balance_cents', { mode: 'number' })
      .notNull()
      .default(0),

    status: text('status', { enum: ['in_progress', 'completed', 'reopened'] })
      .notNull()
      .default('in_progress'),
    /** Snapshot written at completion, so the stored report is stable. */
    clearedBalanceCents: bigint('cleared_balance_cents', { mode: 'number' }),
    clearedCount: integer('cleared_count'),

    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index('reconciliations_account_idx').on(
      t.companyId,
      t.financialAccountId,
      t.statementEndDate,
    ),
    // Named explicitly: the generated name would exceed Postgres's 63-byte limit.
    financialAccountFk: foreignKey({
      name: 'reconciliations_financial_account_fk',
      columns: [t.financialAccountId],
      foreignColumns: [financialAccounts.id],
    }).onDelete('cascade'),
  }),
)
