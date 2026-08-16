import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  index,
  unique,
  pgEnum,
  check,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { journalLines } from './ledger'

/**
 * User-defined accounting dimensions (spec §13: "Classes/departments/
 * locations/projects/jobs **or equivalent** accounting dimensions").
 *
 * Projects and cost codes have been dimensions since Phases 2 and 7, and they
 * are hard columns on `journal_lines` because every company has jobs in some
 * form. What was missing is the other half of that sentence: a restaurant with
 * three locations, an agency with two departments, a nonprofit with restricted
 * funds. Those are not projects — a location does not start, finish, or get
 * billed — and giving each its own column would mean a migration every time a
 * company invents a way of looking at itself.
 *
 * So a dimension is a row a company creates, and a line's value is a row in a
 * join table. The cost is one join in the reporting queries; the benefit is
 * that "Region" is a thing an owner can add on a Tuesday.
 */

/**
 * How strictly a dimension is expected to be filled in.
 *
 * This is deliberately advisory rather than a posting-time refusal, and the
 * reasoning is in ADR 0016. Enforcing "every expense line must carry a
 * Location" at the database means every derived posting path — invoices,
 * bills, payroll, depreciation, inventory relief — must be able to supply one,
 * and the ones that cannot would simply stop working. A rule that turns off
 * payroll to protect a report is not a rule anybody keeps.
 *
 * What `expected` buys instead is a coverage figure and a work list: this is
 * how much of your profit and loss carries a Location, and here are the lines
 * that do not.
 */
export const dimensionRequirementEnum = pgEnum('dimension_requirement', [
  /** Fill it in where it helps. No coverage is reported. */
  'optional',
  /** Coverage is measured and reported against profit-and-loss activity. */
  'expected',
])

/**
 * One way a company slices its books. "Location", "Department", "Class",
 * "Fund", "Region".
 */
export const dimensions = pgTable(
  'dimensions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Shown on reports and pickers: "Location". */
    name: text('name').notNull(),
    /** Short stable handle used in exports and column headers: "LOC". */
    code: text('code').notNull(),
    description: text('description'),

    requirement: dimensionRequirementEnum('requirement').notNull().default('optional'),
    /**
     * Inactive dimensions keep their history and stop appearing on pickers.
     * Deleting one would orphan every assignment ever made, and "we used to
     * track this" is a fact about the books.
     */
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('dimensions_code_unique').on(t.companyId, t.code),
    companyIdx: index('dimensions_company_idx').on(t.companyId, t.isActive, t.sortOrder),
  }),
)

/**
 * One value of a dimension: "Downtown", "Airport", "Warehouse".
 *
 * Values nest, so "West / Portland" can roll up to "West" on a report without
 * a second dimension. The parent must belong to the same dimension, which the
 * service checks — a hierarchy that crosses dimensions is not a hierarchy.
 */
export const dimensionValues = pgTable(
  'dimension_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    dimensionId: uuid('dimension_id')
      .notNull()
      .references(() => dimensions.id, { onDelete: 'cascade' }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => dimensionValues.id, {
      onDelete: 'set null',
    }),

    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('dimension_values_code_unique').on(t.dimensionId, t.code),
    dimensionIdx: index('dimension_values_dimension_idx').on(
      t.companyId,
      t.dimensionId,
      t.isActive,
      t.sortOrder,
    ),
    // A value cannot be its own parent. Deeper cycles are the service's job —
    // the database can only see one hop from here.
    noSelfParent: check('dimension_values_no_self_parent', sql`${t.parentId} <> ${t.id}`),
  }),
)

/**
 * A journal line's value for one dimension.
 *
 * ## The unique index is the whole model
 *
 * `unique(journal_line_id, dimension_id)` is what makes a dimensional report
 * add up. Without it a line could carry two Locations, and it would then be
 * counted under both — so the columns of a report would sum to more than the
 * account they came from, and every figure on the page would be quietly
 * inflated with no way to tell by how much.
 *
 * With it, every line contributes to exactly one column of a dimension's
 * report or to none, and "or to none" is the Unassigned column rather than a
 * silent omission. That is what `dimensionalProfitAndLoss` asserts and what
 * `tests/dimensions.test.ts` checks: **the parts sum to the whole.**
 */
export const journalLineDimensions = pgTable(
  'journal_line_dimensions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    journalLineId: uuid('journal_line_id')
      .notNull()
      .references(() => journalLines.id, { onDelete: 'cascade' }),
    dimensionId: uuid('dimension_id')
      .notNull()
      .references(() => dimensions.id, { onDelete: 'cascade' }),
    dimensionValueId: uuid('dimension_value_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One value per dimension per line. See the note above — this constraint
    // is load-bearing for every dimensional figure in the application.
    oneValuePerDimension: unique('journal_line_dimensions_unique').on(
      t.journalLineId,
      t.dimensionId,
    ),
    // Named explicitly: the generated name would be 65 bytes and Postgres
    // truncates at 63 without saying so.
    valueFk: foreignKey({
      name: 'journal_line_dimensions_value_fk',
      columns: [t.dimensionValueId],
      foreignColumns: [dimensionValues.id],
    }).onDelete('restrict'),
    lineIdx: index('journal_line_dimensions_line_idx').on(t.journalLineId),
    // Drives the reporting join: every line carrying a given value.
    valueIdx: index('journal_line_dimensions_value_idx').on(t.companyId, t.dimensionValueId),
    dimensionIdx: index('journal_line_dimensions_dim_idx').on(t.companyId, t.dimensionId),
  }),
)

/**
 * A default dimension value attached to something that generates postings.
 *
 * A restaurant does not want to tag every line of every supplier bill with
 * "Airport" by hand. It wants to say "this credit card belongs to the Airport
 * site" once, and have the postings inherit it.
 *
 * Defaults apply only when the posting path did not set a value itself, and
 * they apply at the moment of posting rather than at read time. A default
 * changed in June must not silently restate January — the books said what they
 * said, and a report that moves when a setting changes is a report nobody can
 * reconcile to a prior print.
 */
export const dimensionDefaults = pgTable(
  'dimension_defaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /**
     * What carries the default: `financial_account`, `customer`, `vendor`,
     * `chart_account`, `project`. Kept as text plus an id rather than five
     * nullable foreign keys, because the set grows and the table does not care
     * what it points at — the resolver does.
     */
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),

    dimensionId: uuid('dimension_id')
      .notNull()
      .references(() => dimensions.id, { onDelete: 'cascade' }),
    dimensionValueId: uuid('dimension_value_id')
      .notNull()
      .references(() => dimensionValues.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // One default per dimension per owner, for the same reason a line carries
    // one value per dimension.
    ownerUnique: unique('dimension_defaults_unique').on(t.ownerType, t.ownerId, t.dimensionId),
    lookupIdx: index('dimension_defaults_lookup_idx').on(t.companyId, t.ownerType, t.ownerId),
  }),
)
