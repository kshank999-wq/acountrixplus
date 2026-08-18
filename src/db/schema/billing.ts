import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  unique,
  index,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'
import { customers, invoices } from './receivables'
import { recurringCadenceEnum } from './periods'

/**
 * An arrangement to invoice a customer every period (spec §13).
 *
 * ## A schedule is a promise to bill, not a bill
 *
 * Nothing in these tables is owed by anybody. No report counts a schedule as
 * revenue, nothing ages, and no statement mentions one — until an occurrence
 * raises a real invoice through the same door everything else uses.
 *
 * That is the distinction Phase 29 drew for a booking ("a booking is a promise,
 * and a promise is not revenue") applied to the other side of the year: a
 * retainer client who has agreed to pay $500 a month has not yet been billed
 * for December, and a system that showed thirteen months of receivable because
 * somebody set up a schedule would be lying about what it is owed.
 *
 * ## Why the cadence enum is Phase 11's
 *
 * `recurring_cadence` already exists, for recurring *journal entries*. Two
 * enums with the same four values would be two places to add "fortnightly" and
 * one of them would get missed. The two features are genuinely different — one
 * posts an entry, the other raises a document a customer receives — but the
 * question "how often" has one answer.
 *
 * `nextOccurrence` is shared for the same reason: one implementation of "what
 * is the next monthly date", not two that drift apart on the 31st.
 */

export const recurringInvoices = pgTable(
  'recurring_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),

    /** "Meridian Systems — monthly retainer". What a person calls it. */
    name: text('name').notNull(),
    memo: text('memo'),

    cadence: recurringCadenceEnum('cadence').notNull(),
    /**
     * 1–28, the bound Phase 11 chose and for its reason: "the 31st" in
     * February has three defensible answers, and picking one silently is how a
     * monthly arrangement bills eleven times a year.
     */
    dayOfMonth: integer('day_of_month').notNull().default(1),

    /** Days after the issue date the invoice falls due. */
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),

    /**
     * Whether an occurrence raises the invoice or leaves it for a person.
     *
     * The distinction Phase 11 drew for journal entries, applied here — and it
     * matters more on this side, because the output is a document that goes to
     * a customer. A fixed retainer is safe to raise; anything whose amount
     * somebody checks first is not, and a schedule that billed it anyway is how
     * a client receives an invoice for work that did not happen.
     */
    autoRaise: boolean('auto_raise').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),

    startsOn: date('starts_on').notNull(),
    /** Optional. A twelve-month contract should stop on its own. */
    endsOn: date('ends_on'),

    lastRunOn: date('last_run_on'),
    nextRunOn: date('next_run_on').notNull(),
    occurrenceCount: integer('occurrence_count').notNull().default(0),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('recurring_invoices_due_idx').on(table.companyId, table.isActive, table.nextRunOn),
    unique('recurring_invoices_name_unique').on(table.companyId, table.name),
    check(
      'recurring_invoices_day_range',
      sql`${table.dayOfMonth} >= 1 AND ${table.dayOfMonth} <= 28`,
    ),
    check(
      'recurring_invoices_ends_after_start',
      sql`${table.endsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn}`,
    ),
    check('recurring_invoices_terms', sql`${table.paymentTermsDays} >= 0`),
  ],
)

/**
 * What the schedule bills each time.
 *
 * Stored as a template rather than as a reference to a previous invoice, for
 * Phase 11's reason: copying a document carries its date, its number and its
 * relationship to a closed period. The template is the *intent*, and each
 * occurrence is a fresh invoice through the same validation as one somebody
 * typed.
 *
 * A consequence worth naming: **changing a line changes the future, not the
 * past.** Invoices already raised are documents a customer holds, and editing
 * a schedule cannot reach back and restate them. Phase 23 recorded "no rent
 * reviews" as a limitation because a lease had nowhere to keep the change;
 * here it falls out of the template being separate from what it produced.
 */
export const recurringInvoiceLines = pgTable(
  'recurring_invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    recurringInvoiceId: uuid('recurring_invoice_id').notNull(),

    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    /** Thousandths, the convention every other document line uses. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull().default(1000),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'recurring_invoice_lines_schedule_fk',
      columns: [table.recurringInvoiceId],
      foreignColumns: [recurringInvoices.id],
    }).onDelete('cascade'),
    index('recurring_invoice_lines_schedule_idx').on(table.recurringInvoiceId),
  ],
)

/**
 * One period, billed once.
 *
 * The unique index is the whole idempotency story, and it is the database's
 * rather than the application's for the reason Phase 23 established when
 * billing rent: the scheduler guarantees *at least* once (Phase 10), so
 * something has to make the second attempt harmless. A read-then-write would
 * let a worker and a person both find nothing and both raise an invoice, and
 * the customer gets billed twice for December.
 */
export const recurringInvoiceOccurrences = pgTable(
  'recurring_invoice_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    recurringInvoiceId: uuid('recurring_invoice_id').notNull(),

    /**
     * The invoice this occurrence raised, or null when it was skipped.
     *
     * `set null` on delete rather than cascade: an invoice being voided or
     * removed does not mean the period was never billed, and forgetting that
     * would let the next run bill it again.
     */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    occurredOn: date('occurred_on').notNull(),
    /** False when the schedule needed a person and one has not acted yet. */
    wasRaised: boolean('was_raised').notNull(),
    /** What it billed, kept so a skipped or voided period still says what it meant to be. */
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'recurring_invoice_occurrences_schedule_fk',
      columns: [table.recurringInvoiceId],
      foreignColumns: [recurringInvoices.id],
    }).onDelete('cascade'),
    unique('recurring_invoice_occurrences_unique').on(
      table.recurringInvoiceId,
      table.occurredOn,
    ),
    index('recurring_invoice_occurrences_schedule_idx').on(table.recurringInvoiceId),
  ],
)
