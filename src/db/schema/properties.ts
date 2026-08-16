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
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { customers, invoices } from './receivables'
import { journalEntries } from './ledger'
import { dimensionValues } from './dimensions'

/**
 * Property management (spec §5 "Real Estate / Property — properties, tenants,
 * rents, CAM/expenses, property-level reporting", §20 Phase 7).
 *
 * The `properties` module has been declared since Phase 0, switched on by the
 * real-estate pack, and has done nothing. So have the four accounts that pack
 * installs: `2580 Tenant Security Deposits`, `4300 Rental Income`,
 * `4310 CAM Reimbursements`, `4320 Late Fee Income`. This is where both start
 * meaning something.
 *
 * ## Nothing here forks the ledger
 *
 * ADR 0007's rule for industry modules: extend the common platform, never
 * create a second one. So a rent charge becomes an ordinary invoice, a deposit
 * becomes an ordinary journal entry, and *property-level reporting is Phase
 * 16's dimensional profit and loss* — a property is a dimension value, and the
 * report that already exists answers the question. There is no per-property
 * report in this module, and that absence is the design.
 */

/**
 * A building, a block, a single house — whatever the owner treats as one thing
 * for reporting.
 *
 * The `dimension_value_id` is the whole trick. Creating a property creates a
 * value in a company-wide "Property" dimension, and every posting this module
 * makes tags its line with it. "What did Elm Street earn last quarter" is then
 * a question Phase 16 already answers, across rent, repairs, taxes and
 * anything a bookkeeper coded to the property by hand.
 */
export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Short handle used on reports and pickers: "ELM". */
    code: text('code').notNull(),
    name: text('name').notNull(),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),

    acquiredOn: date('acquired_on'),
    /**
     * Where this property's activity lands on a dimensional report.
     *
     * Not null: a property whose postings cannot be reported on is a property
     * this module has no reason to hold. Created in the same transaction as
     * the property itself.
     */
    dimensionValueId: uuid('dimension_value_id')
      .notNull()
      .references(() => dimensionValues.id, { onDelete: 'restrict' }),

    /**
     * Sold or otherwise gone. Kept rather than deleted — last year's rent roll
     * is a fact about the books, and deleting the property would orphan every
     * charge ever raised against it.
     */
    isActive: boolean('is_active').notNull().default(true),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('properties_company_code_unique').on(t.companyId, t.code),
    companyIdx: index('properties_company_idx').on(t.companyId, t.code),
  }),
)

/** Vacant, let, or deliberately off the market. */
export const unitStatusEnum = pgEnum('unit_status', [
  'available',
  'occupied',
  /** Being refurbished, held back, or otherwise not for let. */
  'unavailable',
])

/**
 * One lettable space inside a property.
 *
 * Units exist separately from leases because **occupancy is measured against
 * units**. A property with four flats and one tenant is 25% occupied, and a
 * model that only stored leases could not say so — it would report 100%, or
 * nothing, depending on how the question was phrased.
 */
export const propertyUnits = pgTable(
  'property_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    /** Unique within the property: "1A", "Ground floor rear". */
    code: text('code').notNull(),
    name: text('name'),

    status: unitStatusEnum('status').notNull().default('available'),
    /** What the owner believes it would let for. Not what any lease charges. */
    marketRentCents: bigint('market_rent_cents', { mode: 'number' }).notNull().default(0),
    /** Square feet or metres — the unit is the company's business. */
    areaUnits: integer('area_units'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('property_units_code_unique').on(t.propertyId, t.code),
    propertyIdx: index('property_units_property_idx').on(t.companyId, t.propertyId, t.status),
    rentNotNegative: check(
      'property_units_market_rent_not_negative',
      sql`${t.marketRentCents} >= 0`,
    ),
  }),
)

export const leaseStatusEnum = pgEnum('lease_status', [
  /** Agreed but not yet started. Bills nothing. */
  'pending',
  'active',
  /** Run its course, or was ended early. Bills nothing further. */
  'ended',
])

/**
 * A tenancy: one unit, one tenant, one rent.
 *
 * The tenant is a `customers` row rather than a type of its own, because a
 * tenant is somebody you invoice — and the real-estate pack's terminology map
 * already renames "Customer" to "Tenant" on screen. A second party table would
 * mean rent could not use the receivables ledger, which is exactly the fork
 * ADR 0007 forbids.
 */
