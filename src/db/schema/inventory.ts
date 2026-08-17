import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  integer,
  bigint,
  index,
  unique,
  check,
  foreignKey,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { journalEntries } from './ledger'
import { serviceItems } from './studio'
import { bills, invoices, vendors } from './receivables'

/**
 * Inventory (spec §5: Retail, Restaurant, Manufacturing, E-commerce, and
 * Wholesale all name it first; §13 "inventory").
 *
 * ## Why this is one module and five industries
 *
 * Five of the industry packs list inventory as their opening capability. They
 * are not five different features: a restaurant's food cost and a wholesaler's
 * warehouse are the same perpetual inventory with different words on the
 * screen. Building it once and letting the packs name it is exactly what spec
 * §23 means by "industry customization extends the common platform rather than
 * creating separate products".
 *
 * ## The subledger identity
 *
 * The rule this schema exists to keep, the same shape as Phase 7's
 * AR-control-equals-subledger check:
 *
 * ```
 *   Σ(open lots' value)  ==  balance of the Inventory account in the ledger
 * ```
 *
 * Every movement of stock writes both a row here and a line in the journal, in
 * one transaction. A test asserts the identity across a busy set of books,
 * because an inventory subledger that has drifted from the ledger is the
 * commonest reason a small business's balance sheet cannot be signed.
 */

/** Which way stock moved, and why. */
export const stockMovementKindEnum = pgEnum('stock_movement_kind', [
  /** Goods arrived — from a purchase receipt or an opening balance. */
  'receipt',
  /** Sold, and relieved at cost. */
  'sale',
  /** A sale undone; stock returns at the cost it left at. */
  'sale_return',
  /** A physical count, or shrinkage, breakage, theft. */
  'adjustment',
  /** Goods sent back to a supplier. */
  'purchase_return',
  /**
   * Raw material issued to a work order (Phase 27).
   *
   * Its own kind rather than an `adjustment`, because the stock did not go
   * missing and it was not sold — it is still an asset, one shelf along, and a
   * report that called it shrinkage would be describing a loss that did not
   * happen.
   */
  'work_order_issue',
])

/**
 * One receipt of stock, and what is left of it.
 *
 * Kept under both cost methods. Under FIFO they are the model; under weighted
 * average they are the audit trail for how an average was arrived at, which is
 * the difference between explaining a cost to an auditor and asserting one.
 */
export const inventoryLots = pgTable(
  'inventory_lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    /** Thousandths of a unit, as everywhere quantities appear. */
    receivedMilli: bigint('received_milli', { mode: 'number' }).notNull(),
    remainingMilli: bigint('remaining_milli', { mode: 'number' }).notNull(),
    /**
     * What is left of this lot is worth this, in cents. **Authoritative.**
     *
     * Not derived from `remainingMilli × unitCostCents`. Deriving it re-rounds
     * on every read against a rate a pooled consumption never used, which is
     * how the subledger and the Inventory account drift apart a cent at a
     * time. See `inventory/costing.ts` for the worked example.
     */
    remainingValueCents: bigint('remaining_value_cents', { mode: 'number' }).notNull(),
    /** The rate this stock arrived at. For reading, never for arithmetic. */
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),

    receivedOn: date('received_on').notNull(),
    /** The receipt, adjustment, or return that created it. */
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Drives every consumption: this company's open lots for one item, oldest
    // first.
    openIdx: index('inventory_lots_open_idx').on(t.companyId, t.itemId, t.receivedOn),
    quantitySane: check(
      'inventory_lots_quantity_sane',
      sql`${t.receivedMilli} > 0 AND ${t.remainingMilli} >= 0 AND ${t.remainingMilli} <= ${t.receivedMilli}`,
    ),
    // Value and quantity empty together. A lot holding cents with no units
    // behind it is value no report can explain; units with no value is stock
    // that became free.
    valueTracksQuantity: check(
      'inventory_lots_value_tracks_quantity',
      sql`(${t.remainingMilli} = 0) = (${t.remainingValueCents} = 0)`,
    ),
    // A negative cost is not a discount, it is a mistake. Zero is allowed:
    // donated or sample stock genuinely costs nothing.
    costNonNegative: check('inventory_lots_cost_non_negative', sql`${t.unitCostCents} >= 0`),
  }),
)

/**
 * Every change in stock, as an append-only record.
 *
 * The lots carry the *position*; this carries the *history*. Both are needed:
 * the position answers "what is on hand and what is it worth", and the history
 * answers "why", which is the question asked when the two stop agreeing.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    kind: stockMovementKindEnum('kind').notNull(),
    movedOn: date('moved_on').notNull(),

    /** Signed thousandths: positive in, negative out. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),
    /** Signed cents, matching the direction of the quantity. */
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),

    /** Which lots it touched, and for how much — the costing decision, frozen. */
    lotBreakdown: text('lot_breakdown'),

    /** Why, for an adjustment. Required by the service, not by the column. */
    reason: text('reason'),
    memo: text('memo'),

    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    /** The entry this movement posted. Null only for a movement that posts none. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemIdx: index('stock_movements_item_idx').on(t.companyId, t.itemId, t.movedOn),
    sourceIdx: index('stock_movements_source_idx').on(t.companyId, t.sourceType, t.sourceId),
    // A movement of nothing is not a movement. Cost may legitimately be zero —
    // a count that found the right quantity of free samples.
    quantityNonZero: check('stock_movements_quantity_non_zero', sql`${t.quantityMilli} <> 0`),
  }),
)

export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'draft',
  /** Sent to the supplier and awaiting goods. */
  'open',
  'partial',
  'received',
  'closed',
  'void',
])

