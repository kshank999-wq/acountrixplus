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
import { serviceItems } from './studio'
import { journalEntries } from './ledger'

/**
 * Manufacturing (spec §5, "Manufacturing — Raw materials, WIP, finished goods,
 * BOM/costing").
 *
 * The `manufacturing` module has been declared since Phase 0, switched on by
 * the manufacturing pack, and has done nothing. So have the seven accounts that
 * pack installs — `1440 Raw Materials`, `1450 Work in Process`, `1460 Finished
 * Goods`, `5060 Direct Materials`, `5070 Direct Labor`, `5080 Manufacturing
 * Overhead`. This is where all of it starts meaning something.
 *
 * ## Nothing here forks the ledger, and nothing here forks inventory either
 *
 * ADR 0007's rule, applied twice. A raw material and a finished good are both
 * ordinary `service_items` with `tracks_inventory` set; they sit on different
 * balance-sheet lines because Phase 14 already lets an item name its own
 * inventory account, and that seam was written for exactly this.
 *
 * Issuing material to a run is Phase 14's `consumeStock` debiting WIP instead
 * of COGS. Finishing a run is Phase 14's `receiveStock` crediting WIP instead
 * of a supplier. **There is no second costing engine** — a work order's cost is
 * whatever the lots it consumed were worth, decided by FIFO or weighted average
 * the same way a sale's is.
 *
 * ## The claim
 *
 * **Cost moves with the material, and nothing is created or destroyed.** Every
 * penny that enters WIP leaves it, into finished goods; a completed work order
 * has a WIP balance of exactly zero. `wip_cents` on the row is what makes that
 * assertable against the ledger rather than merely intended.
 */

/**
 * A recipe: how much of what makes how many of something else.
 *
 * Versioned by `is_active` rather than by a version number, because the
 * question a work order needs answered is "which BOM was in force when this ran"
 * and the answer is on the work order — it stores the components it exploded.
 * A BOM edited after a run does not retrospectively change what that run
 * needed, and a version column would imply an ordering nobody maintains.
 */
export const billsOfMaterials = pgTable(
  'bills_of_materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** What this makes. An inventoried item like any other. */
    outputItemId: uuid('output_item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),

    /**
     * How many the component quantities are written for, in thousandths.
     *
     * A recipe for 100 loaves rather than for one, because a BOM for a single
     * unit of something made in hundreds forces every component quantity
     * through a rounding it never needed. `explodeBom` scales in one step.
     */
    batchMilli: bigint('batch_milli', { mode: 'number' }).notNull(),

    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    outputIdx: index('boms_output_idx').on(t.companyId, t.outputItemId, t.isActive),
    batchPositive: check('boms_batch_positive', sql`${t.batchMilli} > 0`),
  }),
)

/** One component line of a bill of materials. */
export const bomComponents = pgTable(
  'bom_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    bomId: uuid('bom_id')
      .notNull()
      .references(() => billsOfMaterials.id, { onDelete: 'cascade' }),
    componentItemId: uuid('component_item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    /** Thousandths of this component per batch. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),

    /**
     * Expected wastage, in basis points — ratios are basis points everywhere.
     *
     * 250 means "issue 2.5% more than the drawing says, because that much ends
     * up on the floor". Expected wastage belongs on the component rather than
     * the run: it is a property of the material, not of the day.
     */
    scrapBp: integer('scrap_bp').notNull().default(0),

    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    // One line per component per BOM. Two lines for the same part is one part
    // requirement and one silent disagreement about which is right.
    componentUnique: unique('bom_components_unique').on(t.bomId, t.componentItemId),
    bomIdx: index('bom_components_bom_idx').on(t.companyId, t.bomId),
    quantityPositive: check('bom_components_quantity_positive', sql`${t.quantityMilli} > 0`),
    scrapSane: check(
      'bom_components_scrap_sane',
      sql`${t.scrapBp} >= 0 AND ${t.scrapBp} <= 10000`,
    ),
  }),
)

/**
 * Where a run has got to.
 *
 * `released` is the only state that holds WIP, and that is the whole reason the
 * states exist: a draft has absorbed nothing, and a completed or cancelled run
 * has absorbed nothing *left*. Anything else would make "what is in WIP" a
 * question about status rather than about money.
 */
export const workOrderStatusEnum = pgEnum('work_order_status', [
  /** Planned. Holds no cost and consumes no stock. */
  'draft',
  /** In progress. Material has been issued; WIP is real. */
  'released',
  /** Finished. WIP cleared into finished goods, and is exactly zero. */
  'completed',
  /** Abandoned. WIP written off; also exactly zero. */
  'cancelled',
])

