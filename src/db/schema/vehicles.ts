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
import { journalEntries } from './ledger'
import { invoices } from './receivables'

/**
 * Customer vehicles and repair orders (spec §5 "Automotive / Repair — jobs,
 * parts, labor, estimates, **customer vehicles**").
 *
 * `vehicles` is the tenth and last of the industry modules declared in Phase 0,
 * and it is the one that took longest to be worth building, because on its face
 * a vehicle is a dimension and Phase 16 has reported on those since then.
 *
 * What makes it a module rather than a dimension is the estimate. **A repair
 * shop may not bill past what the customer authorised** — in most jurisdictions
 * that is not a policy but a statute — and an authorisation is a fact with a
 * time, a person and an amount attached, not a number on a job.
 *
 * ## The claims
 *
 * 1. **A vehicle belongs to a customer, and its history outlives the job.**
 * 2. **Nobody bills past what was authorised.**
 * 3. **An odometer does not go backwards.**
 * 4. **Parts, labour and sublet are three different things**, and a shop that
 *    cannot tell them apart cannot tell whether it is making money on either.
 */

/** How the customer said yes. */
export const authorisationChannelEnum = pgEnum('authorisation_channel', [
  /** Signed the estimate at the counter. */
  'in_person',
  /** Said yes on the phone. The commonest, and the one disputes are about. */
  'phone',
  'email',
  'sms',
  /** Approved through a portal or a link. */
  'online',
])

export const repairOrderStatusEnum = pgEnum('repair_order_status', [
  /** Priced, and nobody has agreed to anything. */
  'estimate',
  /** The customer said yes. Work can start. */
  'authorised',
  /** Delivered and posted. */
  'completed',
  /** Called off. Nothing posted. */
  'cancelled',
])

/** What a line on a repair order is. */
export const repairLineKindEnum = pgEnum('repair_line_kind', [
  /** Time at the shop's rate. Its own revenue account. */
  'labour',
  /** A part off the shelf. Relieves inventory and posts cost of sales. */
  'part',
  /**
   * Work sent out — a machine shop, a specialist, a mobile windscreen fitter.
   *
   * Its own kind rather than a part or a labour line, because it is neither: no
   * stock moves and no technician's time is consumed, and a shop that books
   * sublet as labour will believe its own bay is more productive than it is.
   */
  'sublet',
])

/**
 * A customer's vehicle.
 *
 * Keyed by VIN where there is one, because **the record follows the car and not
 * the owner**. Cars change hands, and a service history that resets on sale is
 * worth a great deal less than one that does not — to the next owner, to the
 * shop that wants the work, and to anybody trying to establish what was done
 * and when.
 *
 * `customerId` is therefore the *current* keeper and is allowed to change,
 * while the vehicle row and its repair orders stay put.
 */
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Who owns it now. Changes when the car is sold; the history does not. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

    /**
     * The vehicle identification number, where the shop has recorded one.
     *
     * Unique per company when present. Nullable because plenty of small shops
     * work off the registration alone and a schema that insists on a VIN gets
     * a column full of `UNKNOWN-1`, `UNKNOWN-2`.
     */
    vin: text('vin'),
    /** Number plate. Changes over a car's life, which is why it is not the key. */
    registration: text('registration'),

    make: text('make'),
    model: text('model'),
    year: integer('year'),
    colour: text('colour'),

    /**
     * The highest reading recorded so far.
     *
     * Stored rather than derived from the repair orders, because it is the
     * thing a new reading is checked against and that check has to be cheap and
     * has to happen inside the same transaction as the insert.
     */
    odometerMiles: integer('odometer_miles'),

    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('vehicles_company_idx').on(t.companyId, t.registration),
    customerIdx: index('vehicles_customer_idx').on(t.companyId, t.customerId),
    vinUnique: unique('vehicles_company_vin_unique').on(t.companyId, t.vin),
    yearSane: check('vehicles_year_sane', sql`${t.year} IS NULL OR ${t.year} BETWEEN 1885 AND 2200`),
    odometerNotNegative: check(
      'vehicles_odometer_not_negative',
      sql`${t.odometerMiles} IS NULL OR ${t.odometerMiles} >= 0`,
    ),
  }),
)

/**
 * One visit: an estimate that may become authorised work.
 *
 * `authorisedCents` is the running total of what the customer has agreed to,
 * summed from `repair_order_authorisations`. It is stored for the same reason
 * `work_orders.wip_cents` and `pos_days.*` are — it is the subledger side of a
 * check against the authorisations themselves, and a figure recomputed from the
 * rows it is being checked against agrees with itself and proves nothing.
 */
