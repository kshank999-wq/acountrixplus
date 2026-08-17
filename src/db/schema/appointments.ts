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
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { customers } from './receivables'
import { serviceItems } from './studio'
import { chartAccounts } from './accounting'
import { journalEntries } from './ledger'
import { invoices } from './receivables'

/**
 * Appointments, practitioners and gift cards (spec §5).
 *
 * The `appointments` module has been declared since Phase 0, switched on by
 * the healthcare and personal-care packs, doing nothing. So have
 * `2320 Contractor Payouts Payable`, `2590 Gift Cards Outstanding`,
 * `4700 Service Revenue - Appointments` and `4720 Gift Card Redemptions`.
 *
 * ## What makes this accounting rather than a calendar
 *
 * A diary on its own is a scheduling feature and belongs in a scheduling
 * product. Three things here are not:
 *
 *  - **A booking is a promise, not a sale.** Nothing is posted until the
 *    service is delivered, which is the whole of revenue recognition in one
 *    sentence and the thing a calendar bolted onto an invoice gets wrong.
 *  - **Part of the money was never the business's.** A practitioner on
 *    commission is owed their share from the moment the work is done, whether
 *    or not payday has come.
 *  - **A gift card is money taken for a service not yet given.** It is a
 *    liability on the day it is sold and revenue only when it is used.
 */

/** Where a booking ended up. */
export const appointmentStatusEnum = pgEnum('appointment_status', [
  /** In the diary, not yet delivered, and worth nothing to the ledger. */
  'booked',
  /** Delivered. The only status that posts. */
  'completed',
  /**
   * The client did not come.
   *
   * Deliberately not the same as `cancelled`. A cancellation is a slot given
   * back in time to sell again; a no-show is a slot that was lost, and a
   * practice that cannot tell them apart cannot see the cost of either. Some
   * charge a fee for one and not the other, which is why this carries a price
   * rather than being a flag on a cancelled row.
   */
  'no_show',
  /** Called off. The slot was released and nothing is owed. */
  'cancelled',
])

/**
 * Somebody who delivers appointments.
 *
 * Not a `users` row and not a `memberships` row, and that is the load-bearing
 * decision: **most practitioners never sign in.** A salon's chair renter and a
 * clinic's visiting physiotherapist appear in the diary, earn a share, and have
 * no login and no permissions. Modelling them as users would either create
 * dormant accounts that can be signed into, or force a fake membership row
 * whose role has to be explained.
 *
 * `userId` is an optional link for the ones who *do* sign in, so a practitioner
 * looking at their own week is a query rather than a name match.
 */
export const practitioners = pgTable(
  'practitioners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    email: text('email'),
    /** Set when this practitioner also has a login. Usually null. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Their default share of service revenue, in basis points.
     *
     * On the practitioner rather than only on the appointment, because a rate
     * is a standing arrangement — but copied onto each appointment when it is
     * booked, so changing somebody's rate in March does not restate February.
     */
    commissionBp: integer('commission_bp').notNull().default(0),
    /** Their default share of retail sold alongside. Usually much lower. */
    productCommissionBp: integer('product_commission_bp').notNull().default(0),

    /**
     * True when this person is paid through payroll rather than as a contractor.
     *
     * Both still credit 2320: the liability is the same fact either way — work
     * done and not yet paid for — and which door the money leaves by is
     * payroll's business, not this module's.
     */
    isEmployee: boolean('is_employee').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNameIdx: index('practitioners_company_name_idx').on(t.companyId, t.name),
    nameUnique: unique('practitioners_company_name_unique').on(t.companyId, t.name),
    ratesSane: check(
      'practitioners_rates_sane',
      sql`${t.commissionBp} BETWEEN 0 AND 10000 AND ${t.productCommissionBp} BETWEEN 0 AND 10000`,
    ),
  }),
)