/**
 * One production run.
 *
 * `wip_cents` is a stored figure and every other number in this application is
 * derived — so it needs a defence. It is here because it is the *subledger*
 * side of a reconciliation, not a cache of the ledger: `wipPosition` compares
 * the sum of these against account 1450 and says whether they agree, the same
 * shape Phase 14 uses for inventory and Phase 23 for tenant deposits. A figure
 * derived from the same journal lines it is being checked against would
 * reconcile perfectly and prove nothing.
 */
export const workOrders = pgTable(
  'work_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Short handle: WO-0007. Unique per company. */
    number: text('number').notNull(),

    outputItemId: uuid('output_item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),
    /** Null when somebody ran something without a recipe, which happens. */
    bomId: uuid('bom_id').references(() => billsOfMaterials.id, { onDelete: 'set null' }),

    status: workOrderStatusEnum('status').notNull().default('draft'),

    /** What was asked for, in thousandths. */
    plannedMilli: bigint('planned_milli', { mode: 'number' }).notNull(),
    /** Good units produced. Set on completion. */
    producedMilli: bigint('produced_milli', { mode: 'number' }).notNull().default(0),
    /** Units that came off the line unusable. Their cost stays with the good ones. */
    scrappedMilli: bigint('scrapped_milli', { mode: 'number' }).notNull().default(0),

    /** Cost absorbed and not yet released. Zero once completed or cancelled. */
    wipCents: bigint('wip_cents', { mode: 'number' }).notNull().default(0),
    /** What the run absorbed in total, kept after completion clears WIP. */
    materialCents: bigint('material_cents', { mode: 'number' }).notNull().default(0),
    labourCents: bigint('labour_cents', { mode: 'number' }).notNull().default(0),
    overheadCents: bigint('overhead_cents', { mode: 'number' }).notNull().default(0),

    startedOn: date('started_on'),
    completedOn: date('completed_on'),

    /** The lot the finished goods landed in, so a run can be traced forward. */
    outputLotId: uuid('output_lot_id'),
    /** The entry that moved WIP into finished goods, or wrote it off. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('work_orders_company_number_unique').on(t.companyId, t.number),
    statusIdx: index('work_orders_status_idx').on(t.companyId, t.status),
    plannedPositive: check('work_orders_planned_positive', sql`${t.plannedMilli} > 0`),
    quantitiesNotNegative: check(
      'work_orders_quantities_not_negative',
      sql`${t.producedMilli} >= 0 AND ${t.scrappedMilli} >= 0 AND ${t.wipCents} >= 0`,
    ),
    // The claim, as a constraint: a run that is over holds nothing.
    settledHoldsNothing: check(
      'work_orders_settled_holds_nothing',
      sql`${t.status} IN ('draft', 'released') OR ${t.wipCents} = 0`,
    ),
  }),
)

/** What went into a run: material issued, or labour and overhead absorbed. */
export const workOrderEntryKindEnum = pgEnum('work_order_entry_kind', [
  /** Stock taken from the store, costed from its lots. */
  'material',
  /** People. Absorbed out of Direct Labor into WIP. */
  'labour',
  /** Everything else the factory costs. */
  'overhead',
])

/**
 * One thing a run absorbed.
 *
 * Material rows carry an item and a quantity; labour and overhead carry only
 * money, because an hour is not a thing you can take out of a store. Keeping
 * all three in one table rather than two is what lets "what did this run cost,
 * and in what order" be a single ordered read — which is the question somebody
 * asks when a unit cost comes out wrong.
 */
export const workOrderEntries = pgTable(
  'work_order_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),

    kind: workOrderEntryKindEnum('kind').notNull(),

    /** Set for material, null for labour and overhead. */
    itemId: uuid('item_id').references(() => serviceItems.id, { onDelete: 'restrict' }),
    quantityMilli: bigint('quantity_milli', { mode: 'number' }),

    /** What it cost. For material this comes from the lots, never a price list. */
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),

    occurredOn: date('occurred_on').notNull(),
    memo: text('memo'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('work_order_entries_order_idx').on(t.companyId, t.workOrderId, t.occurredOn),
    costPositive: check('work_order_entries_cost_positive', sql`${t.costCents} > 0`),
    // Material needs something to have moved; labour and overhead must not
    // claim a quantity of an item they never touched.
    materialHasItem: check(
      'work_order_entries_material_has_item',
      sql`(${t.kind} = 'material' AND ${t.itemId} IS NOT NULL AND ${t.quantityMilli} > 0)
          OR (${t.kind} <> 'material' AND ${t.itemId} IS NULL AND ${t.quantityMilli} IS NULL)`,
    ),
  }),
)
