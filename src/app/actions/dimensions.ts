'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createDimension,
  createDimensionValue,
  reclassifyLines,
  updateDimension,
  updateDimensionValue,
} from '@/modules/dimensions/service'
import {
  disposeAsset,
  registerAsset,
  runDepreciation,
} from '@/modules/assets/service'
import { messageFor } from '@/modules/errors'

/** Server actions for accounting dimensions and the fixed asset register. */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/accounting/dimensions', '/accounting/assets', '/accounting/reports']

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

// --- Dimensions ------------------------------------------------------------

const dimensionSchema = z.object({
  name: z.string().trim().min(1, 'Give the dimension a name, like Location.'),
  code: z.string().trim().min(1, 'Give it a short code, like LOC.'),
  description: z.string().trim().optional(),
  requirement: z.enum(['optional', 'expected']).optional(),
})

export async function createDimensionAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = dimensionSchema.parse(input)

    const dimension = await createDimension(actor, {
      name: parsed.name,
      code: parsed.code,
      description: parsed.description || null,
      requirement: parsed.requirement ?? 'optional',
    })

    return `${dimension.name} added. Nothing is tagged with it yet — everything will show as Unassigned until it is.`
  })
}

export async function updateDimensionAction(
  dimensionId: unknown,
  patch: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        name: z.string().trim().min(1).optional(),
        requirement: z.enum(['optional', 'expected']).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(patch)

    await updateDimension(actor, uuid.parse(dimensionId), parsed)
    return parsed.isActive === false ? 'Retired. Its history is kept.' : 'Saved.'
  })
}

const valueSchema = z.object({
  dimensionId: uuid,
  code: z.string().trim().min(1, 'Give the value a short code.'),
  name: z.string().trim().min(1, 'Give the value a name.'),
  parentId: uuid.optional(),
})

export async function createDimensionValueAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = valueSchema.parse(input)

    await createDimensionValue(actor, {
      dimensionId: parsed.dimensionId,
      code: parsed.code,
      name: parsed.name,
      parentId: parsed.parentId ?? null,
    })

    return 'Added.'
  })
}

export async function retireDimensionValueAction(valueId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await updateDimensionValue(actor, uuid.parse(valueId), { isActive: false })
    return 'Retired. Everything already tagged with it stays tagged.'
  })
}

export async function reclassifyAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        journalLineIds: z.array(uuid).min(1, 'Pick at least one line.'),
        dimensionId: uuid,
        dimensionValueId: uuid.nullable(),
      })
      .parse(input)

    const moved = await reclassifyLines(actor, parsed)

    return `${moved} ${moved === 1 ? 'line' : 'lines'} reclassified. No money moved — the trial balance is unchanged.`
  })
}

// --- Fixed assets ----------------------------------------------------------

const assetSchema = z.object({
  name: z.string().trim().min(1, 'What is it?'),
  category: z.string().trim().optional(),
  costCents: z.number().int().positive('What did it cost?'),
  salvageValueCents: z.number().int().min(0).optional(),
  lifeMonths: z.number().int().min(1, 'How many months will it last?'),
  method: z
    .enum(['straight_line', 'declining_balance', 'declining_balance_switch'])
    .optional(),
  convention: z.enum(['full_month', 'mid_month', 'half_year']).optional(),
  acquiredDate: isoDate,
  inServiceDate: isoDate.optional(),
  /** Set only when the purchase is not already in the books. */
  postAcquisitionCreditAccountId: uuid.optional(),
})

export async function registerAssetAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = assetSchema.parse(input)

    const asset = await registerAsset(actor, {
      name: parsed.name,
      category: parsed.category || null,
      costCents: parsed.costCents,
      salvageValueCents: parsed.salvageValueCents ?? 0,
      lifeMonths: parsed.lifeMonths,
      method: parsed.method,
      convention: parsed.convention,
      acquiredDate: parsed.acquiredDate,
      inServiceDate: parsed.inServiceDate,
      postAcquisitionCreditAccountId: parsed.postAcquisitionCreditAccountId,
    })

    return parsed.postAcquisitionCreditAccountId
      ? `${asset.tag} registered and posted.`
      : `${asset.tag} registered. Nothing was posted — the purchase was already in the books.`
  })
}

export async function runDepreciationAction(throughDate: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const runs = await runDepreciation(actor, { throughDate: isoDate.parse(throughDate) })

    if (runs.length === 0) return 'Nothing was owed. Depreciation is up to date.'

    const total = runs.reduce((sum, entry) => sum + entry.amountCents, 0)
    const months = runs.length === 1 ? 'month' : 'months'

    return `${runs.length} ${months} posted, ${(total / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    })} in all. Each month is dated to itself, not to today.`
  })
}

const disposalSchema = z.object({
  assetId: uuid,
  disposedOn: isoDate,
  proceedsCents: z.number().int().min(0),
  proceedsAccountId: uuid.optional(),
  reason: z.string().trim().optional(),
})

export async function disposeAssetAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = disposalSchema.parse(input)

    const result = await disposeAsset(actor, {
      assetId: parsed.assetId,
      disposedOn: parsed.disposedOn,
      proceedsCents: parsed.proceedsCents,
      proceedsAccountId: parsed.proceedsAccountId,
      reason: parsed.reason || undefined,
    })

    const money = (cents: number) =>
      (Math.abs(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

    const outcome =
      result.gainLossCents === 0
        ? 'It sold for exactly its book value.'
        : result.gainLossCents > 0
          ? `A gain of ${money(result.gainLossCents)}, booked to Other income.`
          : `A loss of ${money(result.gainLossCents)}, booked to Other expense.`

    const arrears =
      result.arrearsCharged > 0
        ? ` ${result.arrearsCharged} ${
            result.arrearsCharged === 1 ? 'month' : 'months'
          } of depreciation was owed and charged first.`
        : ''

    return `Disposed of. ${outcome}${arrears}`
  })
}
