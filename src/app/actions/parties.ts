'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { updateCustomer, updateVendor } from '@/modules/receivables/service'
import {
  customerById,
  mergeParties,
  mergePreview,
  setCustomerActive,
  setVendorActive,
  vendorById,
} from '@/modules/parties/service'
import { CUSTOMER_FIELDS, VENDOR_FIELDS, describeChanges, diffParty } from '@/modules/parties/changes'
import { messageFor } from '@/modules/errors'

/** Server actions for the people screen (spec §6, §13, Phase 45). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

// A party's name is on every screen that names them, so a rename has to
// invalidate more than the page it was made on.
const PATHS = ['/accounting/people', '/accounting/invoices', '/accounting/receivables', '/crm']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

/** Blank means "clear this field", not "leave it alone" — the form sends every box. */
const text = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()

const customerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, 'A customer needs a name.'),
  email: text,
  phone: text,
  addressLine1: text,
  addressLine2: text,
  city: text,
  region: text,
  postalCode: text,
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
  notes: text,
})

export async function updateCustomerAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const { id, ...fields } = customerSchema.parse(input)

    const before = await customerById(actor, id)
    const changes = diffParty({ fields: CUSTOMER_FIELDS, before, after: fields })

    await updateCustomer(actor, id, fields)

    // Names the fields rather than counting them: "email and payment terms
    // updated" is checkable, "2 fields changed" has to be looked up.
    return describeChanges(changes)
  })
}

const vendorSchema = customerSchema.extend({
  taxId: text,
  is1099Vendor: z.coerce.boolean().optional(),
})

export async function updateVendorAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const { id, ...fields } = vendorSchema.parse(input)

    const before = await vendorById(actor, id)
    const changes = diffParty({ fields: VENDOR_FIELDS, before, after: fields })

    await updateVendor(actor, id, fields)

    return describeChanges(changes)
  })
}

const activeSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() })

export async function setCustomerActiveAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = activeSchema.parse(input)
    const result = await setCustomerActive(actor, parsed.id, parsed.isActive)

    return result.isActive
      ? `${result.name} is active again.`
      : `${result.name} archived. Their history stays; they no longer appear when you raise an invoice.`
  })
}

export async function setVendorActiveAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = activeSchema.parse(input)
    const result = await setVendorActive(actor, parsed.id, parsed.isActive)

    return result.isActive
      ? `${result.name} is active again.`
      : `${result.name} archived. Their history stays; they no longer appear when you enter a bill.`
  })
}

/**
 * Puts two records of one business together (Phase 96).
 *
 * The reason is not optional and is not defaulted here. `mergeParties` refuses
 * a blank one with Phase 70's own prompt, so the sentence somebody reads when
 * they are stopped is the sentence that asked them in the first place — and
 * putting a fallback in this layer would quietly answer the one question the
 * merge exists to have answered.
 */
const mergeSchema = z.object({
  side: z.enum(['customer', 'vendor']),
  winnerId: z.string().uuid(),
  loserId: z.string().uuid(),
  reason: z.string().optional(),
})

export async function mergePartiesAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = mergeSchema.parse(input)
    const result = await mergeParties(actor, parsed)

    const total = result.moved.reduce((sum, one) => sum + one.rows, 0)

    return total === 0
      ? `${result.loserName} merged into ${result.winnerName}. It had nothing on it.`
      : `${result.loserName} merged into ${result.winnerName}. ${total} record${
          total === 1 ? '' : 's'
        } moved across.`
  })
}

/** What the merge would move, for the panel to show before anybody commits. */
export async function mergePreviewAction(
  input: unknown,
): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  try {
    const actor = await requireActor()
    const parsed = mergeSchema.omit({ reason: true }).parse(input)
    const { line } = await mergePreview(actor, parsed)
    return { ok: true, line }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not work out what would move.') }
  }
}