/**
 * A purchase order (spec §5, Retail: "purchase orders").
 *
 * **A purchase order posts nothing.** It is a commitment to buy, not a
 * transaction — no goods have moved and no money is owed. Systems that post a
 * PO overstate both inventory and payables for as long as the supplier takes to
 * ship, which on a slow order is a quarter.
 *
 * What it does buy is the first leg of the three-way match: what was ordered,
 * against what arrived, against what was invoiced.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),

    number: text('number').notNull(),
    orderedOn: date('ordered_on').notNull(),
    expectedOn: date('expected_on'),

    status: purchaseOrderStatusEnum('status').notNull().default('draft'),
    /** What it was expected to cost, for the match. Not an obligation. */
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),

    memo: text('memo'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('purchase_orders_number_unique').on(t.companyId, t.number),
    vendorIdx: index('purchase_orders_vendor_idx').on(t.companyId, t.vendorId, t.status),
  }),
)

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    description: text('description').notNull(),
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),
    /** Running total of what has arrived, so a part shipment is representable. */
    receivedMilli: bigint('received_milli', { mode: 'number' }).notNull().default(0),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    orderIdx: index('purchase_order_lines_order_idx').on(t.purchaseOrderId),
    quantityPositive: check('purchase_order_lines_quantity', sql`${t.quantityMilli} > 0`),
    // Over-receiving is real and allowed; receiving negative goods is not.
    receivedNonNegative: check('purchase_order_lines_received', sql`${t.receivedMilli} >= 0`),
  }),
)

/**
 * Goods arriving.
 *
 * This is where stock and the ledger first move, and it posts
 * `Dr Inventory / Cr Goods Received Not Invoiced` — **not** to Accounts
 * Payable, because no supplier has invoiced yet and a payable that no invoice
 * matches is a payable nobody can reconcile.
 *
 * The alternative most small systems choose — post nothing until the bill
 * arrives — leaves stock physically on the shelf and absent from the books for
 * however long the supplier takes to invoice. At a month end that is a
 * misstatement of both inventory and cost of sales.
 */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id, {
      onDelete: 'set null',
    }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),

    number: text('number').notNull(),
    receivedOn: date('received_on').notNull(),
    /** The supplier's delivery note, for the paper trail. */
    reference: text('reference'),
    memo: text('memo'),

    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    /** Set once a bill has cleared this receipt out of GRNI. */
    billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('goods_receipts_number_unique').on(t.companyId, t.number),
    companyIdx: index('goods_receipts_company_idx').on(t.companyId, t.receivedOn),
    unbilledIdx: index('goods_receipts_unbilled_idx').on(t.companyId, t.billId),
  }),
)

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),
    purchaseOrderLineId: uuid('purchase_order_line_id'),

    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull(),
    /** The lot this line created, so a receipt can be traced to its stock. */
    lotId: uuid('lot_id').references(() => inventoryLots.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    receiptIdx: index('goods_receipt_lines_receipt_idx').on(t.goodsReceiptId),
    quantityPositive: check('goods_receipt_lines_quantity', sql`${t.quantityMilli} > 0`),
    // Named explicitly: the generated name comes to 68 bytes and Postgres
    // truncates past 63 silently rather than refusing, so the constraint would
    // exist under a name nothing later could reference.
    orderLineFk: foreignKey({
      name: 'goods_receipt_lines_po_line_fk',
      columns: [t.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.id],
    }).onDelete('set null'),
  }),
)

/**
 * A physical count or a write-down, with a reason.
 *
 * A reason is required by the service and stated here for the same purpose as
 * a write-off's: stock that vanished with no explanation is either theft, or
 * breakage, or a counting error, and which one it is changes what the business
 * should do next. "Adjustment: −40 units" tells nobody anything.
 */
export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    adjustedOn: date('adjusted_on').notNull(),
    /** What the books said before, so the variance is legible afterwards. */
    expectedMilli: bigint('expected_milli', { mode: 'number' }).notNull(),
    /** What was actually there. */
    countedMilli: bigint('counted_milli', { mode: 'number' }).notNull(),
    /** Signed value of the difference. */
    valueChangeCents: bigint('value_change_cents', { mode: 'number' }).notNull(),

    reason: text('reason').notNull(),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    itemIdx: index('stock_adjustments_item_idx').on(t.companyId, t.itemId, t.adjustedOn),
    reasonGiven: check('stock_adjustments_reason', sql`length(trim(${t.reason})) > 0`),
  }),
)

/**
 * Where a sale's cost came from, so a return can put it back at the same cost.
 *
 * Without this a return restores stock at *today's* average, which invents or
 * destroys value with no transaction behind it: sell at $4, prices rise, take
 * the return in at $6, and $2 of inventory appeared from nowhere.
 */
export const invoiceCostings = pgTable(
  'invoice_costings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'restrict' }),

    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull(),
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),
    /** The consumption, frozen as JSON, for the return path. */
    lotBreakdown: text('lot_breakdown').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('invoice_costings_invoice_idx').on(t.invoiceId),
  }),
)