export const leases = pgTable(
  'leases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => propertyUnits.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    status: leaseStatusEnum('status').notNull().default('pending'),

    startsOn: date('starts_on').notNull(),
    /** Null is a month-to-month tenancy, which is most of them. */
    endsOn: date('ends_on'),

    /** Rent for one whole month. Prorated by day when a period is partial. */
    rentCents: bigint('rent_cents', { mode: 'number' }).notNull(),
    /**
     * Day of the month the rent falls due, 1–28.
     *
     * Capped at 28 rather than 31 so that "the 30th" does not silently become
     * "the 28th" in February and shift a due date by two days twice a year.
     */
    dueDay: integer('due_day').notNull().default(1),

    /** What was agreed, which is not necessarily what has been received. */
    depositRequiredCents: bigint('deposit_required_cents', { mode: 'number' })
      .notNull()
      .default(0),

    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedOn: date('ended_on'),
    endedReason: text('ended_reason'),
  },
  (t) => ({
    unitIdx: index('leases_unit_idx').on(t.companyId, t.unitId, t.status),
    customerIdx: index('leases_customer_idx').on(t.companyId, t.customerId),
    rentPositive: check('leases_rent_positive', sql`${t.rentCents} > 0`),
    depositNotNegative: check(
      'leases_deposit_not_negative',
      sql`${t.depositRequiredCents} >= 0`,
    ),
    dueDayInRange: check('leases_due_day_in_range', sql`${t.dueDay} BETWEEN 1 AND 28`),
    /** A tenancy that ends before it starts is a typo, not a tenancy. */
    termOrdered: check(
      'leases_term_ordered',
      sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`,
    ),
  }),
)

/**
 * One period's rent, billed once.
 *
 * The unique index on `(lease_id, period_start)` is the whole idempotency
 * story, and it is deliberately the same shape as Phase 15's billed-once
 * clause and Phase 16's one-charge-per-asset-per-month index: where two people
 * — or a person and a scheduled job — can act at once, the database arbitrates
 * rather than the application checking first and hoping.
 *
 * Running the rent run twice for March therefore bills March once. It is not
 * "the second run finds nothing because we filtered it out"; it is "the second
 * insert loses".
 */
export const rentCharges = pgTable(
  'rent_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),

    /** First day of the period this covers. The idempotency key. */
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),

    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Days charged / days in the period, when the lease covered only part. */
    proratedDays: integer('prorated_days'),
    periodDays: integer('period_days'),

    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oncePerPeriod: unique('rent_charges_lease_period_unique').on(t.leaseId, t.periodStart),
    companyIdx: index('rent_charges_company_idx').on(t.companyId, t.periodStart),
    amountPositive: check('rent_charges_amount_positive', sql`${t.amountCents} > 0`),
    periodOrdered: check('rent_charges_period_ordered', sql`${t.periodEnd} >= ${t.periodStart}`),
  }),
)

/**
 * What happened to a deposit.
 *
 * Received, refunded, or applied against what a tenant owes.
 */
export const depositMovementKindEnum = pgEnum('deposit_movement_kind', [
  'received',
  'refunded',
  /** Kept, against unpaid rent or damage. The moment it becomes revenue. */
  'applied',
])

/**
 * Every movement of somebody else's money, one row each.
 *
 * ## Why movements and not a balance
 *
 * The held amount is `Σ received − Σ refunded − Σ applied`, computed on
 * demand. It is not a column on the lease, and the reason is Phase 20: that
 * phase shipped a cached `reference_count` and the delete path trusted it, and
 * a count that had drifted would have leaked storage or destroyed somebody's
 * evidence. The rows themselves cannot drift.
 *
 * Here the stakes are higher than storage. A drifted deposit balance is a
 * landlord refunding money they no longer hold, or keeping money that was
 * never theirs — so the number is derived from the rows every time, and the
 * rows reconcile to account 2580.
 */
export const depositMovements = pgTable(
  'deposit_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),

    kind: depositMovementKindEnum('kind').notNull(),
    /** Always positive; the kind carries the direction. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    occurredOn: date('occurred_on').notNull(),

    /**
     * The entry this movement posted. Every movement has one — a deposit that
     * moved without touching the ledger is the discrepancy this table exists
     * to make impossible.
     */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    /** Set when an application settled a specific invoice. */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),

    memo: text('memo'),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leaseIdx: index('deposit_movements_lease_idx').on(t.companyId, t.leaseId, t.occurredOn),
    amountPositive: check('deposit_movements_amount_positive', sql`${t.amountCents} > 0`),
  }),
)
