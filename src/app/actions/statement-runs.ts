'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { runStatements, updateStatementPolicy } from '@/modules/receivables/statement-run'
import { messageFor } from '@/modules/errors'

/** Server actions for the statement-run screen (spec §13, Phase 57). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/settings/statements', '/accounting/receivables']

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
  dayOfMonth: z.coerce.number().int().optional(),
  kind: z.enum(['open_item', 'balance_forward']).optional(),
  minimumBalanceCents: z.coerce.number().int().optional(),
  quietDays: z.coerce.number().int().optional(),
  maxPerRun: z.coerce.number().int().optional(),
})

export async function updateStatementPolicyAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = policySchema.parse(input)
    const policy = await updateStatementPolicy(actor, parsed)

    // Switching it on is the sentence worth saying out loud, because it is the
    // one that changes what their customers receive.
    if (parsed.enabled === true) {
      return `Statement runs are on. The next one goes out on the ${ordinal(policy.dayOfMonth)}.`
    }
    if (parsed.enabled === false) {
      return 'Statement runs are off. Nothing will be sent automatically.'
    }
    return 'Saved.'
  })
}

/**
 * Sends this month's statements now, rather than waiting for the day.
 *
 * Here for the reason Phase 43 put the same button on the chasing screen: the
 * preview is only half the reassurance, and the other half is watching it
 * happen once, on a day somebody chose, before trusting it to happen at seven
 * in the morning without them. It goes through the same function the worker
 * calls, so what they watch is what will run.
 *
 * It does **not** force the day: a run started by hand on the 14th still
 * obeys the policy's day, because the alternative is a button that quietly
 * does something the schedule never would.
 */
export async function runStatementsNowAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await runStatements(actor)

    if (!result.enabled) return 'Statement runs are switched off, so nothing was sent.'
    if (result.sent === 0 && result.failed === 0) {
      return 'Nothing was due today. Statements go out on the day the policy names.'
    }

    const failed = result.failed > 0 ? `, ${result.failed} could not be sent` : ''
    return `${result.sent} sent${failed}.`
  })
}

function ordinal(day: number): string {
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th'
  return `${day}${suffix}`
}
