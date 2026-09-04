import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  goodsReceiptLines,
  goodsReceipts,
  purchaseOrderLines,
  purchaseOrders,
  serviceItems,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { extend } from './costing'
import { inventoryAccounts, receiveStock } from './service'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

/**
 * Purchase orders, receiving, and the three-way match (spec §5, Retail:
 * "purchase orders").
 *
 * ## The chain, and why it has three links
 *
 * ```
 *   Order      what we asked for      posts nothing
 *   Receive    what turned up         Dr Inventory   Cr Goods Received Not Invoiced
 *   Bill       what we were charged   Dr Goods Received…   Cr Accounts Payable
 * ```
 *
 * Most small systems collapse this to one step and post inventory when the
 * bill arrives. That is wrong in a specific and expensive way: between the
 * pallet arriving and the invoice being entered — often weeks — the stock is
 * physically on the shelf and absent from the books. Sell from it in that
 * window and the cost of sales has nothing to relieve. At a month end it
 * misstates inventory, cost of sales, and margin simultaneously.
 *
 * **Goods Received Not Invoiced** is the account that holds the gap. It is a
 * real liability: the goods are ours and we owe for them, we simply have not
 * been told how much yet. When the bill lands it clears to Accounts Payable.
 *
 * ## What the match is for
 *
 * Ordered 100, received 96, billed for 100 — each number is defensible on its
 * own and together they say a supplier is charging for four units that never
 * arrived. That comparison is the entire control, and it only exists because
 * all three were recorded separately.
 */

export type PurchaseOrderLineInput = {
  itemId: string
  description?: string
  quantityMilli: number
  unitCostCents: number
}

export async function createPurchaseOrder(
  ctx: ActorContext,
  input: {
    vendorId: string
    orderedOn: string
    expectedOn?: string
    lines: PurchaseOrderLineInput[]
    memo?: string
    number?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'inventory')

  if (input.lines.length === 0) throw new Refusal('A purchase order needs at least one line.')

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, input.vendorId)))
    .limit(1)

  if (!vendor) throw missing('vendor')

  const items = await db
    .select()
    .from(serviceItems)
    .where(scoped(ctx, serviceItems))

  const itemsById = new Map(items.map((item) => [item.id, item]))

  for (const line of input.lines) {
    const item = itemsById.get(line.itemId)
    if (!item) throw new Refusal('One of those items could not be found.')
    if (line.quantityMilli <= 0) throw new Refusal('Order a quantity greater than zero.')
  }

  const totalCents = input.lines.reduce(
    (sum, line) => sum + extend(line.quantityMilli, line.unitCostCents),
    0,
  )

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextNumber(ctx, tx, purchaseOrders, 'PO'))

    const [order] = await tx
      .insert(purchaseOrders)
      .values({
        companyId: ctx.companyId,
        vendorId: input.vendorId,
        number,
        orderedOn: input.orderedOn,
        expectedOn: input.expectedOn ?? null,
        // Straight to `open`: a draft purchase order that nobody sent is a
        // note to self, and the status is for tracking what the supplier has
        // been told.
        status: 'open',
        totalCents,
        memo: input.memo ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(purchaseOrderLines).values(
      input.lines.map((line, index) => ({
        companyId: ctx.companyId,
        purchaseOrderId: order.id,
        itemId: line.itemId,
        description: line.description ?? itemsById.get(line.itemId)!.name,
        quantityMilli: line.quantityMilli,
        unitCostCents: line.unitCostCents,
        sortOrder: index,
      })),
    )

    // No journal entry, deliberately. An order is a commitment, not a
    // transaction: no goods have moved and no money is owed.
    await recordAudit(
      ctx,
      {
        action: 'purchase_order.create',
        entityType: 'purchase_order',
        entityId: order.id,
        after: { number, vendor: vendor.name, totalCents, lines: input.lines.length },
      },
      tx,
    )

    return order
  })
}

export type ReceiptLineInput = {
  purchaseOrderLineId?: string
  itemId: string
  quantityMilli: number
  /** Defaults to the ordered cost when receiving against a line. */
  unitCostCents?: number
}

