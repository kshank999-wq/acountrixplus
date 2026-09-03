import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  integer,
  bigint,
  boolean,
  index,
  unique,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts, financialAccounts } from './accounting'
import { journalEntries } from './ledger'
import { projects } from './crm'
import { serviceItems } from './studio'
import { customers, invoices } from './receivables'

/**
 * Time and expense billing (spec §5, Professional Services: "Projects,
 * retainers, reimbursable expenses, time/expense billing").
 *
 * ## The invariant everything here defends
 *
 * **An hour is billed once, or not at all.**
 *
 * Both halves matter. Billing the same hour twice is a client dispute and a
 * refund; losing one is revenue that was earned, recorded, and never charged
 * for — which is the commoner failure and the more expensive, because nobody
 * notices. A timesheet is the only place in a professional-services business
 * where the product is manufactured, and it leaks.
 *
 * The enforcement is a `WHERE status = 'approved' AND invoice_id IS NULL` on
 * the update that marks time billed, inside the invoice's own transaction. Two
 * people billing the same engagement at the same moment both read the same
 * unbilled rows; only one update matches them, and the other's invoice rolls
 * back whole rather than issuing a second charge for the same work. See
 * `billing.ts`.
 *
 * ## Recording time posts nothing
 *
 * Deliberately, and it is the same decision as a purchase order posting
 * nothing (ADR 0014). Unbilled time is not revenue — nobody has agreed to pay
 * it — and for most small firms it is not an asset either, because booking
 * profit on your own labour before anybody is billed is exactly the accounting
 * that flatters a business into insolvency.
 *
 * The professional-services pack declares `1150 Unbilled Work in Progress` for
 * firms whose policy is to accrue it. Nothing posts there yet, and the report
 * that shows what is unbilled reads the timesheet directly.
 */

/**
 * Where a time entry is in its life.
 *
 * `written_off` is its own state rather than a deletion, for the same reason
 * an invoice write-off is: an hour that was worked and decided not to be
 * charged for is a fact about a job's profitability, and deleting it makes
 * every engagement look better than it was.
 */
export const timeEntryStatusEnum = pgEnum('time_entry_status', [
  'draft',
  'submitted',
  'approved',
  'billed',
  'written_off',
])

export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /**
     * Who did the work.
     *
     * A user rather than an employee: owners, contractors, and anybody with a
     * login record time, and plenty of them are not on the payroll. The
     * payroll `employees` table answers a different question — who gets paid.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    /** What kind of work, which is also where the list rate comes from. */
    serviceItemId: uuid('service_item_id').references(() => serviceItems.id, {
      onDelete: 'set null',
    }),

    workedOn: date('worked_on').notNull(),
    /** Whole minutes. What people type, and exact — see `rates.ts`. */
    minutes: integer('minutes').notNull(),
    description: text('description').notNull(),

    isBillable: boolean('is_billable').notNull().default(true),
    /**
     * The rate this entry was billed at, resolved when it was billed.
     *
     * Frozen at that moment rather than looked up on read: a rate change next
     * quarter must not restate an invoice that has already been sent.
     */
    rateCents: bigint('rate_cents', { mode: 'number' }),
    /** What it came to. Stored, so the invoice and the timesheet cannot drift. */
    amountCents: bigint('amount_cents', { mode: 'number' }),

    status: timeEntryStatusEnum('status').notNull().default('draft'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    /** Why it was not charged for, when it was written off. */
    writeOffReason: text('write_off_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Drives the timesheet: one person's week.
    personWeekIdx: index('time_entries_person_week_idx').on(t.companyId, t.userId, t.workedOn),
    // Drives unbilled work: this engagement, waiting to be charged.
    unbilledIdx: index('time_entries_unbilled_idx').on(t.companyId, t.projectId, t.status),
    invoiceIdx: index('time_entries_invoice_idx').on(t.invoiceId),
    // Zero minutes is not a time entry, and negative time is a correction that
    // belongs in its own entry with its own description.
    minutesPositive: check('time_entries_minutes_positive', sql`${t.minutes} > 0`),
    // A day has 1440 minutes. Anything past that is a typo — usually a value
    // meant as hours, entered as minutes.
    minutesSane: check('time_entries_minutes_sane', sql`${t.minutes} <= 1440`),
    // Billed means invoiced, and invoiced means an invoice.
    billedHasInvoice: check(
      'time_entries_billed_has_invoice',
      sql`${t.status} <> 'billed' OR ${t.invoiceId} IS NOT NULL`,
    ),
    writeOffHasReason: check(
      'time_entries_write_off_reason',
      sql`${t.status} <> 'written_off' OR length(trim(coalesce(${t.writeOffReason}, ''))) > 0`,
    ),
  }),
)

