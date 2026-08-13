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
} from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'
import { projects } from './crm'

/**
 * Industry modules and the construction pack (spec §5, §20 Phase 7, §23).
 *
 * Everything here is *additive*. There is no second ledger, no parallel job
 * cost table, and no alternative invoice type: job costs are ordinary journal
 * lines carrying a cost-code dimension, and a progress billing produces an
 * ordinary invoice. Spec §20 requires specialized workflows "without forking
 * the core ledger", and the way that is guaranteed is that every number these
 * tables report is a `SUM` over `journal_lines` — the same rows the trial
 * balance reads.
 */

/**
 * A company's override of the modules its industry pack enables.
 *
 * The pack is the default; a row here is a deliberate departure from it. That
 * shape matters: with a plain `enabled` list, changing a pack would silently
 * change existing companies, and with no table at all a plumber could never
 * switch on job costing without also changing industry.
 */
export const companyModules = pgTable(
  'company_modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** A key from INDUSTRY_MODULES. Text, so a new module needs no migration. */
    moduleKey: text('module_key').notNull(),
    /** False is meaningful: it turns off something the pack switched on. */
    enabled: boolean('enabled').notNull().default(true),

    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyModuleUnique: unique('company_modules_unique').on(t.companyId, t.moduleKey),
  }),
)

/** What kind of cost a code collects — the classic job cost breakdown. */
export const costTypeEnum = pgEnum('cost_type', [
  'labor',
  'material',
  'subcontract',
  'equipment',
  'other',
])

/**
 * The cost code library (spec §5 "job costing").
 *
 * A cost code is a *dimension*, not an account. 5110 Job Materials answers
 * "what kind of expense"; cost code 03-300 answers "which part of the work".
 * Keeping them separate is what lets a contractor report concrete framing
 * across every job without adding an account per phase to the chart.
 */
export const costCodes = pgTable(
  'cost_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Optional grouping, e.g. a CSI division name. */
    division: text('division'),
    costType: costTypeEnum('cost_type').notNull().default('other'),

    /**
     * The account job costs on this code normally hit. A suggestion for the
     * person coding a bill, never a substitute for choosing one.
     */
    defaultChartAccountId: uuid('default_chart_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),

    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('cost_codes_company_code_unique').on(t.companyId, t.code),
    companyIdx: index('cost_codes_company_idx').on(t.companyId, t.isActive),
  }),
)

/**
 * A job's budget, one line per cost code (spec §5 "estimates").
 *
 * `originalAmountCents` is the estimate as bid; `changeAmountCents` is the sum
 * of approved change orders. They are kept apart rather than added together
 * because "we are over the revised budget" and "we were over the original bid"
 * are different findings, and a single revised figure can only report one.
 */
export const jobBudgetLines = pgTable(
  'job_budget_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    costCodeId: uuid('cost_code_id')
      .notNull()
      .references(() => costCodes.id, { onDelete: 'restrict' }),

    description: text('description'),
    originalAmountCents: bigint('original_amount_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** Signed: a deductive change order lowers the budget. */
    changeAmountCents: bigint('change_amount_cents', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lineUnique: unique('job_budget_lines_unique').on(t.projectId, t.costCodeId),
    companyIdx: index('job_budget_lines_company_idx').on(t.companyId, t.projectId),
  }),
)

/** A change order's position in its approval path. */
export const changeOrderStatusEnum = pgEnum('change_order_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
])

/**
 * A change order (spec §5).
 *
 * Approving one revises the contract value and the budget. It deliberately
 * posts **nothing** to the ledger: a change order is a change to what will be
 * earned and spent, not a transaction. Revenue still arrives when work is
 * billed and cost still arrives when it is incurred — posting on approval
 * would recognize revenue for work nobody has done yet.
 */
export const changeOrders = pgTable(
  'change_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    number: text('number').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: changeOrderStatusEnum('status').notNull().default('draft'),

    /** Signed change to the contract value — a credit change order is negative. */
    contractAmountCents: bigint('contract_amount_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** Signed change to the cost budget; the sum of this order's lines. */
    costAmountCents: bigint('cost_amount_cents', { mode: 'number' }).notNull().default(0),
    /** Days added to the schedule, for the record if not yet for a Gantt chart. */
    scheduleDays: integer('schedule_days').notNull().default(0),

    requestedOn: date('requested_on'),
    decidedOn: date('decided_on'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decisionNotes: text('decision_notes'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('change_orders_project_number_unique').on(t.projectId, t.number),
    companyIdx: index('change_orders_company_idx').on(t.companyId, t.status),
  }),
)

/** One cost-code slice of a change order's budget impact. */
export const changeOrderLines = pgTable(
  'change_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    changeOrderId: uuid('change_order_id')
      .notNull()
      .references(() => changeOrders.id, { onDelete: 'cascade' }),
    costCodeId: uuid('cost_code_id')
      .notNull()
      .references(() => costCodes.id, { onDelete: 'restrict' }),

    description: text('description'),
    /** Signed budget delta for this cost code. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    orderIdx: index('change_order_lines_order_idx').on(t.changeOrderId),
  }),
)

/**
 * A line of the schedule of values (spec §5 "progress billing").
 *
 * The contract broken into billable items. Progress billings measure percent
 * complete against these, which is what makes an AIA-style application
 * possible without inventing a second contract record.
 */
export const scheduleOfValues = pgTable(
  'schedule_of_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    itemNumber: text('item_number').notNull(),
    description: text('description').notNull(),
    /** The contract value of this item, including approved change orders. */
    scheduledValueCents: bigint('scheduled_value_cents', { mode: 'number' })
      .notNull()
      .default(0),

    /** Revenue account this item bills to. */
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    /** Optional link to the cost side, for item-level margin. */
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),
    /** Set when an approved change order created this item. */
    changeOrderId: uuid('change_order_id').references(() => changeOrders.id, {
      onDelete: 'set null',
    }),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemUnique: unique('schedule_of_values_item_unique').on(t.projectId, t.itemNumber),
    companyIdx: index('schedule_of_values_company_idx').on(t.companyId, t.projectId),
  }),
)