/**
 * Records what actually turned up.
 *
 * Over- and under-receiving are both allowed. A supplier who ships 96 of 100
 * has done a thing that happened, and a system that refuses to record it
 * teaches people to record a lie instead.
 */
export async function receiveGoods(
  ctx: ActorContext,
  input: {
    vendorId: string
    receivedOn: string
    purchaseOrderId?: string
    lines: ReceiptLineInput[]
    reference?: string
    memo?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'inventory')

  if (input.lines.length === 0) throw new Refusal('A receipt needs at least one line.')

  const accounts = await inventoryAccounts(ctx.companyId)

  return db.transaction(async (tx) => {
    const orderLines = input.purchaseOrderId
      ? await tx
          .select()
          .from(purchaseOrderLines)
          .where(
            and(
              eq(purchaseOrderLines.companyId, ctx.companyId),
              eq(purchaseOrderLines.purchaseOrderId, input.purchaseOrderId),
            ),
          )
      : []

    const orderLinesById = new Map(orderLines.map((line) => [line.id, line]))

    const number = await nextNumber(ctx, tx, goodsReceipts, 'GR')

    const [receipt] = await tx
      .insert(goodsReceipts)
      .values({
        companyId: ctx.companyId,
        purchaseOrderId: input.purchaseOrderId ?? null,
        vendorId: input.vendorId,
        number,
        receivedOn: input.receivedOn,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    let totalCents = 0

    for (const [index, line] of input.lines.entries()) {
      const orderLine = line.purchaseOrderLineId
        ? orderLinesById.get(line.purchaseOrderLineId)
        : undefined

      const unitCostCents = line.unitCostCents ?? orderLine?.unitCostCents
      if (unitCostCents === undefined) {
        throw new Refusal('A receipt line with no purchase order needs a cost.')
      }

      // Each line brings its own stock in and posts its own leg, so a receipt
      // of three items is three lots and one Goods Received Not Invoiced
      // credit per line — which keeps the lot traceable to the line.
      const { lotId, costCents } = await receiveStock(
        ctx,
        {
          itemId: line.itemId,
          quantityMilli: line.quantityMilli,
          unitCostCents,
          receivedOn: input.receivedOn,
          creditAccountId: accounts.grniId,
          sourceType: 'goods_receipt',
          sourceId: receipt.id,
          memo: `Received on ${number}`,
        },
        tx,
      )

      totalCents += costCents

      await tx.insert(goodsReceiptLines).values({
        companyId: ctx.companyId,
        goodsReceiptId: receipt.id,
        itemId: line.itemId,
        purchaseOrderLineId: line.purchaseOrderLineId ?? null,
        quantityMilli: line.quantityMilli,
        unitCostCents,
        lotId,
        sortOrder: index,
      })

      if (orderLine) {
        await tx
          .update(purchaseOrderLines)
          .set({
            receivedMilli: sql`${purchaseOrderLines.receivedMilli} + ${line.quantityMilli}`,
          })
          .where(eq(purchaseOrderLines.id, orderLine.id))
      }
    }

    await tx.update(goodsReceipts).set({ totalCents }).where(eq(goodsReceipts.id, receipt.id))

    if (input.purchaseOrderId) {
      await refreshOrderStatus(ctx, input.purchaseOrderId, tx)
    }

    await recordAudit(
      ctx,
      {
        action: 'purchase_order.receive',
        entityType: 'goods_receipt',
        entityId: receipt.id,
        after: { number, totalCents, lines: input.lines.length },
      },
      tx,
    )

    return { ...receipt, totalCents }
  })
}

/**
 * Recomputes a purchase order's status from what has actually arrived.
 *
 * Derived rather than set, so it cannot disagree with the receipts. `partial`
 * where something but not everything has come; `received` once every line is
 * satisfied — including over-shipments, which count as satisfied rather than
 * leaving an order permanently open for having received too much.
 */
async function refreshOrderStatus(ctx: ActorContext, orderId: string, tx: Executor) {
  const lines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.companyId, ctx.companyId),
        eq(purchaseOrderLines.purchaseOrderId, orderId),
      ),
    )

  const anyReceived = lines.some((line) => line.receivedMilli > 0)
  const allReceived = lines.every((line) => line.receivedMilli >= line.quantityMilli)

  await tx
    .update(purchaseOrders)
    .set({
      status: allReceived ? 'received' : anyReceived ? 'partial' : 'open',
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, orderId))
}

