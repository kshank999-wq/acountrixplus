import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  unique,
  check,
  foreignKey,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'
import { journalEntries } from './ledger'

/**
 * Recurring entries and the year-end close (spec §13: "recurring entries,
 * adjusting entries, and **closing entries**").
 *
 * Both were listed in §13 from the beginning and both needed something that
 * did not exist until Phase 10 — a recurring entry is a template plus a clock,
 * and without the clock it is a template nobody uses.
 */

export const recurringCadenceEnum = pgEnum('recurring_cadence', [
  'weekly',
  'monthly',
  'quarterly',
  'annually',
])

/**
 * A journal entry that repeats.
 *
 * ## Why a template stores lines rather than an entry to copy
 *
 * Copying a previous entry would carry its date, its number, and its
 * relationship to a closed period. A template is the *intent* — these accounts,
 * these amounts, this memo — and each occurrence is a fresh entry that goes
 * through the same validation as one somebody typed.
 */
export const recurringEntries = pgTable(
  'recurring_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    memo: text('memo'),

    cadence: recurringCadenceEnum('cadence').notNull(),
    /** 1–28. Capped so "the 31st" cannot silently mean "sometimes". */
    dayOfMonth: integer('day_of_month').notNull().default(1),

    /**
     * Whether an occurrence posts straight away or waits for a person.
     *
     * The distinction Phase 10 drew for the WIP entry, applied here: a monthly
     * rent accrual is the same every month and safe to post; an estimate that
     * changes with the weather is not, and a template that posts one anyway is
     * how a ledger fills with numbers nobody checked.
     */
    autoPost: boolean('auto_post').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),

    startsOn: date('starts_on').notNull(),
    /** Optional. A rent accrual for a lease that ends should end with it. */
    endsOn: date('ends_on'),

    lastRunOn: date('last_run_on'),
    nextRunOn: date('next_run_on').notNull(),
    occurrenceCount: integer('occurrence_count').notNull().default(0),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('recurring_entries_due_idx').on(t.companyId, t.isActive, t.nextRunOn),
    nameUnique: unique('recurring_entries_name_unique').on(t.companyId, t.name),
    dayRange: check(
      'recurring_entries_day_range',
      sql`${t.dayOfMonth} >= 1 AND ${t.dayOfMonth} <= 28`,
    ),
    endsAfterStart: check(
      'recurring_entries_ends_after_start',
      sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`,
    ),
  }),
)

export const recurringEntryLines = pgTable(
  'recurring_entry_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    recurringEntryId: uuid('recurring_entry_id').notNull(),

    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),

    debitCents: bigint('debit_cents', { mode: 'number' }).notNull().default(0),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    memo: text('memo'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    // Named explicitly — the generated name is 64 bytes and Postgres truncates
    // rather than refusing, leaving a constraint nobody can predict the name of.
    entryFk: foreignKey({
      name: 'recurring_entry_lines_entry_fk',
      columns: [t.recurringEntryId],
      foreignColumns: [recurringEntries.id],
    }).onDelete('cascade'),
    entryIdx: index('recurring_entry_lines_entry_idx').on(t.recurringEntryId),
    // One side only, exactly as `journal_lines` requires. The template is
    // validated by the same rule as the entries it produces, so a template
    // cannot be saved in a shape that would fail every time it fired.
    oneSided: check(
      'recurring_entry_lines_one_sided',
      sql`(${t.debitCents} = 0) <> (${t.creditCents} = 0)`,
    ),
    nonNegative: check(
      'recurring_entry_lines_non_negative',
      sql`${t.debitCents} >= 0 AND ${t.creditCents} >= 0`,
    ),
  }),
)

/** Which occurrence produced which entry, so a template's history is visible. */
export const recurringOccurrences = pgTable(
  'recurring_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    recurringEntryId: uuid('recurring_entry_id').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    occurredOn: date('occurred_on').notNull(),
    wasPosted: boolean('was_posted').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One occurrence per template per date, forever. The scheduler runs at
    // least once (Phase 10), so this is what makes firing twice harmless.
    entryFk: foreignKey({
      name: 'recurring_occurrences_entry_fk',
      columns: [t.recurringEntryId],
      foreignColumns: [recurringEntries.id],
    }).onDelete('cascade'),
    occurrenceUnique: unique('recurring_occurrences_unique').on(t.recurringEntryId, t.occurredOn),
    entryIdx: index('recurring_occurrences_entry_idx').on(t.recurringEntryId),
  }),
)

/**
 * A closed financial year.
 *
 * ## What closing actually does
 *
 * Revenue and expense accounts are period accounts: they measure a year and
 * then start again. Closing is the entry that empties them into Retained
 * Earnings, so the next year opens from zero and the accumulated result lives
 * where the balance sheet expects it.
 *
 * The balance sheet has anticipated this since Phase 2 — it shows current
 * earnings as a separate equity line precisely because closing entries "have
 * not been written yet at the time this report is run". Once a year is closed,
 * that line is empty for it, because the entry moved it.
 */
export const fiscalYearCloses = pgTable(
  'fiscal_year_closes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** The last day of the year being closed. */
    closingDate: date('closing_date').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),

    netIncomeCents: bigint('net_income_cents', { mode: 'number' }).notNull(),
    revenueCents: bigint('revenue_cents', { mode: 'number' }).notNull(),
    expenseCents: bigint('expense_cents', { mode: 'number' }).notNull(),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    /** What was known to be wrong when it was closed, frozen alongside. */
    exceptions: jsonb('exceptions').$type<unknown[]>().notNull().default([]),

    /** Set when reopened, with the reason. A close is undoable and recorded. */
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenReason: text('reopen_reason'),

    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One open close per year. Closing twice would double the transfer to
    // retained earnings, which is the single worst thing this table could let
    // happen — so the database refuses rather than a check somebody races.
    yearUnique: unique('fiscal_year_closes_year_unique').on(t.companyId, t.fiscalYear),
    companyIdx: index('fiscal_year_closes_company_idx').on(t.companyId, t.closingDate),
  }),
)
