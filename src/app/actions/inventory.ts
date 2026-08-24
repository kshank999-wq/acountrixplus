'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import { serviceItems } from '@/db/schema'
import { requireActor } from '@/lib/current-user'
import { requirePermission, scoped } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import { adjustStock } from '@/modules/inventory/service'
import { createPurchaseOrder, receiveGoods } from '@/modules/inventory/purchasing'
import { requireModule } from '@/modules/industry/modules'
import { messageFor } from '@/modules/errors'

/** Server actions for the inventory workspace (spec §5, Phase 14). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/inventory', '/inventory/purchasing', '/accounting/reports']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31.')
/** Quantities are typed as units and stored as thousandths. */
const quantity = z.number().finite().nonnegative()

const itemSchema = z.object({
  name: z.string().trim().min(1, 'An item needs a name.'),
  code: z.string().trim().optional(),
  unit: z.string().trim().default('each'),
  unitPriceCents: z.number().int().nonnegative(),
  unitCostCents: z.number().int().nonnegative(),
  isInventoried: z.boolean(),
  reorderPoint: quantity.optional(),
  chartAccountId: uuid.optional(),
})

export async function saveItemAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'accounting:journal')
    const parsed = itemSchema.parse(input)

    if (parsed.isInventoried) await requireModule(actor, 'inventory')

    const [item] = await db
      .insert(serviceItems)
      .values({
        companyId: actor.companyId,
        name: parsed.name,
        code: parsed.code || null,
        unit: parsed.unit || 'each',
        unitPriceCents: parsed.unitPriceCents,
        unitCostCents: parsed.unitCostCents,
        isInventoried: parsed.isInventoried,
        reorderPointMilli:
          parsed.reorderPoint === undefined ? null : Math.round(parsed.reorderPoint * 1000),
        chartAccountId: parsed.chartAccountId ?? null,
      })
      .returning()

    await recordAudit(actor, {
      action: 'item.update',
      entityType: 'service_item',
      entityId: item.id,
      after: { name: item.name, isInventoried: item.isInventoried },
    })

    return parsed.isInventoried
      ? `${item.name} added. Receive some stock to give it a quantity and a value.`
      : `${item.name} added.`
  })
}

export async function setReorderPointAction(
  itemId: unknown,
  reorderPoint: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    requirePermission(actor, 'accounting:journal')

    const id = uuid.parse(itemId)
    const point = quantity.parse(reorderPoint)

    await db
      .update(serviceItems)
      .set({ reorderPointMilli: Math.round(point * 1000) })
      .where(scoped(actor, serviceItems, eq(serviceItems.id, id)))

    return 'Reorder point saved.'
  })
}

const adjustSchema = z.object({
  itemId: uuid,
  counted: quantity,
  adjustedOn: isoDate,
  reason: z.string().trim().min(1, 'Say why the count differs.'),
})

export async function adjustStockAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = adjustSchema.parse(input)

    const result = await adjustStock(actor, {
      itemId: parsed.itemId,
      countedMilli: Math.round(parsed.counted * 1000),
      adjustedOn: parsed.adjustedOn,
      reason: parsed.reason,
    })

    if (result.varianceMilli === 0) return 'Counted, and the books were right. Nothing posted.'

    return result.varianceMilli < 0
      ? `Short by ${Math.abs(result.varianceMilli) / 1000}. Booked to Inventory Shrinkage.`
      : `Over by ${result.varianceMilli / 1000}. Booked against Inventory Shrinkage.`
  })
}

const orderSchema = z.object({
  vendorId: uuid,
  orderedOn: isoDate,
  expectedOn: isoDate.optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        quantity: z.number().finite().positive(),
        unitCostCents: z.number().int().nonnegative(),
      }),
    )
    .min(1, 'A purchase order needs at least one line.'),
  memo: z.string().trim().optional(),
})

export async function createPurchaseOrderAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = orderSchema.parse(input)

    const order = await createPurchaseOrder(actor, {
      vendorId: parsed.vendorId,
      orderedOn: parsed.orderedOn,
      expectedOn: parsed.expectedOn,
      memo: parsed.memo || undefined,
      lines: parsed.lines.map((line) => ({
        itemId: line.itemId,
        quantityMilli: Math.round(line.quantity * 1000),
        unitCostCents: line.unitCostCents,
      })),
    })

    return `${order.number} raised. Nothing is posted until the goods arrive.`
  })
}

const receiveSchema = z.object({
  vendorId: uuid,
  receivedOn: isoDate,
  purchaseOrderId: uuid.optional(),
  reference: z.string().trim().optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: uuid.optional(),
        itemId: uuid,
        quantity: z.number().finite().positive(),
        unitCostCents: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1, 'A receipt needs at least one line.'),
})

export async function receiveGoodsAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = receiveSchema.parse(input)

    const receipt = await receiveGoods(actor, {
      vendorId: parsed.vendorId,
      receivedOn: parsed.receivedOn,
      purchaseOrderId: parsed.purchaseOrderId,
      reference: parsed.reference || undefined,
      lines: parsed.lines.map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        itemId: line.itemId,
        quantityMilli: Math.round(line.quantity * 1000),
        unitCostCents: line.unitCostCents,
      })),
    })

    return `${receipt.number} received. The stock is on the books and sits in Goods Received Not Invoiced until the supplier bills you.`
  })
}
