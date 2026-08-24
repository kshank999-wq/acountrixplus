'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { dayDetail, importDay } from '@/modules/pos/service'
import { formatCents } from '@/lib/money'
import { messageFor } from '@/modules/errors'

/** Server actions for daily takings (spec §5, Phase 28). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'That is not a date.')
const cents = z.number().int().min(0)

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/takings', '/accounting', '/bookkeeping']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export type DayDetail = Awaited<ReturnType<typeof dayDetail>>

/**
 * What one day was made of, fetched when somebody opens the row.
 *
 * On demand rather than alongside the list: the list is capped at sixty days
 * and almost nobody opens more than one of them, so loading every day's
 * categories and tenders to render a table that shows neither would be sixty
 * times the work for the same screen.
 */
export async function dayDetailAction(posDayId: string): Promise<DayDetail | null> {
  try {
    const actor = await requireActor()
    return await dayDetail(actor, z.string().uuid().parse(posDayId))
  } catch {
    return null
  }
}

export async function importDayAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        businessDate: isoDate,
        source: z.enum(['register', 'marketplace', 'processor', 'manual']).optional(),
        label: z.string().trim().optional(),
        categories: z
          .array(
            z.object({
              name: z.string().trim().min(1),
              accountNumber: z.string().trim().min(1),
              amountCents: cents,
            }),
          )
          .default([]),
        tenders: z
          .array(
            z.object({
              kind: z.enum(['cash', 'card', 'other']),
              name: z.string().trim().min(1),
              amountCents: cents,
              feeCents: cents.optional(),
            }),
          )
          .default([]),
        taxCents: cents.optional(),
        tipsCents: cents.optional(),
        refundsCents: cents.optional(),
        discountsCents: cents.optional(),
        countedCashCents: z.number().int().nullable().optional(),
        floatCents: cents.optional(),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    const result = await importDay(actor, parsed)

    if (!result.created) {
      return `${parsed.businessDate} was already in. Nothing was posted a second time.`
    }

    const base = `${parsed.businessDate}: ${formatCents(result.plan.netSalesCents)} net sales, one entry.`

    const parts = [base]

    if (result.plan.tipsCents > 0) {
      parts.push(
        `${formatCents(result.plan.tipsCents)} of tips went to a liability, not to revenue.`,
      )
    }

    // The till discrepancy is said out loud, at the moment somebody is looking.
    // A number that only appears on a report nobody opens is a number that
    // never gets asked about.
    if (result.plan.overShortCents !== null && result.plan.overShortCents !== 0) {
      parts.push(
        result.plan.overShortCents < 0
          ? `The till was ${formatCents(-result.plan.overShortCents)} short.`
          : `The till was ${formatCents(result.plan.overShortCents)} over.`,
      )
    }

    if (result.plan.outOfBalanceCents !== 0) {
      parts.push(
        `The summary itself is out by ${formatCents(Math.abs(result.plan.outOfBalanceCents))} — its tenders do not match its sales — so that much went to 1220 POS Import Suspense to be looked at.`,
      )
    }

    return parts.join(' ')
  })
}
