'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { putRate, describeRate, normalise, parseRate } from '@/modules/fx/service'

/** Server actions for exchange rates (spec §19, Phase 35). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/accounting/currencies', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

/**
 * Records a rate for a currency on a day.
 *
 * The form takes a decimal — nobody types millionths — and `rateFrom` is the
 * one place that turns "1.0835" into `1_083_500`. Doing it here rather than in
 * the browser means a rate typed on a phone with a comma decimal separator
 * fails loudly on the server rather than silently becoming 10,835.
 */
export async function putRateAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        baseCurrency: z.string().trim().min(3).max(3),
        rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A rate needs the day it applies to.'),
        rate: z.string().trim().min(1),
        source: z.string().trim().optional(),
      })
      .parse(input)

    const rateMillionths = parseRate(parsed.rate)

    await putRate(actor, {
      baseCurrency: parsed.baseCurrency,
      rateDate: parsed.rateDate,
      rateMillionths,
      source: parsed.source,
    })

    return (
      `${normalise(parsed.baseCurrency)} on ${parsed.rateDate} is ${describeRate(rateMillionths)}. ` +
      'Documents already posted keep the rate they were posted at.'
    )
  })
}