/**
 * One booking.
 *
 * ## The database refuses a double-booking
 *
 * `appointments_no_double_booking` is an `EXCLUDE USING gist` constraint over
 * `(practitioner_id, tstzrange(starts_at, ends_at))`, restricted to bookings
 * that still hold a slot. It is written by hand into the migration because
 * drizzle-kit does not generate exclusion constraints.
 *
 * This is the same rule every phase since Phase 23 has followed — *where two
 * people can act at once, the database arbitrates* — but a unique key cannot
 * express it. Two bookings at 10:00 and 10:30 do not collide on any column;
 * they collide on an *interval*, and only Postgres knows that at the moment of
 * insert. The alternative is to read the practitioner's other bookings, decide
 * there is room, and then insert — which is correct exactly until the
 * receptionist and the online booking form do it in the same second, and then
 * quietly is not.
 *
 * The `WHERE` clause matters as much as the constraint. A cancelled
 * appointment must stop reserving its slot, or a client who calls off Tuesday
 * blocks that hour for ever.
 *
 * ## Prices are copied, not looked up
 *
 * `priceCents` and both rates are written onto the row at booking. A service
 * repriced in March must not restate what February's appointment was worth, and
 * a practitioner's rise must not silently rewrite what they were owed for work
 * already done.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    practitionerId: uuid('practitioner_id')
      .notNull()
      .references(() => practitioners.id, { onDelete: 'restrict' }),
    /** Who it is for. Null for a slot held without a name against it yet. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /** What is being done. Carries the revenue account when it posts. */
    serviceItemId: uuid('service_item_id').references(() => serviceItems.id, {
      onDelete: 'set null',
    }),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),

    status: appointmentStatusEnum('status').notNull().default('booked'),

    /** What the client is charged for the service, after any discount. */
    priceCents: bigint('price_cents', { mode: 'number' }).notNull().default(0),
    /** Retail sold at the same visit. Posts to its own revenue account. */
    productCents: bigint('product_cents', { mode: 'number' }).notNull().default(0),

    /** Copied from the practitioner at booking. See the note above. */
    commissionBp: integer('commission_bp').notNull().default(0),
    productCommissionBp: integer('product_commission_bp').notNull().default(0),

    /**
     * What the practitioner was owed, decided when the work was done.
     *
     * Stored rather than recomputed for the same reason `work_orders.wip_cents`
     * is: it is the subledger side of a reconciliation against 2320, and a
     * figure recomputed from the rates it is being checked against would agree
     * with itself and prove nothing.
     */
    practitionerCents: bigint('practitioner_cents', { mode: 'number' }),

    notes: text('notes'),
    /**
     * The invoice raised when the visit was delivered (Phase 31).
     *
     * What the client owes is an invoice like any other, so it ages, appears on
     * a statement, gets a PDF and can be paid. Phase 29 posted straight to 1100
     * and skipped all four.
     */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    /**
     * The practitioner's share, once delivered. Null on a free visit.
     *
     * No longer the revenue posting — that belongs to the invoice now — but the
     * cost of delivering it, which is not the client's business and is not on
     * their bill.
     */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    completedOn: date('completed_on'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    diaryIdx: index('appointments_diary_idx').on(t.companyId, t.startsAt),
    practitionerIdx: index('appointments_practitioner_idx').on(t.practitionerId, t.startsAt),
    endsAfterStart: check('appointments_ends_after_start', sql`${t.endsAt} > ${t.startsAt}`),
    pricesNotNegative: check(
      'appointments_prices_not_negative',
      sql`${t.priceCents} >= 0 AND ${t.productCents} >= 0`,
    ),
    /** A delivered appointment knows what it was worth to whom; a promise does not. */
    completedKnowsItsSplit: check(
      'appointments_completed_knows_its_split',
      sql`${t.status} <> 'completed' OR (${t.practitionerCents} IS NOT NULL AND ${t.completedOn} IS NOT NULL)`,
    ),
  }),
)

/**
 * A gift card: money held against a service not yet given.
 *
 * `balanceCents` is the subledger. It is maintained by redemption and checked
 * against account 2590, which is maintained by the journal — two genuinely
 * different things, which is what makes `giftCardPosition` a reconciliation
 * rather than a restatement.
 *
 * There is no expiry and no breakage. Recognising the revenue on an unused card
 * requires a judgement about how many never come back, and a wrong judgement
 * books revenue that has to be given back. See ADR 0029.
 */
export const giftCards = pgTable(
  'gift_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** What is printed on the card. Unique per company so it can be looked up. */
    code: text('code').notNull(),
    /** Who bought it, when that is known. Often not the person who uses it. */
    purchaserCustomerId: uuid('purchaser_customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),

    /** What it was sold for. Never changes. */
    issuedCents: bigint('issued_cents', { mode: 'number' }).notNull(),
    /** What is left on it. */
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),

    issuedOn: date('issued_on').notNull(),
    /** The entry that put it on the balance sheet. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    /** Where the money went when it was sold — cash, card, undeposited funds. */
    depositAccountId: uuid('deposit_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),

    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('gift_cards_company_code_unique').on(t.companyId, t.code),
    /**
     * A card cannot hold more than it was sold for, and cannot go negative.
     *
     * The upper bound is the one that catches a real bug: a redemption
     * reversed twice, or a card credited instead of debited, shows up here at
     * the moment it happens rather than as an unexplained balance on 2590 a
     * quarter later.
     */
    balanceInRange: check(
      'gift_cards_balance_in_range',
      sql`${t.balanceCents} >= 0 AND ${t.balanceCents} <= ${t.issuedCents}`,
    ),
  }),
)

/**
 * One use of a card.
 *
 * Kept as rows rather than only as a running balance so that "when did this
 * card get spent" is answerable, and so the balance can be proved from its own
 * history when somebody disputes it.
 */
export const giftCardRedemptions = pgTable(
  'gift_card_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    giftCardId: uuid('gift_card_id')
      .notNull()
      .references(() => giftCards.id, { onDelete: 'cascade' }),
    /**
     * The appointment it paid for.
     *
     * Unique, so one appointment cannot be settled by the same card twice — the
     * claim row Phase 23 established, in the place a retrying "mark as paid"
     * button would otherwise double-count.
     */
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'cascade',
    }),

    appliedCents: bigint('applied_cents', { mode: 'number' }).notNull(),
    redeemedOn: date('redeemed_on').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cardIdx: index('gift_card_redemptions_card_idx').on(t.companyId, t.giftCardId),
    oncePerAppointment: unique('gift_card_redemptions_appointment_unique').on(t.appointmentId),
    appliedPositive: check('gift_card_redemptions_applied_positive', sql`${t.appliedCents} > 0`),
  }),
)
