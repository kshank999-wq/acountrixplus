'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createSchedule,
  raiseOccurrence,
  runDueSchedules,
  setScheduleActive,
} from '@/modules/billing/service'
import { formatCents, parseAmountToCents } from '@/lib/money'

/** Server actions for recurring billing (spec §13, Phase 37). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/accounting/billing', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

export async function createScheduleAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        customerId: z.string().uuid(),
        name: z.string().trim().min(1),
        cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually']),
        dayOfMonth: z.number().int().min(1).max(28).optional(),
        paymentTermsDays: z.number().int().min(0).optional(),
        autoRaise: z.boolean().optional(),
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        chartAccountId: z.string().uuid(),
        description: z.string().trim().min(1),
        amount: z.string().trim().min(1),
      })
      .parse(input)

    const unitPriceCents = parseAmountToCents(parsed.amount)

    const schedule = await createSchedule(actor, {
      customerId: parsed.customerId,
      name: parsed.name,
      cadence: parsed.cadence,
      dayOfMonth: parsed.dayOfMonth,
      paymentTermsDays: parsed.paymentTermsDays,
      autoRaise: parsed.autoRaise,
      startsOn: parsed.startsOn,
      endsOn: parsed.endsOn,
      lines: [
        {
          chartAccountId: parsed.chartAccountId,
          description: parsed.description,
          unitPriceCents,
        },
      ],
    })

    return (
      `"${schedule.name}" is set up, first due ${schedule.nextRunOn}. ` +
      `Nothing is owed yet — a schedule is a promise to bill, and ${formatCents(unitPriceCents)} ` +
      'appears in receivables when that date arrives.'
    )
  })
}

export async function setScheduleActiveAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ scheduleId: z.string().uuid(), isActive: z.boolean() })
      .parse(input)

    const schedule = await setScheduleActive(actor, parsed.scheduleId, parsed.isActive)

    return parsed.isActive
      ? `"${schedule.name}" is running again, next due ${schedule.nextRunOn}. The periods it ` +
          'missed while it was off are not replayed.'
      : `"${schedule.name}" is paused. The invoices it already raised stand — pausing bills ` +
          'nothing and unbills nothing.'
  })
}

export async function runDueSchedulesAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(input ?? {})

    const asOfDate = parsed.asOfDate ?? new Date().toISOString().slice(0, 10)
    const results = await runDueSchedules(actor, asOfDate)

    if (results.length === 0) return 'Nothing was due.'

    const raised = results.filter((row) => row.raised)
    const totalCents = raised.reduce((sum, row) => sum + row.totalCents, 0)

    if (raised.length === 0) {
      return `Nothing raised. ${results.map((row) => row.skipped).filter(Boolean).join(' ')}`
    }

    return (
      `${raised.length} invoice${raised.length === 1 ? '' : 's'} raised, ` +
      `${formatCents(totalCents)} in total. Running it again bills nothing more — the period is ` +
      'claimed by the database, not by this button.'
    )
  })
}

export async function raiseOccurrenceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ occurrenceId: z.string().uuid() }).parse(input)

    const invoice = await raiseOccurrence(actor, parsed.occurrenceId)

    return `Invoice ${invoice.number} raised for ${formatCents(invoice.totalCents)}. It ages, ` +
      'reaches a statement and can be paid like any other.'
  })
}