export const repairOrders = pgTable(
  'repair_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    number: text('number').notNull(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    /** Copied from the vehicle when the order opens, and then held. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

    status: repairOrderStatusEnum('status').notNull().default('estimate'),
    complaint: text('complaint'),

    /** The sum of every authorisation given. Zero on an unapproved estimate. */
    authorisedCents: bigint('authorised_cents', { mode: 'number' }).notNull().default(0),
    /**
     * How far over the authorised total this shop may go without asking again.
     *
     * On the order rather than only on the company, because the tolerance a
     * customer agreed to is a term of *this* job. Changing the shop default in
     * June must not retroactively widen what May's customer consented to.
     */
    toleranceBp: integer('tolerance_bp').notNull().default(0),

    odometerIn: integer('odometer_in'),
    odometerOut: integer('odometer_out'),

    openedOn: date('opened_on').notNull(),
    completedOn: date('completed_on'),
    /**
     * The invoice raised when the order was billed (Phase 31).
     *
     * Phase 30 posted straight to 1100, which put the money on the balance
     * sheet and on no aging report — so a garage could see what it was owed
     * and not who owed it. See `ledger/receivables-check.ts`.
     */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    /** The stock relieved for the parts fitted. The revenue is the invoice's. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('repair_orders_company_number_unique').on(t.companyId, t.number),
    vehicleIdx: index('repair_orders_vehicle_idx').on(t.companyId, t.vehicleId),
    statusIdx: index('repair_orders_status_idx').on(t.companyId, t.status),
    toleranceSane: check(
      'repair_orders_tolerance_sane',
      sql`${t.toleranceBp} BETWEEN 0 AND 10000`,
    ),
    authorisedNotNegative: check(
      'repair_orders_authorised_not_negative',
      sql`${t.authorisedCents} >= 0`,
    ),
    /**
     * A completed order knows when, and an estimate has agreed nothing.
     *
     * The second half is the one that matters: it makes "authorised" a state
     * the database will not let you enter without an amount behind it.
     */
    completedKnowsWhen: check(
      'repair_orders_completed_knows_when',
      sql`${t.status} <> 'completed' OR ${t.completedOn} IS NOT NULL`,
    ),
    authorisedHasAnAmount: check(
      'repair_orders_authorised_has_an_amount',
      sql`${t.status} = 'estimate' OR ${t.status} = 'cancelled' OR ${t.authorisedCents} > 0`,
    ),
  }),
)

/**
 * One thing done, or proposed, on a repair order.
 *
 * Priced when the line is written and then held, like Phase 29's commission
 * rates: a labour rate that goes up in March must not restate what February's
 * estimate said the job would cost.
 */
export const repairOrderLines = pgTable(
  'repair_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    repairOrderId: uuid('repair_order_id')
      .notNull()
      .references(() => repairOrders.id, { onDelete: 'cascade' }),

    kind: repairLineKindEnum('kind').notNull(),
    description: text('description').notNull(),

    /** The stocked part, when this is one. Null for labour and sublet. */
    itemId: uuid('item_id').references(() => serviceItems.id, { onDelete: 'set null' }),

    /** Hours for labour, units for parts — thousandths, as everywhere else. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull().default(1_000),
    /** What the customer is charged per unit or per hour. */
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull().default(0),
    /**
     * What it costs the shop, for sublet only.
     *
     * Parts take their cost from the inventory lots they come out of — Phase
     * 14 decides that, not this table — and labour's cost is payroll's. A
     * sublet has no lot and no timesheet, so its cost is what the invoice from
     * the machine shop says.
     */
    subletCostCents: bigint('sublet_cost_cents', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('repair_order_lines_order_idx').on(t.companyId, t.repairOrderId),
    quantityPositive: check('repair_order_lines_quantity_positive', sql`${t.quantityMilli} > 0`),
    pricesNotNegative: check(
      'repair_order_lines_prices_not_negative',
      sql`${t.unitPriceCents} >= 0 AND ${t.subletCostCents} >= 0`,
    ),
    /** Only a part comes off a shelf; only a sublet carries its own cost. */
    kindMatchesFields: check(
      'repair_order_lines_kind_matches_fields',
      sql`(${t.kind} = 'part' OR ${t.itemId} IS NULL) AND (${t.kind} = 'sublet' OR ${t.subletCostCents} = 0)`,
    ),
  }),
)

/**
 * The customer saying yes, once.
 *
 * A row per approval rather than a running total on the order, because **who
 * agreed to what, when, and how** is the entire evidentiary content of this
 * module. A shop challenged over a bill needs to be able to say "you approved a
 * further £180 by telephone at 14:20 on the 3rd, and Priya took the call" — and
 * a single `authorised_cents` column cannot say any of that.
 *
 * Amounts are *additional*, not cumulative. The order's total is their sum, so
 * a mistaken authorisation is reversed by a negative row rather than by editing
 * history.
 */
export const repairOrderAuthorisations = pgTable(
  'repair_order_authorisations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    repairOrderId: uuid('repair_order_id')
      .notNull()
      .references(() => repairOrders.id, { onDelete: 'cascade' }),

    /** How much more was approved. Negative to withdraw an approval given. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    channel: authorisationChannelEnum('channel').notNull().default('phone'),
    /** The name the customer gave, which is not always the account holder's. */
    approvedBy: text('approved_by'),
    /** Who at the shop took it. */
    takenBy: uuid('taken_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),

    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('repair_order_authorisations_order_idx').on(t.companyId, t.repairOrderId),
    notZero: check('repair_order_authorisations_not_zero', sql`${t.amountCents} <> 0`),
  }),
)
