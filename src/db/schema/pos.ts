import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  bigint,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { journalEntries } from './ledger'

/**
 * Daily sales summaries (spec §5).
 *
 * The `pos_import` module has been declared since Phase 0, switched on by the
 * restaurant pack, and has done nothing. So have `2310 Tips Payable`,
 * `1210 Payment Processor Clearing`, `4930 Returns and Refunds` and
 * `6860 Marketplace and Platform Fees`. This is where they start meaning
 * something.
 *
 * ## One module, two industry rows
 *
 * Restaurant/Food Service asks for "POS imports, tips, daily sales summaries";
 * E-commerce asks for "marketplace/payment processor feeds, fees, returns".
 * They are the same shape: a day of trading arrives as somebody else's summary
 * and has to become double-entry. Building them separately would be two
 * implementations of one rounding decision.
 *
 * ## The claim
 *
 * **A day's takings are one entry, and the till has to agree.** Four hundred
 * covers is one journal entry, not four hundred; and where the drawer and the
 * register disagree, the difference is named rather than plugged.
 */

/**
 * Where the summary came from.
 *
 * Named rather than free text because it is half of the idempotency key: a
 * restaurant with a till *and* a delivery marketplace has two summaries for
 * the same trading day, and both are legitimate.
 */
export const posSourceEnum = pgEnum('pos_source', [
  /** A till or point-of-sale system. */
  'register',
  /** A delivery or marketplace platform settling in a batch. */
  'marketplace',
  /** A payment processor's daily settlement. */
  'processor',
  /** Typed in by a person from a Z-report. */
  'manual',
])

/**
 * One trading day from one source.
 *
 * `unique(company_id, business_date, source)` is the whole safety property, and
 * it is the same shape Phase 23 used for rent and Phase 26 for fund releases:
 * **a day imported twice is imported once, because the database refuses the
 * second.** A nightly job that runs at 2am and again after a retry must not
 * double a restaurant's revenue.
 *
 * The figures are stored rather than derived. They are the *subledger* — what
 * the source said it took — and `tipsPosition` puts `tips_cents` against the
 * balance on 2310 after payroll has drawn on it. A figure recomputed from the
 * journal lines it is being checked against would agree with itself and prove
 * nothing, which is the same argument `work_orders.wip_cents` makes.
 *
 * `over_short_cents` and `out_of_balance_cents` are the two ways a day can fail
 * to add up, and they are different failures: the first is the drawer
 * disagreeing with the register, the second is the source disagreeing with
 * itself. Neither is inferable from the other.
 */
export const posDays = pgTable(
  'pos_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /**
     * The trading day, which is not always the calendar day.
     *
     * A bar open until 2am books the whole night to the day it opened, and the
     * source decides that — this column records the decision rather than
     * inferring it from a timestamp.
     */
    businessDate: date('business_date').notNull(),
    source: posSourceEnum('source').notNull().default('register'),
    /** The till or platform, when a company has several: "Front counter". */
    label: text('label'),

    /** Before discounts, tax and tips. */
    grossSalesCents: bigint('gross_sales_cents', { mode: 'number' }).notNull(),
    /** Gross, less discounts and refunds. What the day actually earned. */
    netSalesCents: bigint('net_sales_cents', { mode: 'number' }).notNull(),
    discountsCents: bigint('discounts_cents', { mode: 'number' }).notNull().default(0),
    refundsCents: bigint('refunds_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    /** Collected for staff. A liability from the moment it is taken. */
    tipsCents: bigint('tips_cents', { mode: 'number' }).notNull().default(0),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    /** Everything the tills say was taken, across every tender. */
    takingsCents: bigint('takings_cents', { mode: 'number' }).notNull().default(0),

    /** Counted less expected. Null when nobody counted; negative is short. */
    overShortCents: bigint('over_short_cents', { mode: 'number' }),
    /** What the source's own figures fail to add up to. Usually zero. */
    outOfBalanceCents: bigint('out_of_balance_cents', { mode: 'number' }).notNull().default(0),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    notes: text('notes'),
    importedBy: uuid('imported_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dayUnique: unique('pos_days_company_date_source_unique').on(
      t.companyId,
      t.businessDate,
      t.source,
    ),
    dateIdx: index('pos_days_date_idx').on(t.companyId, t.businessDate),
    salesNotNegative: check(
      'pos_days_sales_not_negative',
      sql`${t.grossSalesCents} >= 0 AND ${t.discountsCents} >= 0 AND ${t.refundsCents} >= 0
          AND ${t.taxCents} >= 0 AND ${t.tipsCents} >= 0 AND ${t.feeCents} >= 0`,
    ),
  }),
)

/**
 * What was sold, by category, on one day.
 *
 * Kept as rows rather than folded into the entry's lines so that "how did
 * beverage sales move this month" is a query rather than a journal search, and
 * so that the till's own name for a category survives — the journal line only
 * ever carries the account it was posted to.
 *
 * These are evidence of what the source said, not postings. The entry is the
 * posting, and a day whose category names an account the chart of accounts does
 * not have is refused whole rather than half-recorded.
 */
export const posDayCategories = pgTable(
  'pos_day_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    posDayId: uuid('pos_day_id')
      .notNull()
      .references(() => posDays.id, { onDelete: 'cascade' }),

    /** What the till called it: "Wine", "Bar snacks". */
    name: text('name').notNull(),
    /** The revenue account it was posted to. */
    accountNumber: text('account_number').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  },
  (t) => ({
    dayIdx: index('pos_day_categories_day_idx').on(t.companyId, t.posDayId),
    categoryUnique: unique('pos_day_categories_unique').on(t.posDayId, t.name),
  }),
)

/** How the money arrived on one day. */
export const posDayTenders = pgTable(
  'pos_day_tenders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    posDayId: uuid('pos_day_id')
      .notNull()
      .references(() => posDays.id, { onDelete: 'cascade' }),

    /** `cash`, `card`, `other` — see `modules/pos/summary.ts`. */
    kind: text('kind').notNull(),
    /** What the till called it: "Visa", "Deliveroo". */
    name: text('name').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** What the processor kept. Zero for cash. */
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
  },
  (t) => ({
    dayIdx: index('pos_day_tenders_day_idx').on(t.companyId, t.posDayId),
    tenderUnique: unique('pos_day_tenders_unique').on(t.posDayId, t.name),
    feeNotNegative: check('pos_day_tenders_fee_not_negative', sql`${t.feeCents} >= 0`),
  }),
)
