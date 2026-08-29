'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  approveTime,
  deleteTime,
  logTime,
  recordBillableExpense,
  submitTime,
  writeOffTime,
} from '@/modules/timebilling/service'
import { billWork, receiveRetainer } from '@/modules/timebilling/billing'
import { parseDuration } from '@/modules/timebilling/rates'
import { messageFor } from '@/modules/errors'

/** Server actions for the time and billing workspace (spec §5, Phase 15). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/time', '/time/billing', '/accounting/reports']

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

const logSchema = z.object({
  projectId: uuid.optional(),
  workedOn: isoDate,
  /** What was typed: "1.5", "1:30", "90m" all mean ninety minutes. */
  duration: z.string().trim().min(1, 'How long did it take?'),
  description: z.string().trim().min(1, 'Say what the time was for.'),
  isBillable: z.boolean().optional(),
})

export async function logTimeAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = logSchema.parse(input)

    const minutes = parseDuration(parsed.duration)
    if (minutes === null || minutes <= 0) {
      throw new Error(
        `“${parsed.duration}” is not a length of time. Try 1.5, 1:30, or 90m — they all mean the same thing.`,
      )
    }

    await logTime(actor, {
      projectId: parsed.projectId ?? null,
      workedOn: parsed.workedOn,
      minutes,
      description: parsed.description,
      isBillable: parsed.isBillable ?? true,
    })

    return 'Logged.'
  })
}

export async function submitTimeAction(entryIds: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const ids = z.array(uuid).parse(entryIds)
    const count = await submitTime(actor, ids)
    return `${count} ${count === 1 ? 'entry' : 'entries'} submitted for approval.`
  })
}

export async function approveTimeAction(entryIds: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const ids = z.array(uuid).parse(entryIds)
    const count = await approveTime(actor, ids)
    return `${count} ${count === 1 ? 'entry' : 'entries'} approved and ready to bill.`
  })
}

export async function writeOffTimeAction(
  entryIds: unknown,
  reason: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const ids = z.array(uuid).parse(entryIds)
    const count = await writeOffTime(actor, ids, z.string().parse(reason))
    return `${count} ${count === 1 ? 'entry' : 'entries'} written off. They stay on the engagement’s profitability.`
  })
}

export async function deleteTimeAction(entryId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await deleteTime(actor, uuid.parse(entryId))
    return 'Deleted.'
  })
}

const expenseSchema = z.object({
  projectId: uuid.optional(),
  incurredOn: isoDate,
  description: z.string().trim().min(1, 'Say what it was.'),
  costCents: z.number().int().positive(),
  markupBasisPoints: z.number().int().min(-10_000).optional(),
  chartAccountId: uuid.optional(),
})

export async function recordExpenseAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = expenseSchema.parse(input)

    await recordBillableExpense(actor, {
      projectId: parsed.projectId ?? null,
      incurredOn: parsed.incurredOn,
      description: parsed.description,
      costCents: parsed.costCents,
      markupBasisPoints: parsed.markupBasisPoints ?? 0,
      chartAccountId: parsed.chartAccountId ?? null,
    })

    return 'Marked as recoverable. The cost itself was already in the books.'
  })
}

const billSchema = z.object({
  projectId: uuid,
  customerId: uuid,
  issueDate: isoDate,
  throughDate: isoDate.optional(),
  grouping: z.enum(['person', 'day', 'service', 'single']).optional(),
  /** What to bill in (Phase 66). Blank is the company's own. */
  currency: z.string().trim().toUpperCase().optional().or(z.literal('')),
  applyRetainerId: uuid.optional(),
})

export async function billWorkAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = billSchema.parse(input)

    const result = await billWork(actor, {
      projectId: parsed.projectId,
      customerId: parsed.customerId,
      issueDate: parsed.issueDate,
      throughDate: parsed.throughDate,
      grouping: parsed.grouping,
      currency: parsed.currency || undefined,
      applyRetainerId: parsed.applyRetainerId,
    })

    const retainerNote =
      result.retainerAppliedCents > 0 ? ' A retainer was drawn against it.' : ''

    return `Invoice ${result.invoice.number} raised for ${result.time.length} time ${
      result.time.length === 1 ? 'entry' : 'entries'
    } and ${result.expenses.length} expense${result.expenses.length === 1 ? '' : 's'}.${retainerNote}`
  })
}

const retainerSchema = z.object({
  customerId: uuid,
  projectId: uuid.optional(),
  receivedOn: isoDate,
  amountCents: z.number().int().positive(),
  /** What the client actually sent (Phase 66). Blank is the company's own. */
  currency: z.string().trim().toUpperCase().optional().or(z.literal('')),
  financialAccountId: uuid,
  reference: z.string().trim().optional(),
})

export async function receiveRetainerAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = retainerSchema.parse(input)

    await receiveRetainer(actor, {
      customerId: parsed.customerId,
      projectId: parsed.projectId ?? null,
      receivedOn: parsed.receivedOn,
      amountCents: parsed.amountCents,
      currency: parsed.currency || undefined,
      financialAccountId: parsed.financialAccountId,
      reference: parsed.reference || undefined,
    })

    return 'Retainer received. It sits as a liability until the work is done, not as revenue.'
  })
}
