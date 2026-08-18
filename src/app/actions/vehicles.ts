'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  addLine,
  addVehicle,
  authorise,
  cancelRepairOrder,
  completeRepairOrder,
  openRepairOrder,
  recordOdometer,
} from '@/modules/vehicles/service'
import { takePayment } from '@/modules/counter/service'
import { formatCents } from '@/lib/money'

/** Server actions for the shop (spec §5, Phase 30). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const cents = z.number().int().min(0)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/shop', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

export async function addVehicleAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        registration: z.string().trim().optional(),
        vin: z.string().trim().optional(),
        make: z.string().trim().optional(),
        model: z.string().trim().optional(),
        year: z.number().int().min(1885).max(2200).optional(),
        odometerMiles: z.number().int().min(0).optional(),
      })
      .parse(input)

    await addVehicle(actor, parsed)
    return `${parsed.registration || parsed.vin || 'The vehicle'} is on file.`
  })
}

export async function openRepairOrderAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        vehicleId: z.string().uuid(),
        complaint: z.string().trim().optional(),
        openedOn: isoDate,
        toleranceBp: z.number().int().min(0).max(10_000).optional(),
        odometerIn: z.number().int().min(0).optional(),
      })
      .parse(input)

    const order = await openRepairOrder(actor, parsed)
    return `${order.number} opened. Nothing is authorised yet, so nothing can be billed yet.`
  })
}

export async function addLineAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        repairOrderId: z.string().uuid(),
        kind: z.enum(['labour', 'part', 'sublet']),
        description: z.string().trim().min(1),
        itemId: z.string().uuid().optional().nullable(),
        quantityMilli: z.number().int().positive().optional(),
        unitPriceCents: cents,
        subletCostCents: cents.optional(),
      })
      .parse(input)

    await addLine(actor, parsed)
    return 'Added to the order. Pricing work is not the same as being allowed to bill it.'
  })
}

export async function authoriseAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        repairOrderId: z.string().uuid(),
        amountCents: z.number().int(),
        channel: z.enum(['in_person', 'phone', 'email', 'sms', 'online']).optional(),
        approvedBy: z.string().trim().optional(),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    const result = await authorise(actor, parsed)

    return parsed.amountCents > 0
      ? `${formatCents(parsed.amountCents)} authorised — ${formatCents(result.authorisedCents)} in total.`
      : `Authorisation withdrawn — ${formatCents(result.authorisedCents)} still agreed.`
  })
}

export async function completeAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        repairOrderId: z.string().uuid(),
        completedOn: isoDate,
        odometerOut: z.number().int().min(0).optional(),
      })
      .parse(input)

    const result = await completeRepairOrder(actor, parsed)

    if (!result.posted) {
      return 'That order was already billed. Nothing was posted a second time.'
    }

    const parts = [
      `${formatCents(result.totals.totalCents)} billed — ` +
        `${formatCents(result.totals.labourCents)} labour, ` +
        `${formatCents(result.totals.partsCents)} parts, ` +
        `${formatCents(result.totals.subletCents)} sublet.`,
    ]

    if (result.shortfalls.length > 0) {
      parts.push(
        `${result.shortfalls.length} part${result.shortfalls.length === 1 ? '' : 's'} were not on the shelf, ` +
          'so their cost is understated until the stock is received.',
      )
    }

    return parts.join(' ')
  })
}

export async function cancelAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ repairOrderId: z.string().uuid() }).parse(input)
    await cancelRepairOrder(actor, parsed)
    return 'Cancelled.'
  })
}

export async function recordOdometerAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        vehicleId: z.string().uuid(),
        readingMiles: z.number().int().min(0),
        allowRollback: z.boolean().optional(),
        reason: z.string().trim().optional(),
      })
      .parse(input)

    const result = await recordOdometer(actor, parsed)

    if (result.unmoved) return 'Recorded. The car has not moved since it was last here.'
    if (result.milesTravelled === null) return 'Recorded — the first reading for this vehicle.'
    return `Recorded. ${result.milesTravelled.toLocaleString()} miles since it was last here.`
  })
}

export async function takePaymentAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        invoiceId: z.string().uuid(),
        receivedOn: isoDate,
        tenders: z
          .array(
            z.object({
              kind: z.enum(['cash', 'card', 'gift_card', 'bank_transfer', 'cheque', 'other']),
              amountCents: z.number().int().positive(),
              reference: z.string().trim().optional(),
            }),
          )
          .min(1),
      })
      .parse(input)

    const result = await takePayment(actor, parsed)

    const parts = [`${formatCents(result.settlement.appliedCents)} taken.`]

    if (result.settlement.changeCents > 0) {
      parts.push(`${formatCents(result.settlement.changeCents)} change.`)
    }
    if (result.settlement.stillDueCents > 0) {
      parts.push(`${formatCents(result.settlement.stillDueCents)} still owing.`)
    } else {
      parts.push(`${result.invoiceNumber} settled.`)
    }

    return parts.join(' ')
  })
}