export type ThreeWayMatch = {
  itemId: string
  itemName: string
  orderedMilli: number
  receivedMilli: number
  orderedCostCents: number
  receivedCostCents: number
  /** Received minus ordered. Negative is a short shipment. */
  quantityVarianceMilli: number
  /** What the supplier charged per unit against what was agreed. */
  priceVarianceCents: number
  hasVariance: boolean
}

/**
 * Ordered against received, per item.
 *
 * The billed leg is the goods receipt's own value, since that is what will be
 * cleared out of Goods Received Not Invoiced — so a supplier invoice differing
 * from it shows up as a residue in that account, which is the point of keeping
 * it separate.
 */
export async function matchPurchaseOrder(
  ctx: ActorContext,
  purchaseOrderId: string,
): Promise<ThreeWayMatch[]> {
  requirePermission(ctx, 'accounting:view')

  const lines = await db
    .select({
      itemId: purchaseOrderLines.itemId,
      itemName: serviceItems.name,
      orderedMilli: purchaseOrderLines.quantityMilli,
      receivedMilli: purchaseOrderLines.receivedMilli,
      unitCostCents: purchaseOrderLines.unitCostCents,
      lineId: purchaseOrderLines.id,
    })
    .from(purchaseOrderLines)
    .innerJoin(serviceItems, eq(serviceItems.id, purchaseOrderLines.itemId))
    .where(
      and(
        eq(purchaseOrderLines.companyId, ctx.companyId),
        eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
      ),
    )
    .orderBy(asc(purchaseOrderLines.sortOrder))

  const receiptLines = await db
    .select({
      purchaseOrderLineId: goodsReceiptLines.purchaseOrderLineId,
      quantityMilli: goodsReceiptLines.quantityMilli,
      unitCostCents: goodsReceiptLines.unitCostCents,
    })
    .from(goodsReceiptLines)
    .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.goodsReceiptId))
    .where(
      and(
        eq(goodsReceiptLines.companyId, ctx.companyId),
        eq(goodsReceipts.purchaseOrderId, purchaseOrderId),
      ),
    )

  return lines.map((line) => {
    const received = receiptLines.filter((row) => row.purchaseOrderLineId === line.lineId)

    const receivedCostCents = received.reduce(
      (sum, row) => sum + extend(row.quantityMilli, row.unitCostCents),
      0,
    )
    const orderedCostCents = extend(line.orderedMilli, line.unitCostCents)
    const expectedForReceived = extend(line.receivedMilli, line.unitCostCents)

    const quantityVarianceMilli = line.receivedMilli - line.orderedMilli
    const priceVarianceCents = receivedCostCents - expectedForReceived

    return {
      itemId: line.itemId,
      itemName: line.itemName,
      orderedMilli: line.orderedMilli,
      receivedMilli: line.receivedMilli,
      orderedCostCents,
      receivedCostCents,
      quantityVarianceMilli,
      priceVarianceCents,
      hasVariance: quantityVarianceMilli !== 0 || priceVarianceCents !== 0,
    }
  })
}

/**
 * Receipts that have arrived and not been billed.
 *
 * This *is* the Goods Received Not Invoiced balance, itemised. An accountant
 * looking at that account at a period end asks "what is in it", and the answer
 * has to be a list of deliveries rather than a number.
 */
export async function unbilledReceipts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: goodsReceipts.id,
      number: goodsReceipts.number,
      receivedOn: goodsReceipts.receivedOn,
      // Carried since Phase 48: one bill settles one supplier's deliveries, so
      // the screen has to be able to tell which is which.
      vendorId: goodsReceipts.vendorId,
      vendorName: vendors.name,
      totalCents: goodsReceipts.totalCents,
      reference: goodsReceipts.reference,
    })
    .from(goodsReceipts)
    .innerJoin(vendors, eq(vendors.id, goodsReceipts.vendorId))
    .where(scoped(ctx, goodsReceipts, isNull(goodsReceipts.billId)))
    .orderBy(asc(goodsReceipts.receivedOn))
}

