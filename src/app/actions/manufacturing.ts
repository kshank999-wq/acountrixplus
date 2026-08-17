'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  absorbCost,
  cancelWorkOrder,
  completeWorkOrder,
  createBom,
  createWorkOrder,
  issueMaterial,
} from '@/modules/manufacturing/service'
import { formatCents } from '@/lib/money'

/** Server actions for bills of materials and work orders (spec §5, Phase 27). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'That is not a date.')
const milli = z.number().int().positive('That has to be more than nothing.')

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/manufacturing', '/inventory', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

export async function createBomAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        outputItemId: uuid,
        name: z.string().trim().min(1, 'A bill of materials needs a name.'),
        batchMilli: milli,
        notes: z.string().trim().optional(),
        components: z
          .array(
            z.object({
              componentItemId: uuid,
              quantityMilli: milli,
              scrapBp: z.number().int().min(0).max(10_000).optional(),
            }),
          )
          .min(1, 'A bill of materials with no components makes something from nothing.'),
      })
      .parse(input)

    await createBom(actor, parsed)
    return `${parsed.name} saved.`
  })
}

export async function createWorkOrderAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        outputItemId: uuid,
        bomId: uuid.nullable().optional(),
        plannedMilli: milli,
        startedOn: isoDate.optional(),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    const order = await createWorkOrder(actor, parsed)
    return `${order.number} planned. It holds no cost until material is issued.`
  })
}

export async function issueMaterialAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        workOrderId: uuid,
        itemId: uuid,
        quantityMilli: milli,
        occurredOn: isoDate,
        memo: z.string().trim().optional(),
      })
      .parse(input)

    const result = await issueMaterial(actor, parsed)

    if (result.costCents === 0) {
      return 'Nothing was issued — there is none of that item on hand.'
    }

    // The shortfall is said out loud rather than left to be discovered when the
    // unit cost comes out low: a run short of material is a run that will not
    // make what was asked for.
    return result.shortfallMilli > 0
      ? `${formatCents(result.costCents)} issued, but ${(result.shortfallMilli / 1000).toFixed(3)} short. WIP is now ${formatCents(result.wipCents)}.`
      : `${formatCents(result.costCents)} issued at what the lots cost. WIP is now ${formatCents(result.wipCents)}.`
  })
}

export async function absorbCostAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        workOrderId: uuid,
        kind: z.enum(['labour', 'overhead']),
        costCents: z.number().int().positive('An absorption has to be worth something.'),
        occurredOn: isoDate,
        memo: z.string().trim().optional(),
      })
      .parse(input)

    const result = await absorbCost(actor, parsed)
    return `${formatCents(parsed.costCents)} of ${parsed.kind} absorbed. WIP is now ${formatCents(result.wipCents)}.`
  })
}

export async function completeWorkOrderAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        workOrderId: uuid,
        producedMilli: milli,
        scrappedMilli: z.number().int().min(0).optional(),
        completedOn: isoDate,
      })
      .parse(input)

    const result = await completeWorkOrder(actor, parsed)

    const base =
      `${(result.producedMilli / 1000).toFixed(3)} finished at ` +
      `${formatCents(result.unitCostCents)} each. ` +
      `${formatCents(result.totalCents)} left work in process, which is now zero.`

    return result.scrappedMilli > 0
      ? `${base} The ${(result.scrappedMilli / 1000).toFixed(3)} scrapped carried their cost into the good units.`
      : base
  })
}

export async function cancelWorkOrderAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        workOrderId: uuid,
        cancelledOn: isoDate,
        reason: z.string().trim().optional(),
      })
      .parse(input)

    const result = await cancelWorkOrder(actor, parsed)

    return result.writtenOffCents > 0
      ? `Cancelled. ${formatCents(result.writtenOffCents)} written off to Manufacturing Overhead — the material is gone, so it does not go back to the store.`
      : 'Cancelled. It had absorbed nothing, so nothing was written off.'
  })
}
