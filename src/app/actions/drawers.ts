'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { addDrawer, closeShift, openShift, payOut } from '@/modules/drawer/service'
import { formatCents } from '@/lib/money'

/** Server actions for cash drawers (spec §5, §13, Phase 34). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/drawers', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

export async function addDrawerAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        name: z.string().trim().min(1),
        defaultFloatCents: z.number().int().min(0).optional(),
      })
      .parse(input)

    await addDrawer(actor, parsed)
    return `${parsed.name} is on the list.`
  })
}

export async function openShiftAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        drawerId: z.string().uuid(),
        floatCents: z.number().int().min(0).optional(),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    const shift = await openShift(actor, parsed)

    return shift.floatCents > 0
      ? `Open, with ${formatCents(shift.floatCents)} in it. A float is not takings — it came ` +
          'out of petty cash and goes back at the end.'
      : 'Open, with nothing in it.'
  })
}

export async function payOutAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        shiftId: z.string().uuid(),
        reason: z.string().trim().min(1),
        amountCents: z.number().int().positive(),
        chartAccountId: z.string().uuid(),
      })
      .parse(input)

    await payOut(actor, parsed)
    return `${formatCents(parsed.amountCents)} out of the till for ${parsed.reason}.`
  })
}

export async function closeShiftAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        shiftId: z.string().uuid(),
        countedCents: z.number().int().min(0),
        retainFloatCents: z.number().int().min(0).optional(),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    const result = await closeShift(actor, parsed)
    return result.message
  })
}