/**
 * Marks receipts as billed and clears them out of Goods Received Not Invoiced.
 *
 * The bill itself is created by the receivables module in the usual way, with
 * its lines posted against Goods Received Not Invoiced instead of an expense
 * account — which is what makes this a clearing entry rather than a second
 * recognition of the same cost.
 *
 * When the invoice differs from the receipt, the difference stays in that
 * account as a visible residue. Silently absorbing it into inventory would
 * change what stock is carried at, weeks after it arrived, with nothing on any
 * report to say so.
 */
export async function attachBillToReceipts(
  ctx: ActorContext,
  input: { billId: string; receiptIds: string[]; billTotalCents: number },
  exec: Executor = db,
): Promise<{ clearedCents: number; residueCents: number }> {
  requirePermission(ctx, 'accounting:journal')

  if (input.receiptIds.length === 0) return { clearedCents: 0, residueCents: 0 }

  const receipts = await exec
    .select()
    .from(goodsReceipts)
    .where(
      and(
        eq(goodsReceipts.companyId, ctx.companyId),
        // `inArray`, not a hand-built ARRAY literal: postgres-js does not bind
        // an array through `= ANY(...)`, and building the SQL by string
        // concatenation from ids would be an injection waiting for the day one
        // of them is not a uuid.
        inArray(goodsReceipts.id, input.receiptIds),
      ),
    )

  const alreadyBilled = receipts.find((receipt) => receipt.billId !== null)
  if (alreadyBilled) {
    throw new Refusal(
      `Receipt ${alreadyBilled.number} has already been billed. Billing it twice would double the payable.`,
    )
  }

  const clearedCents = receipts.reduce((sum, receipt) => sum + receipt.totalCents, 0)

  for (const receipt of receipts) {
    await exec
      .update(goodsReceipts)
      .set({ billId: input.billId })
      .where(eq(goodsReceipts.id, receipt.id))
  }

  return { clearedCents, residueCents: input.billTotalCents - clearedCents }
}

export async function listPurchaseOrders(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: purchaseOrders.id,
      number: purchaseOrders.number,
      orderedOn: purchaseOrders.orderedOn,
      expectedOn: purchaseOrders.expectedOn,
      status: purchaseOrders.status,
      totalCents: purchaseOrders.totalCents,
      vendorName: vendors.name,
    })
    .from(purchaseOrders)
    .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(scoped(ctx, purchaseOrders))
    .orderBy(desc(purchaseOrders.orderedOn))
    .limit(opts.limit ?? 50)
}

export async function purchaseOrderWithLines(ctx: ActorContext, orderId: string) {
  requirePermission(ctx, 'accounting:view')

  const [order] = await db
    .select()
    .from(purchaseOrders)
    .where(scoped(ctx, purchaseOrders, eq(purchaseOrders.id, orderId)))
    .limit(1)

  if (!order) throw missing('purchaseOrder')

  const lines = await db
    .select({
      id: purchaseOrderLines.id,
      itemId: purchaseOrderLines.itemId,
      itemName: serviceItems.name,
      unit: serviceItems.unit,
      description: purchaseOrderLines.description,
      quantityMilli: purchaseOrderLines.quantityMilli,
      receivedMilli: purchaseOrderLines.receivedMilli,
      unitCostCents: purchaseOrderLines.unitCostCents,
    })
    .from(purchaseOrderLines)
    .innerJoin(serviceItems, eq(serviceItems.id, purchaseOrderLines.itemId))
    .where(
      and(
        eq(purchaseOrderLines.companyId, ctx.companyId),
        eq(purchaseOrderLines.purchaseOrderId, orderId),
      ),
    )
    .orderBy(asc(purchaseOrderLines.sortOrder))

  return { order, lines }
}

/** Sequential per company, per document kind. */
async function nextNumber(
  ctx: ActorContext,
  tx: Executor,
  table: typeof purchaseOrders | typeof goodsReceipts,
  prefix: string,
): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(table)
    .where(eq(table.companyId, ctx.companyId))

  return `${prefix}-${1001 + Number(row?.count ?? 0)}`
}
