import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  integer,
  bigint,
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
import { customers, invoices } from './receivables'
import { journalEntries } from './ledger'

/**
 * Credit notes and write-offs (spec §13: "customers, invoices, **credits**,
 * payments, aging, statements, **write-offs**").
 *
 * ## Two things that look alike and are not
 *
 * Both reduce what a customer owes without money arriving, which is why
 * software conflates them constantly. They mean opposite things:
 *
 * | | Credit note | Write-off |
 * | --- | --- | --- |
 * | What happened | The company agreed they owe less | They owe it and will not pay |
 * | Revenue | Reversed — it was never earned | Kept — it was earned and lost |
 * | The other side | Revenue (or contra-revenue) | Bad Debt expense |
 * | On a P&L | Revenue goes down | Expense goes up |
 *
 * A company that writes off bad debt as a credit note shows lower revenue and
 * no bad debt, so its margins look fine and its collections problem is
 * invisible. That is the failure this separation exists to prevent, and it is
 * why a write-off is an operation on an invoice rather than a kind of credit
 * note.
 */

export const creditNoteStatusEnum = pgEnum('credit_note_status', [
  'draft',
  /** Issued, with some or all of it not yet applied to an invoice. */
  'open',
  'applied',
  'void',
])

/**
 * A credit issued to a customer.
 *
 * Mirrors an invoice deliberately — lines against revenue accounts, a journal
 * entry, a number from the same sequence machinery. A credit note *is* a
 * source document, and giving it a lesser shape than the invoice it reverses
 * would make it the odd one out in every report that walks documents.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    number: text('number').notNull(),
    issueDate: date('issue_date').notNull(),

    /**
     * The invoice this was raised against, when there is one.
     *
     * Optional because a credit can be issued standalone — a goodwill gesture
     * before the next invoice exists. When set, the lines default to that
     * invoice's accounts so the reversal lands where the revenue did.
     */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),

    status: creditNoteStatusEnum('status').notNull().default('open'),

    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    /** How much of it is still available to apply. */
    remainingCents: bigint('remaining_cents', { mode: 'number' }).notNull().default(0),

    reason: text('reason'),
    memo: text('memo'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('credit_notes_number_unique').on(t.companyId, t.number),
    customerIdx: index('credit_notes_customer_idx').on(t.companyId, t.customerId),
    openIdx: index('credit_notes_open_idx').on(t.companyId, t.status),
    totalPositive: check('credit_notes_total_positive', sql`${t.totalCents} > 0`),
    // A credit note's amounts are stored positive and its *direction* is what
    // makes it a credit. Storing a negative invoice instead would mean every
    // aggregate in the system needing to know the sign convention.
    remainingSane: check(
      'credit_notes_remaining_sane',
      sql`${t.remainingCents} >= 0 AND ${t.remainingCents} <= ${t.totalCents}`,
    ),
  }),
)

export const creditNoteLines = pgTable(
  'credit_note_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),

    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),

    description: text('description').notNull(),
    quantityMilli: integer('quantity_milli').notNull().default(1000),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    noteIdx: index('credit_note_lines_note_idx').on(t.creditNoteId),
  }),
)

/**
 * Applying part of a credit note to an invoice.
 *
 * The same shape as `payment_applications`, and for the same reason: one
 * credit can settle several invoices and one invoice can be settled by several
 * credits. It also means the cash-basis transformation has a single
 * consistent way to ask "what reduced this invoice, and against what".
 */
export const creditApplications = pgTable(
  'credit_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),

    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedOn: date('applied_on').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    noteIdx: index('credit_applications_note_idx').on(t.creditNoteId),
    invoiceIdx: index('credit_applications_invoice_idx').on(t.invoiceId),
    amountPositive: check('credit_applications_amount_positive', sql`${t.amountCents} > 0`),
  }),
)

/**
 * A receivable given up on.
 *
 * Its own table rather than a nullable column on `invoices`, because a
 * write-off has things to say that an invoice has nowhere to put: why, who
 * decided, and what happens if the money later turns up. A recovery is
 * recorded here too, so "we wrote this off in March and they paid in
 * September" is one row's history rather than two unrelated events.
 */
export const invoiceWriteOffs = pgTable(
  'invoice_write_offs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),

    writtenOffOn: date('written_off_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),

    /** Required. A write-off without a stated reason is an unexplained loss. */
    reason: text('reason').notNull(),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    /** Set if the money later arrived after all. */
    recoveredOn: date('recovered_on'),
    recoveredCents: bigint('recovered_cents', { mode: 'number' }),
    recoveryJournalEntryId: uuid('recovery_journal_entry_id'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One write-off per invoice. Writing the same debt off twice would double
    // the bad-debt expense, and the constraint is a better guard than a check
    // two concurrent requests could both pass.
    // Named explicitly: the generated name is 66 bytes, and Postgres truncates
    // silently at 63 rather than refusing — which makes the constraint's real
    // name unpredictable and, with a near-identical sibling, collidable.
    recoveryEntryFk: foreignKey({
      name: 'invoice_write_offs_recovery_entry_fk',
      columns: [t.recoveryJournalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete('set null'),
    invoiceUnique: unique('invoice_write_offs_invoice_unique').on(t.invoiceId),
    companyIdx: index('invoice_write_offs_company_idx').on(t.companyId, t.writtenOffOn),
    amountPositive: check('invoice_write_offs_amount_positive', sql`${t.amountCents} > 0`),
    reasonNotBlank: check('invoice_write_offs_reason_not_blank', sql`length(trim(${t.reason})) > 0`),
  }),
)

/**
 * A statement sent to a customer (spec §13 "statements").
 *
 * Recorded rather than only rendered, because "what did we send them and when"
 * is the first question in any collections conversation, and a statement
 * regenerated from today's data is not the document the customer is looking at.
 * The figures are frozen onto the row.
 */
export const customerStatements = pgTable(
  'customer_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),

    /** Open-item lists what is unpaid; balance-forward carries a total in. */
    kind: text('kind', { enum: ['open_item', 'balance_forward'] })
      .notNull()
      .default('open_item'),

    periodStart: date('period_start'),
    asOfDate: date('as_of_date').notNull(),

    openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }).notNull().default(0),
    closingBalanceCents: bigint('closing_balance_cents', { mode: 'number' }).notNull().default(0),

    /** The lines as sent, frozen. */
    figures: jsonb('figures').$type<Record<string, unknown>>().notNull().default({}),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentTo: text('sent_to'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('customer_statements_customer_idx').on(t.companyId, t.customerId, t.asOfDate),
  }),
)
