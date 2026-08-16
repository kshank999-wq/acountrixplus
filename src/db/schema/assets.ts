import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  date,
  index,
  unique,
  pgEnum,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'
import { journalEntries } from './ledger'
import { vendors } from './receivables'
import { projects } from './crm'

/**
 * The fixed asset register (spec §13: "Fixed asset register/depreciation
 * support can be a later professional module if not in MVP").
 *
 * This is a subledger, and it carries the same obligation every subledger in
 * this codebase carries: **it must agree with the ledger.** The sum of the
 * register's costs is the Fixed Assets account; the sum of its depreciation is
 * Accumulated Depreciation. `reconcileFixedAssets` proves both, in the same
 * shape as the inventory identity from ADR 0014.
 */

export const depreciationMethodEnum = pgEnum('depreciation_method', [
  'straight_line',
  'declining_balance',
  'declining_balance_switch',
])

export const depreciationConventionEnum = pgEnum('depreciation_convention', [
  'full_month',
  'mid_month',
  'half_year',
])

export const fixedAssetStatusEnum = pgEnum('fixed_asset_status', [
  /** In service and still depreciating. */
  'active',
  /** Book value has reached salvage. Still owned, still on the balance sheet. */
  'fully_depreciated',
  /** Sold, scrapped, or written off. Cost and depreciation are off the books. */
  'disposed',
])

/**
 * One thing the company owns and writes off over time.
 *
 * ## Registering an asset posts nothing
 *
 * The third time this decision has been the right one — a purchase order posts
 * nothing (ADR 0014), recording time posts nothing (ADR 0015), and registering
 * an asset posts nothing either. The reason is different here, and sharper: by
 * the time an asset reaches the register the money has *already* been spent
 * and coded, usually as a supplier bill against Fixed Assets. Posting the
 * acquisition again would put the truck on the balance sheet twice.
 *
 * `registerAsset` therefore describes something the ledger already knows
 * about, and `reconcileFixedAssets` is what catches the case where it does
 * not — an asset entered in the register that nobody ever coded to Fixed
 * Assets, or a purchase coded there that nobody ever registered. Both are
 * common, both are invisible without the comparison, and both are exactly what
 * a register is for.
 */
