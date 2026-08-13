import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  date,
  boolean,
  index,
  unique,
  pgEnum,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { projects } from './crm'
import { assets } from './studio'
import { invoices, vendors } from './receivables'
import { scheduleOfValues } from './jobs'

/**
 * Progress billing and subcontractor compliance (spec §5, §20 Phase 7).
 *
 * Separated from `jobs.ts` only because these tables reference invoices and
 * vendors, and `journal_lines` references the cost-code dimension in
 * `jobs.ts` — keeping the two files apart keeps the schema's import graph
 * acyclic.
 */

/** A progress billing's lifecycle. Only `invoiced` has hit the ledger. */
export const progressBillingStatusEnum = pgEnum('progress_billing_status', [
  'draft',
  'invoiced',
  'void',
])

/**
 * An application for payment (spec §5 "progress billing, retainage").
 *
 * Issuing one creates an ordinary invoice through the ordinary receivables
 * service. This table holds what an invoice does not: which application number
 * it was, what percentage of each contract item is complete, and how much was
 * retained.
 */
export const progressBillings = pgTable(
  'progress_billings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    applicationNumber: integer('application_number').notNull(),
    periodEnd: date('period_end').notNull(),
    billingDate: date('billing_date').notNull(),
    status: progressBillingStatusEnum('status').notNull().default('draft'),

    /** Retainage withheld, in basis points, so 10% is 1000 and stays exact. */
    retainagePercentBp: integer('retainage_percent_bp').notNull().default(0),

    /** Work completed this period, before retainage. */
    thisPeriodCents: bigint('this_period_cents', { mode: 'number' }).notNull().default(0),
    /** Withheld from this application. */
    retainedCents: bigint('retained_cents', { mode: 'number' }).notNull().default(0),
    /** thisPeriodCents − retainedCents: what the customer owes now. */
    netDueCents: bigint('net_due_cents', { mode: 'number' }).notNull().default(0),

    /** True for the final application that bills accumulated retainage. */
    isRetainageRelease: boolean('is_retainage_release').notNull().default(false),

    /** The invoice this became. Null until issued. */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),

    memo: text('memo'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    applicationUnique: unique('progress_billings_application_unique').on(
      t.projectId,
      t.applicationNumber,
    ),
    companyIdx: index('progress_billings_company_idx').on(t.companyId, t.projectId),
    retainageBpRange: check(
      'progress_billings_retainage_range',
      sql`${t.retainagePercentBp} >= 0 AND ${t.retainagePercentBp} <= 10000`,
    ),
  }),
)

/** One schedule-of-values item's progress within one application. */
export const progressBillingLines = pgTable(
  'progress_billing_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    progressBillingId: uuid('progress_billing_id').notNull(),
    scheduleOfValuesId: uuid('schedule_of_values_id').notNull(),

    /** Snapshots, so a reprint of application 3 does not shift when 4 is filed. */
    scheduledValueCents: bigint('scheduled_value_cents', { mode: 'number' })
      .notNull()
      .default(0),
    previousCompletedCents: bigint('previous_completed_cents', { mode: 'number' })
      .notNull()
      .default(0),
    thisPeriodCents: bigint('this_period_cents', { mode: 'number' }).notNull().default(0),
    completedToDateCents: bigint('completed_to_date_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** Completed ÷ scheduled, in basis points. */
    percentCompleteBp: integer('percent_complete_bp').notNull().default(0),

    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    billingIdx: index('progress_billing_lines_billing_idx').on(t.progressBillingId),
    // Both foreign keys are named explicitly: the generated names would exceed
    // Postgres's 63-byte identifier limit and be silently truncated.
    billingFk: foreignKey({
      name: 'progress_billing_lines_billing_fk',
      columns: [t.progressBillingId],
      foreignColumns: [progressBillings.id],
    }).onDelete('cascade'),
    sovFk: foreignKey({
      name: 'progress_billing_lines_sov_fk',
      columns: [t.scheduleOfValuesId],
      foreignColumns: [scheduleOfValues.id],
    }).onDelete('restrict'),
  }),
)

/**
 * A subcontractor: a vendor with compliance obligations (spec §5).
 *
 * Deliberately a *facet* of an existing vendor rather than a new party record.
 * A sub is somebody you already pay bills to, and duplicating them would put
 * their spend in two places.
 */
export const subcontractors = pgTable(
  'subcontractors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),

    trade: text('trade'),
    licenseNumber: text('license_number'),
    /** Default retainage withheld from this sub's bills, in basis points. */
    defaultRetainageBp: integer('default_retainage_bp').notNull().default(0),
    /**
     * Blocks new bills until compliance is current. A warning by default: the
     * decision to stop paying somebody belongs to a person, not a checkbox.
     */
    holdPayments: boolean('hold_payments').notNull().default(false),

    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vendorUnique: unique('subcontractors_vendor_unique').on(t.vendorId),
    companyIdx: index('subcontractors_company_idx').on(t.companyId, t.isActive),
    retainageBpRange: check(
      'subcontractors_retainage_range',
      sql`${t.defaultRetainageBp} >= 0 AND ${t.defaultRetainageBp} <= 10000`,
    ),
  }),
)

/** Compliance document kinds a general contractor collects (spec §5). */
export const complianceKindEnum = pgEnum('compliance_kind', [
  'general_liability',
  'workers_comp',
  'auto_liability',
  'w9',
  'license',
  'lien_waiver',
  'other',
])

/**
 * A compliance document on file for a subcontractor.
 *
 * Expiry is the whole point: an insurance certificate that lapsed last week is
 * worse than one that was never collected, because the file still says it is
 * there.
 */
export const complianceDocuments = pgTable(
  'compliance_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    subcontractorId: uuid('subcontractor_id')
      .notNull()
      .references(() => subcontractors.id, { onDelete: 'cascade' }),
    /** A lien waiver belongs to one job; a W-9 belongs to none. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),

    kind: complianceKindEnum('kind').notNull(),
    reference: text('reference'),
    carrier: text('carrier'),
    coverageAmountCents: bigint('coverage_amount_cents', { mode: 'number' }),

    issuedOn: date('issued_on'),
    /** Null means it does not expire — a W-9, a signed waiver. */
    expiresOn: date('expires_on'),

    /** The scan itself, through the same asset store the studio uses. */
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),

    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subcontractorIdx: index('compliance_documents_sub_idx').on(t.subcontractorId, t.kind),
    // Drives the expiry warning list.
    expiryIdx: index('compliance_documents_expiry_idx').on(t.companyId, t.expiresOn),
  }),
)