/**
 * A rate agreed for one person on one engagement.
 *
 * Its own table rather than a column, because it is a many-to-many fact: a
 * senior on a discounted retainer client and at list price elsewhere is the
 * ordinary case, not the exception.
 */
export const projectRates = pgTable(
  'project_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Null means the engagement's blended rate, for anybody without their own. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    rateCents: bigint('rate_cents', { mode: 'number' }).notNull(),
  },
  (t) => ({
    // One rate per person per engagement, and one blended rate per engagement.
    projectPersonUnique: unique('project_rates_project_person_unique').on(t.projectId, t.userId),
    projectIdx: index('project_rates_project_idx').on(t.companyId, t.projectId),
    rateNonNegative: check('project_rates_non_negative', sql`${t.rateCents} >= 0`),
  }),
)

/** A person's standard charge-out rate. */
export const personRates = pgTable(
  'person_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rateCents: bigint('rate_cents', { mode: 'number' }).notNull(),
    /**
     * What an hour of this person costs the firm.
     *
     * Optional and used only for job profitability. Kept apart from payroll on
     * purpose: a fully-loaded hourly cost is an estimate a partner sets, not a
     * figure derived from a salary, and pretending otherwise makes the number
     * look more precise than it is.
     */
    costRateCents: bigint('cost_rate_cents', { mode: 'number' }),
  },
  (t) => ({
    companyUserUnique: unique('person_rates_company_user_unique').on(t.companyId, t.userId),
    rateNonNegative: check('person_rates_non_negative', sql`${t.rateCents} >= 0`),
  }),
)

export const expenseStatusEnum = pgEnum('billable_expense_status', [
  'unbilled',
  'billed',
  'written_off',
])

/**
 * A cost incurred for a client, to be charged on.
 *
 * The **cost is already in the books** — it arrived as a bank transaction or a
 * supplier bill and was categorized to an expense account like any other. This
 * row does not re-post it; it records that the cost is recoverable and has not
 * been recovered yet. Posting it again here would double the expense.
 */
export const billableExpenses = pgTable(
  'billable_expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),

    incurredOn: date('incurred_on').notNull(),
    description: text('description').notNull(),
    /** What it cost the firm. */
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),
    /** Markup in basis points, as every ratio here is. Zero is a real answer. */
    markupBasisPoints: integer('markup_basis_points').notNull().default(0),
    /** What the client is charged. Stored, so a markup change cannot restate it. */
    billableCents: bigint('billable_cents', { mode: 'number' }).notNull(),

    /** The expense account the cost originally landed in, for the report. */
    chartAccountId: uuid('chart_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),
    /** The bank transaction or bill it came from. */
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),

    status: expenseStatusEnum('status').notNull().default('unbilled'),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    writeOffReason: text('write_off_reason'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unbilledIdx: index('billable_expenses_unbilled_idx').on(t.companyId, t.projectId, t.status),
    invoiceIdx: index('billable_expenses_invoice_idx').on(t.invoiceId),
    costPositive: check('billable_expenses_cost_positive', sql`${t.costCents} > 0`),
    // A markup below −100% would charge a negative amount for a real cost.
    markupSane: check('billable_expenses_markup_sane', sql`${t.markupBasisPoints} >= -10000`),
    billedHasInvoice: check(
      'billable_expenses_billed_has_invoice',
      sql`${t.status} <> 'billed' OR ${t.invoiceId} IS NOT NULL`,
    ),
  }),
)

