'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { updateChasePolicy } from '@/modules/receivables/chase-policy'
import { runChases } from '@/modules/receivables/chase-run'
import { messageFor } from '@/modules/errors'

/** Server actions for the chasing screen (spec §13, Phase 43). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/settings/chasing', '/accounting/invoices']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const policySchema = z.object({
  enabled: z.boolean().optional(),
  firstAfterDays: z.coerce.number().int().optional(),
  everyDays: z.coerce.number().int().optional(),
  maxChases: z.coerce.number().int().optional(),
  minimumBalanceCents: z.coerce.number().int().optional(),
  quietDaysAfterPayment: z.coerce.number().int().optional(),
  maxPerRun: z.coerce.number().int().optional(),
})

export async function updateChasePolicyAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = policySchema.parse(input)
    const policy = await updateChasePolicy(actor, parsed)

    // Switching it on is the sentence worth saying out loud. Everything else
    // is a number somebody can see on the screen they just changed it on.
    if (parsed.enabled === true) {
      return `Chasing is on. The first reminder goes ${policy.firstAfterDays} days after an invoice falls due.`
    }
    if (parsed.enabled === false) return 'Chasing is off. Nothing will be sent automatically.'
    return 'Saved.'
  })
}

/**
 * Sends today's chases now, rather than waiting for tomorrow's run.
 *
 * Here because the preview is only half the reassurance. The other half is
 * watching it happen once, on a day somebody chose, before trusting it to
 * happen at nine in the morning without them. It goes through exactly the same
 * function the worker calls, so what they watch is what will run.
 */
export async function runChasesNowAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await runChases(actor)

    if (!result.enabled) return 'Chasing is switched off, so nothing was sent.'
    if (result.sent === 0 && result.failed === 0) return 'Nothing was due today.'

    const failed = result.failed > 0 ? `, ${result.failed} could not be sent` : ''
    return `${result.sent} sent${failed}.`
  })
}