export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** The number on the sticker. Sequential per company. */
    tag: text('tag').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Free text: "Vehicles", "Kitchen equipment". Groups the register. */
    category: text('category'),
    serialNumber: text('serial_number'),
    location: text('location'),

    /** What was paid, in cents. The figure the ledger must agree with. */
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),
    /** What it is expected to be worth at the end of its life. Often zero. */
    salvageValueCents: bigint('salvage_value_cents', { mode: 'number' })
      .notNull()
      .default(0),
    lifeMonths: integer('life_months').notNull(),

    method: depreciationMethodEnum('method').notNull().default('straight_line'),
    convention: depreciationConventionEnum('convention').notNull().default('full_month'),
    /**
     * Multiple of the straight-line rate for declining balance, in basis
     * points: 20000 is double-declining, 15000 is 150%. Basis points rather
     * than a float for the same reason every other ratio in this codebase is —
     * a stored 1.9999999999 is a rounding argument waiting to happen.
     */
    decliningFactorBp: integer('declining_factor_bp').notNull().default(20_000),

    /** When it was bought. */
    acquiredDate: date('acquired_date').notNull(),
    /**
     * When it started being used, which is when depreciation starts. An oven
     * sitting in its crate depreciates nothing.
     */
    inServiceDate: date('in_service_date').notNull(),

    /** Where the cost sits on the balance sheet. */
    assetAccountId: uuid('asset_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    /** The contra-asset the depreciation accumulates in. */
    accumulatedAccountId: uuid('accumulated_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    /** Where the monthly charge lands on the profit and loss. */
    expenseAccountId: uuid('expense_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),

    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    /** The job it belongs to, so depreciation can be charged to it. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** The bill or transaction the purchase came in on, when known. */
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),

    status: fixedAssetStatusEnum('status').notNull().default('active'),

    disposedOn: date('disposed_on'),
    /** What it sold for. Zero for something scrapped. */
    disposalProceedsCents: bigint('disposal_proceeds_cents', { mode: 'number' }),
    disposalReason: text('disposal_reason'),
    disposalJournalEntryId: uuid('disposal_journal_entry_id'),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tagUnique: unique('fixed_assets_tag_unique').on(t.companyId, t.tag),
    companyIdx: index('fixed_assets_company_idx').on(t.companyId, t.status, t.inServiceDate),
    categoryIdx: index('fixed_assets_category_idx').on(t.companyId, t.category),
    // Named explicitly: the generated name would exceed Postgres's 63 bytes.
    disposalEntryFk: foreignKey({
      name: 'fixed_assets_disposal_entry_fk',
      columns: [t.disposalJournalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete('set null'),
    // Salvage above cost would mean the asset appreciates, which is a
    // revaluation and not something this module performs.
    salvageBelowCost: check(
      'fixed_assets_salvage_below_cost',
      sql`${t.salvageValueCents} >= 0 AND ${t.salvageValueCents} <= ${t.costCents}`,
    ),
    costPositive: check('fixed_assets_cost_positive', sql`${t.costCents} > 0`),
    lifePositive: check('fixed_assets_life_positive', sql`${t.lifeMonths} >= 1`),
    // Depreciation starts when the asset is used, and it cannot be used before
    // it is owned.
    inServiceAfterAcquired: check(
      'fixed_assets_in_service_after_acquired',
      sql`${t.inServiceDate} >= ${t.acquiredDate}`,
    ),
    // A disposed asset knows when and for how much; one that is not, does not.
    disposalComplete: check(
      'fixed_assets_disposal_complete',
      sql`(${t.status} = 'disposed') = (${t.disposedOn} IS NOT NULL)
          AND (${t.disposedOn} IS NULL) = (${t.disposalProceedsCents} IS NULL)`,
    ),
  }),
)

/**
 * One month of depreciation charged on one asset.
 *
 * ## The unique index is the idempotency
 *
 * `unique(asset_id, period_end)` is what makes running depreciation twice for
 * March safe. It will be run twice: a person clicks the button, a scheduled
 * job fires an hour later, somebody reopens the period and re-runs the close.
 * Each of those is reasonable on its own, and without the constraint the truck
 * quietly depreciates three times in March and nothing on any report looks
 * wrong until the asset is fully written off two years early.
 *
 * The fourth time this shape has been the answer — the deposit uniqueness
 * index in Phase 12, stock relief inside the invoice transaction in Phase 14,
 * the billed-once WHERE clause in Phase 15. Where two actors can act at once,
 * the database arbitrates.
 */
export const depreciationEntries = pgTable(
  'depreciation_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    fixedAssetId: uuid('fixed_asset_id')
      .notNull()
      .references(() => fixedAssets.id, { onDelete: 'cascade' }),

    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Cumulative through this period, snapshotted so the register reads flat. */
    accumulatedCents: bigint('accumulated_cents', { mode: 'number' }).notNull(),

    journalEntryId: uuid('journal_entry_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // See the note above. This is the load-bearing constraint of the module.
    onePerPeriod: unique('depreciation_entries_period_unique').on(t.fixedAssetId, t.periodEnd),
    assetIdx: index('depreciation_entries_asset_idx').on(t.fixedAssetId, t.periodEnd),
    companyIdx: index('depreciation_entries_company_idx').on(t.companyId, t.periodEnd),
    // Named explicitly to stay inside Postgres's identifier limit.
    entryFk: foreignKey({
      name: 'depreciation_entries_journal_fk',
      columns: [t.journalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete('restrict'),
    amountPositive: check('depreciation_entries_amount_positive', sql`${t.amountCents} > 0`),
  }),
)