/**
 * Money taken before the work is done (spec §5: "retainers").
 *
 * On receipt it is **not revenue**: the client's money is held against work
 * not yet performed, so it credits `2550 Client Retainers Held`, a liability.
 * Treating it as revenue on arrival is the single commonest error in
 * professional-services bookkeeping, and it flatters a quarter by exactly the
 * amount of work still owed.
 *
 * The subtype is `deferred_revenue`, which means Phase 12's cash-basis
 * transformation already handles it correctly for free: on a cash basis the
 * deposit *is* revenue when it arrives, and the drawdown never happened.
 */
export const retainers = pgTable(
  'retainers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),

    receivedOn: date('received_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** What is left to draw against. */
    remainingCents: bigint('remaining_cents', { mode: 'number' }).notNull(),
    /**
     * The currency the money arrived in (Phase 66).
     *
     * Chosen when the retainer is taken rather than inherited, because unlike a
     * credit note — which reverses a document that already exists — a retainer
     * comes before there is anything to inherit from. It is cash on account.
     */
    currency: text('currency').notNull().default('USD'),
    /**
     * Millionths, retainer currency → functional. What the liability has been
     * carried at since the day the money came in, and never recomputed.
     */
    exchangeRateMillionths: bigint('exchange_rate_millionths', { mode: 'number' })
      .notNull()
      .default(1_000_000),
    /**
     * What is left to draw, in the company's own money.
     *
     * Moves with `remainingCents` on every draw. A database check keeps the two
     * reaching zero together, because a retainer still showing functional money
     * after its face amount is spent is credit the business does not have.
     */
    functionalRemainingCents: bigint('functional_remaining_cents', { mode: 'number' })
      .notNull()
      .default(0),
    reference: text('reference'),
    memo: text('memo'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('retainers_customer_idx').on(t.companyId, t.customerId),
    amountPositive: check('retainers_amount_positive', sql`${t.amountCents} > 0`),
    remainingSane: check(
      'retainers_remaining_sane',
      sql`${t.remainingCents} >= 0 AND ${t.remainingCents} <= ${t.amountCents}`,
    ),
  }),
)

/** One drawdown of a retainer against an invoice. */
export const retainerApplications = pgTable(
  'retainer_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    retainerId: uuid('retainer_id')
      .notNull()
      .references(() => retainers.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),

    /** In the client's currency — what the retainer itself is denominated in. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /**
     * Functional, off the liability, at the rate it has been carried at since
     * the money came in (Phase 112).
     *
     * The same fact `refunds.carried_cents` has kept since Phase 68, in the
     * same words, about the other way a retainer goes down. A draw worked this
     * out, posted it, and did not write it here — so the money a firm holds for
     * its clients could be stated for today and for no other day.
     *
     * Not derivable from `amount_cents` and the rate: `relieveFunctional` gives
     * the *final* draw the whole remaining functional balance, so no retainer
     * is left holding a stranded cent. That makes a draw's functional amount
     * depend on the functional balance at that moment — which is the history
     * being reconstructed. Circular, so it is kept.
     */
    carriedCents: bigint('carried_cents', { mode: 'number' }).notNull(),
    appliedOn: date('applied_on').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    retainerIdx: index('retainer_applications_retainer_idx').on(t.retainerId),
    invoiceIdx: index('retainer_applications_invoice_idx').on(t.invoiceId),
    // The query this column exists for: one company's draws up to a date.
    datedIdx: index('retainer_applications_dated_idx').on(t.companyId, t.appliedOn),
    amountPositive: check('retainer_applications_amount_positive', sql`${t.amountCents} > 0`),
    carriedPositive: check('retainer_applications_carried_positive', sql`${t.carriedCents} > 0`),
  }),
)

/**
 * A retainer given back lives in `refunds` (Phase 68).
 *
 * Phase 67 gave it a table of its own here. That was right about the shape —
 * three amounts rather than one, because a foreign refund is three different
 * facts — and wrong about where it belonged. A refund is not a fact about
 * retainers: the same three amounts describe a customer's overpayment going
 * back and a supplier's credit coming in. See `src/db/schema/refunds.ts`.
 */
