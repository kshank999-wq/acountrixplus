'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  addPractitioner,
  book,
  closeWithoutDelivery,
  completeAppointment,
  redeemGiftCard,
  sellGiftCard,
} from '@/modules/appointments/service'
import { takePayment } from '@/modules/counter/service'
import { formatCents } from '@/lib/money'

/** Server actions for appointments (spec §5, Phase 29). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const cents = z.number().int().min(0)
const bp = z.number().int().min(0).max(10_000)

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/appointments', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

export async function addPractitionerAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        name: z.string().trim().min(1),
        email: z.string().trim().optional(),
        commissionBp: bp.optional(),
        productCommissionBp: bp.optional(),
      })
      .parse(input)

    await addPractitioner(actor, parsed)
    return `${parsed.name} can now take appointments.`
  })
}

export async function bookAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        practitionerId: z.string().uuid(),
        customerId: z.string().uuid().optional().nullable(),
        startsAt: z.string().min(1),
        endsAt: z.string().min(1),
        priceCents: cents.optional(),
        productCents: cents.optional(),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    await book(actor, {
      ...parsed,
      startsAt: new Date(parsed.startsAt),
      endsAt: new Date(parsed.endsAt),
    })

    return 'In the diary. Nothing has been posted — a booking is a promise, not a sale.'
  })
}

export async function completeAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        appointmentId: z.string().uuid(),
        completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        productCents: cents.optional(),
      })
      .parse(input)

    const result = await completeAppointment(actor, parsed)

    if (!result.posted) {
      return 'That visit was already marked done. Nothing was posted a second time.'
    }

    if (result.totalCents === 0) {
      return 'Marked done. There was nothing to charge, so nothing was posted.'
    }

    return (
      `${formatCents(result.totalCents)} earned, of which ${formatCents(result.practitionerCents)} ` +
      `is owed to the practitioner and ${formatCents(result.businessCents)} is the salon's.`
    )
  })
}

export async function closeAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        appointmentId: z.string().uuid(),
        status: z.enum(['no_show', 'cancelled']),
      })
      .parse(input)

    await closeWithoutDelivery(actor, parsed)

    return parsed.status === 'no_show'
      ? 'Marked a no-show. The slot was lost, and nothing was posted.'
      : 'Cancelled. The slot is free to sell again.'
  })
}

export async function sellGiftCardAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        code: z.string().trim().min(1),
        amountCents: z.number().int().positive(),
        issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(input)

    await sellGiftCard(actor, parsed)

    return (
      `${formatCents(parsed.amountCents)} taken and none of it earned — it sits on the balance ` +
      'sheet until somebody uses the card.'
    )
  })
}

export async function redeemGiftCardAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        code: z.string().trim().min(1),
        appointmentId: z.string().uuid(),
        redeemedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(input)

    const result = await redeemGiftCard(actor, parsed)

    if (!result.applied) {
      return 'That visit had already been settled by a card. Nothing was spent twice.'
    }

    const parts = [`${formatCents(result.appliedCents)} taken off the visit.`]

    if (result.stillDueCents > 0) {
      parts.push(`${formatCents(result.stillDueCents)} still to pay.`)
    }
    if (result.remainingBalanceCents > 0) {
      parts.push(`${formatCents(result.remainingBalanceCents)} left on the card.`)
    }

    return parts.join(' ')
  })
}

export async function takePaymentAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        invoiceId: z.string().uuid(),
        receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
