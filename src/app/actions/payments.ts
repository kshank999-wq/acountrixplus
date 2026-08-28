'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { updatePaymentSettings } from '@/modules/payments/settings'
import { importPayouts, sweepUnresolvedCheckouts } from '@/modules/payments/service'
import { describeSweep } from '@/modules/payments/reconcile'
import { messageFor } from '@/modules/errors'
import { formatCents } from '@/lib/money'

/** Server actions for the card payments screen (spec §13, Phase 44). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/settings/payments', '/accounting/invoices', '/accounting/reports']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  feePercentBp: z.coerce.number().int().optional(),
  feeFixedCents: z.coerce.number().int().optional(),
  payoutFinancialAccountId: z.string().uuid().nullable().optional(),
})

export async function updatePaymentSettingsAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const settings = await updatePaymentSettings(actor, settingsSchema.parse(input))

    if (settings.enabled) {
      return 'Card payments are on. A Pay button now appears on every invoice you share.'
    }
    return 'Saved.'
  })
}

/**
 * Brings in what the processor has deposited.
 *
 * Manual as well as scheduled, because the first thing anybody does after
 * taking a test payment is look for the money — and telling them to wait for
 * tomorrow's run is telling them the feature does not work.
 */
export async function importPayoutsAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await importPayouts(actor)

    if (result.imported === 0) return 'Nothing new from the processor.'

    const discrepancy =
      result.discrepancies.length > 0
        ? ` ${result.discrepancies.length} did not match their own payments — worth a look.`
        : ''

    return `${result.imported} deposit${result.imported === 1 ? '' : 's'} posted, ${formatCents(result.postedCents)} in total.${discrepancy}`
  })
}

/**
 * Asks the processor about every payment nobody came back from.
 *
 * Manual as well as hourly, because the moment somebody notices an invoice
 * reading unpaid that the customer swears they paid, "wait for the next hour"
 * is not an answer.
 */
export async function sweepCheckoutsAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const summary = await sweepUnresolvedCheckouts(actor)

    const sentence = describeSweep(summary)
    if (!sentence) {
      return summary.considered === 0
        ? 'Nothing was waiting on an answer.'
        : `Nothing to resolve — ${summary.waiting} still with a customer.`
    }

    return sentence
  })
}
