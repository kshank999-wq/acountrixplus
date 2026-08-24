'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { parseAmountToCents } from '@/lib/money'
import { closePeriod, postManualEntry, reopenPeriod, voidEntry } from '@/modules/ledger/journal'
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

export async function voidEntryAction(entryId: string): Promise<ActionResult> {
  return run('/accounting/journal', async () => {
    const actor = await requireActor()
    await voidEntry(actor, entryId)
    return 'Entry voided.'
  })
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
