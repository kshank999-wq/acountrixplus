'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { parseAmountToCents } from '@/lib/money'
import { closePeriod, postManualEntry, reopenPeriod } from '@/modules/ledger/journal'
import { correctEntry, entryDetail } from '@/modules/ledger/corrections-service'
import {
  completeReconciliation,
  reopenReconciliation,
  setCleared,
  startReconciliation,
} from '@/modules/reconciliation/service'
import { messageFor } from '@/modules/errors'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

/** Turns a thrown domain error into a message the UI can show. */
async function run(path: string, fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

// --- Reconciliation --------------------------------------------------------

const startSchema = z.object({
  financialAccountId: z.string().uuid(),
  statementStartDate: z.string().min(1),
  statementEndDate: z.string().min(1),
  statementEndingBalance: z.string().min(1),
})

export async function startReconciliationAction(
  input: z.input<typeof startSchema>,
): Promise<ActionResult & { reconciliationId?: string }> {
  try {
    const actor = await requireActor()
    const parsed = startSchema.parse(input)

    const session = await startReconciliation(actor, {
      financialAccountId: parsed.financialAccountId,
      statementStartDate: parsed.statementStartDate,
      statementEndDate: parsed.statementEndDate,
      statementEndingBalanceCents: parseAmountToCents(parsed.statementEndingBalance),
    })

    revalidatePath('/accounting/reconcile')
    return { ok: true, reconciliationId: session.id }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not start the reconciliation.'),
    }
  }
}

export async function setClearedAction(
  reconciliationId: string,
  transactionIds: string[],
  cleared: boolean,
): Promise<ActionResult> {
  return run(`/accounting/reconcile/${reconciliationId}`, async () => {
    const actor = await requireActor()
    const result = await setCleared(actor, reconciliationId, transactionIds, cleared)
    return `${cleared ? 'Cleared' : 'Uncleared'} ${result.updated}.`
  })
}

export async function completeReconciliationAction(
  reconciliationId: string,
): Promise<ActionResult> {
  return run(`/accounting/reconcile/${reconciliationId}`, async () => {
    const actor = await requireActor()
    const summary = await completeReconciliation(actor, reconciliationId)
    return `Reconciled ${summary.clearedCount} transactions. The books agree with the statement.`
  })
}

export async function reopenReconciliationAction(
  reconciliationId: string,
): Promise<ActionResult> {
  return run(`/accounting/reconcile/${reconciliationId}`, async () => {
    const actor = await requireActor()
    await reopenReconciliation(actor, reconciliationId)
    return 'Reconciliation reopened.'
  })
}

// --- Journal ---------------------------------------------------------------

const journalSchema = z.object({
  entryDate: z.string().min(1),
  memo: z.string().optional(),
  lines: z
    .array(
      z.object({
        chartAccountId: z.string().uuid(),
        debit: z.string(),
        credit: z.string(),
        memo: z.string().optional(),
      }),
    )
    .min(2),
})

export async function postEntryAction(
  input: z.input<typeof journalSchema>,
): Promise<ActionResult> {
  return run('/accounting/journal', async () => {
    const actor = await requireActor()
    const parsed = journalSchema.parse(input)

    const lines = parsed.lines
      .map((line) => ({
        chartAccountId: line.chartAccountId,
        debitCents: line.debit.trim() ? parseAmountToCents(line.debit) : 0,
        creditCents: line.credit.trim() ? parseAmountToCents(line.credit) : 0,
        memo: line.memo,
      }))
      // Blank rows in the form are not part of the entry.
      .filter((line) => line.debitCents !== 0 || line.creditCents !== 0)

    const entry = await postManualEntry(actor, {
      entryDate: parsed.entryDate,
      memo: parsed.memo,
      lines,
    })

    return `Posted entry #${entry.entryNumber}.`
  })
}

/**
 * Corrects one entry, by voiding it or by reversing it (Phase 51).
 *
 * One action for both, because which of the two is right is an accounting
 * decision the service makes from the entry's source and its period — not a
 * preference the caller announces. What arrives here is what a person pressed,
 * and `correctEntry` checks it rather than trusting it.
 */
export async function correctEntryAction(input: {
  entryId: string
  method: 'void' | 'reverse'
  memo?: string
}): Promise<ActionResult> {
  return run('/accounting/journal', async () => {
    const actor = await requireActor()
    const parsed = correctionSchema.parse(input)
    const result = await correctEntry(actor, parsed)
    return result.message
  })
}

const correctionSchema = z.object({
  entryId: z.string().uuid(),
  method: z.enum(['void', 'reverse']),
  memo: z.string().trim().max(500).optional(),
})

/**
 * One entry with its lines.
 *
 * `entryWithLines` has existed since Phase 2 with no caller anywhere in
 * `src/app`, so the journal listed a number, a date, a memo and a status and
 * showed no money at all.
 */
export async function entryDetailAction(
  entryId: string,
): Promise<
  | { ok: true; detail: NonNullable<Awaited<ReturnType<typeof entryDetail>>> }
  | { ok: false; error: string }
> {
  try {
    const actor = await requireActor()
    const detail = await entryDetail(actor, entryId)

    if (!detail) return { ok: false, error: 'That entry is not on these books.' }
    return { ok: true, detail }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That entry could not be read.') }
  }
}

// --- Period close ----------------------------------------------------------

export async function closePeriodAction(
  periodStart: string,
  periodEnd: string,
): Promise<ActionResult> {
  return run('/accounting/journal', async () => {
    const actor = await requireActor()
    await closePeriod(actor, { periodStart, periodEnd })
    return `Closed ${periodStart} through ${periodEnd}.`
  })
}

export async function reopenPeriodAction(periodId: string): Promise<ActionResult> {
  return run('/accounting/journal', async () => {
    const actor = await requireActor()
    await reopenPeriod(actor, periodId)
    return 'Period reopened.'
  })
}
