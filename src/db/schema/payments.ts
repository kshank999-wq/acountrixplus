import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  bigint,
  integer,
  boolean,
  index,
  unique,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies } from './tenancy'
import { financialAccounts } from './accounting'
import { journalEntries } from './ledger'
import { invoices, payments } from './receivables'

/**
 * Taking money by card, and the days it spends in transit (spec §13, Phase 44).
 *
 * ## Why these are separate tables from `payments`
 *
 * `payments` is the accounting fact: money settled a document on a date.
 * These rows are the *processor's* view of the same event, and the two do not
 * line up one to one — an abandoned checkout is a row here and no payment at
 * all, a payout is a row here and a payment nowhere. Folding the processor's
 * identifiers onto `payments` would mean nullable processor columns on every
 * cheque and cash receipt in the business, and no way to record the attempt
 * that failed.
 */

/** How a company takes card payments. Absent means it does not. */
export const paymentSettings = pgTable('payment_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),

  /**
   * Off unless somebody turns it on.
   *
   * Same default as chasing and for a related reason: this one puts a Pay
   * button on a page the company's customers can reach, and a business that
   * has not agreed to accept cards should not appear to.
   */
  enabled: boolean('enabled').notNull().default(false),

  /** Adapter key, resolved through the provider registry. */
  provider: text('provider').notNull().default('mock'),

  /**
   * What the processor charges, so the fee can be posted at capture rather
   * than waited for.
   *
   * Held per company because it is negotiated per company — a business doing
   * £2m a year does not pay the rack rate — and because it is the number a
   * bookkeeper checks the processor's statement against. When the adapter
   * reports the real fee, that wins; this is what gets used until it does.
   */
  feePercentBp: integer('fee_percent_bp').notNull().default(290),
  feeFixedCents: bigint('fee_fixed_cents', { mode: 'number' }).notNull().default(30),

  /**
   * Where payouts land.
   *
   * Null means the company has not said, and no payout can post until it
   * does — guessing which of three bank accounts a processor deposits into
   * would put real money in the wrong place.
   */
  payoutFinancialAccountId: uuid('payout_financial_account_id').references(
    () => financialAccounts.id,
    { onDelete: 'set null' },
  ),

  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const checkoutStatusEnum = pgEnum('checkout_status', [
  'pending',
  'succeeded',
  'failed',
  'expired',
])

/**
 * One attempt by a customer to pay an invoice.
 *
 * Kept even when it fails. "The customer tried three times on Friday and the
 * card was declined" is the single most useful thing a business can know when
 * an invoice is not paid, and it is invisible if only successes are stored.
 */
export const checkouts = pgTable(
  'checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),

    /** The processor's id for the attempt. Unique, and the dedup key. */
    providerCheckoutId: text('provider_checkout_id').notNull(),
    /** The processor's id for the money, once there is any. */
    providerPaymentId: text('provider_payment_id'),
    provider: text('provider').notNull(),

    status: checkoutStatusEnum('status').notNull().default('pending'),

    /** What the customer was asked for. */
    grossCents: bigint('gross_cents', { mode: 'number' }).notNull(),
    /** What the processor kept. Zero until it says. */
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('USD'),

    /**
     * The accounting payment this became.
     *
     * Null while pending, and null for ever on a failure. Unique where set:
     * this is the constraint that stops a customer double-clicking Pay from
     * settling the invoice twice — the database decides, not the code, which
     * is the rule the rest of this system follows wherever two people can act
     * at once.
     */
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),

    /** The processor's own words when it declined. Not shown to a customer raw. */
    failureReason: text('failure_reason'),

    /**
     * What the processor said last time the sweep asked, and when (Phase 46).
     *
     * Separate from `status`, because they answer different questions. `status`
     * is what these books have concluded; this is what the other party
     * reported, unresolved. A checkout still `pending` because the processor
     * says it is pending and one still `pending` because the processor has
     * never heard of it are the same row without these columns, and they need
     * opposite responses — wait, versus go and look.
     *
     * Null means the sweep has not asked yet, which is itself worth being able
     * to say rather than showing a stale answer as a current one.
     */
    lastReportedStatus: text('last_reported_status'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => ({
    providerUnique: unique('checkouts_provider_checkout_unique').on(t.providerCheckoutId),
    paymentUnique: unique('checkouts_payment_unique').on(t.paymentId),
    invoiceIdx: index('checkouts_invoice_idx').on(t.invoiceId),
    companyStatusIdx: index('checkouts_company_status_idx').on(t.companyId, t.status),
    grossPositive: check('checkouts_gross_positive', sql`${t.grossCents} > 0`),
  }),
)

/**
 * A batch deposit from the processor.
 *
 * The row the bank statement actually shows. One of these settles many
 * checkouts, which is exactly why `1250 Payments in Transit` exists: without
 * it the ledger has twelve entries on three days where the bank has one.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    providerPayoutId: text('provider_payout_id').notNull(),
    provider: text('provider').notNull(),

    /** The day the money reaches the bank, which is the day it posts. */
    arrivalDate: date('arrival_date').notNull(),
    /** What the processor says it deposited, net of fees. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('USD'),

    /**
     * What its own items come to, and whether that agrees.
     *
     * Stored rather than recomputed, because it is a fact about what the
     * processor said on the day — recomputing it later against a changed fee
     * schedule would quietly rewrite history and make a real discrepancy
     * disappear.
     */
    expectedCents: bigint('expected_cents', { mode: 'number' }).notNull().default(0),
    differenceCents: bigint('difference_cents', { mode: 'number' }).notNull().default(0),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerUnique: unique('payouts_provider_payout_unique').on(t.companyId, t.providerPayoutId),
    companyDateIdx: index('payouts_company_date_idx').on(t.companyId, t.arrivalDate),
  }),
)

/** Which checkouts a payout settled. The join that makes the batch checkable. */
export const payoutItems = pgTable(
  'payout_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'cascade' }),
    checkoutId: uuid('checkout_id')
      .notNull()
      .references(() => checkouts.id, { onDelete: 'cascade' }),

    grossCents: bigint('gross_cents', { mode: 'number' }).notNull(),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull(),
  },
  (t) => ({
    // A checkout belongs to one payout. Paying the same money out twice is
    // the failure that would silently double the bank balance.
    checkoutUnique: unique('payout_items_checkout_unique').on(t.checkoutId),
    payoutIdx: index('payout_items_payout_idx').on(t.payoutId),
  }),
)
