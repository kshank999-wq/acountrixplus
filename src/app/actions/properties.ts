'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  activateLease,
  createLease,
  createProperty,
  createUnit,
  endLease,
  retireProperty,
} from '@/modules/properties/service'
import { runRent } from '@/modules/properties/billing'
import { applyDeposit, receiveDeposit, refundDeposit } from '@/modules/properties/deposits'
import { formatCents } from '@/lib/money'

/** Server actions for properties, tenancies, rent and deposits (spec §5, Phase 23). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'That is not a date.')
const cents = z.number().int()

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/properties', '/accounting', '/accounting/dimensions']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

export async function createPropertyAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        code: z.string().trim().min(1, 'A property needs a short code.'),
        name: z.string().trim().min(1, 'A property needs a name.'),
        addressLine1: z.string().trim().optional(),
        city: z.string().trim().optional(),
        region: z.string().trim().optional(),
        postalCode: z.string().trim().optional(),
        acquiredOn: isoDate.optional(),
      })
      .parse(input)

    const property = await createProperty(actor, parsed)
    return `${property.name} added, and reportable as ${property.code}.`
  })
}

export async function retirePropertyAction(propertyId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await retireProperty(actor, uuid.parse(propertyId))
    return 'Retired. Its history is kept.'
  })
}

export async function createUnitAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        propertyId: uuid,
        code: z.string().trim().min(1, 'A unit needs a code.'),
        name: z.string().trim().optional(),
        marketRentCents: cents.min(0).optional(),
      })
      .parse(input)

    await createUnit(actor, parsed)
    return 'Unit added.'
  })
}

export async function createLeaseAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        unitId: uuid,
        customerId: uuid,
        startsOn: isoDate,
        endsOn: isoDate.optional(),
        rentCents: cents.positive('Rent must be more than nothing.'),
        dueDay: z.number().int().min(1).max(28).optional(),
        depositRequiredCents: cents.min(0).optional(),
        activate: z.boolean().optional(),
      })
      .parse(input)

    await createLease(actor, { ...parsed, endsOn: parsed.endsOn ?? null })
    return parsed.activate ? 'Tenancy started.' : 'Tenancy agreed, and not yet started.'
  })
}

export async function activateLeaseAction(leaseId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await activateLease(actor, uuid.parse(leaseId))
    if (!done) throw new Error('That tenancy is not waiting to start.')
    return 'Started. It bills from the next run.'
  })
}

export async function endLeaseAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ leaseId: uuid, endedOn: isoDate, reason: z.string().trim().optional() })
      .parse(input)

    const done = await endLease(actor, parsed.leaseId, {
      endedOn: parsed.endedOn,
      reason: parsed.reason ?? null,
    })

    if (!done) throw new Error('That tenancy has already ended.')
    // Deliberately says nothing about the deposit: what happens to it is a
    // decision somebody has to make, and doing it automatically would refund
    // money that should have been kept against damage.
    return 'Ended. The deposit is still held — settle it separately.'
  })
}

export async function runRentAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ month: isoDate, propertyId: uuid.optional().nullable() })
      .parse(input)

    const result = await runRent(actor, {
      month: parsed.month,
      propertyId: parsed.propertyId ?? undefined,
    })

    if (result.invoicesRaised === 0) {
      return 'Nothing to bill — every tenancy already has an invoice for that month.'
    }

    return `${result.invoicesRaised} invoice${result.invoicesRaised === 1 ? '' : 's'} raised, ${formatCents(result.totalCents)} in total.`
  })
}

export async function receiveDepositAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        leaseId: uuid,
        amountCents: cents.positive('A deposit must be more than nothing.'),
        occurredOn: isoDate,
        financialAccountId: uuid,
        memo: z.string().trim().optional(),
      })
      .parse(input)

    await receiveDeposit(actor, parsed)
    return `${formatCents(parsed.amountCents)} held. It is a liability, not income.`
  })
}

export async function refundDepositAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        leaseId: uuid,
        amountCents: cents.positive('A refund must be more than nothing.'),
        occurredOn: isoDate,
        financialAccountId: uuid,
        memo: z.string().trim().optional(),
      })
      .parse(input)

    await refundDeposit(actor, parsed)
    return `${formatCents(parsed.amountCents)} returned. Not an expense — it was never income.`
  })
}

export async function applyDepositAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        leaseId: uuid,
        amountCents: cents.positive('An amount must be more than nothing.'),
        occurredOn: isoDate,
        invoiceId: uuid.optional().nullable(),
        memo: z.string().trim().optional(),
      })
      .parse(input)

    const result = await applyDeposit(actor, {
      ...parsed,
      invoiceId: parsed.invoiceId ?? null,
    })

    return result.recognisedIncome
      ? `${formatCents(parsed.amountCents)} kept, and recognised as income now.`
      : `${formatCents(parsed.amountCents)} applied to the invoice. The rent was already recognised.`
  })
}
