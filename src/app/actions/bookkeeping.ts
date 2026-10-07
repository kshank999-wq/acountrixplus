'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  acceptSuggestion,
  bulkCategorize,
  categorize,
  excludeTransaction,
  markAsTransfer,
  setNote,
  splitTransaction,
  undoLast,
} from '@/modules/bookkeeping/transactions'
import { createRule } from '@/modules/bookkeeping/rules-engine'
import { connectInstitution, syncConnection, listConnections } from '@/modules/banking/sync'
import { applyHeldRevision, dismissRevision } from '@/modules/banking/revision-service'
import { parseAmountToCents } from '@/lib/money'
import { messageFor } from '@/modules/errors'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

/**
 * Wraps an action so a thrown PermissionError or validation failure comes back
 * as a message the UI can render, rather than an unhandled server exception.
 */
async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    revalidatePath('/bookkeeping')
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

export async function categorizeAction(
  transactionId: string,
  chartAccountId: string,
  rememberVendor: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await categorize(actor, transactionId, chartAccountId, {
      rememberVendor,
      vendorRuleAction: 'suggest',
    })
    return result.vendorRule
      ? 'Categorized, and this vendor will be suggested next time.'
      : 'Categorized.'
  })
}

export async function bulkCategorizeAction(
  transactionIds: string[],
  chartAccountId: string,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await bulkCategorize(actor, transactionIds, chartAccountId)
    return `Categorized ${result.updated} transaction${result.updated === 1 ? '' : 's'}.`
  })
}

export async function acceptSuggestionAction(transactionId: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await acceptSuggestion(actor, transactionId)
    return 'Suggestion accepted.'
  })
}

export async function excludeAction(
  transactionId: string,
  reason: string,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await excludeTransaction(actor, transactionId, reason || undefined)
    return 'Excluded from the books.'
  })
}

export async function markTransferAction(transactionId: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await markAsTransfer(actor, transactionId)
    return 'Marked as a transfer.'
  })
}

export async function noteAction(transactionId: string, note: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await setNote(actor, transactionId, note.trim() || null)
    return 'Note saved.'
  })
}

const splitLineSchema = z.object({
  chartAccountId: z.string().uuid(),
  amount: z.string(),
  memo: z.string().optional(),
})

export async function splitAction(
  transactionId: string,
  lines: Array<{ chartAccountId: string; amount: string; memo?: string }>,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.array(splitLineSchema).min(2).parse(lines)

    const splits = parsed.map((line) => ({
      chartAccountId: line.chartAccountId,
      amountCents: parseAmountToCents(line.amount),
      memo: line.memo,
    }))

    await splitTransaction(actor, transactionId, splits)
    return `Split across ${splits.length} accounts.`
  })
}

const ruleSchema = z.object({
  name: z.string().min(1),
  field: z.enum(['description', 'merchantName', 'absAmountCents']),
  operator: z.enum(['contains', 'equals', 'starts_with', 'gt', 'lt']),
  value: z.string().min(1),
  chartAccountId: z.string().uuid(),
  action: z.enum(['auto', 'suggest']),
  applyToExisting: z.boolean(),
})

export async function createRuleAction(
  input: z.input<typeof ruleSchema>,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = ruleSchema.parse(input)

    // Amount conditions are entered in dollars but stored in cents.
    const value =
      parsed.field === 'absAmountCents' ? parseAmountToCents(parsed.value) : parsed.value

    const result = await createRule(actor, {
      name: parsed.name,
      conditions: [{ field: parsed.field, operator: parsed.operator, value }],
      chartAccountId: parsed.chartAccountId,
      action: parsed.action,
      applyToExisting: parsed.applyToExisting,
    })

    const touched = result.applied.autoCategorized + result.applied.suggested
    return touched > 0
      ? `Rule created and applied to ${touched} existing transaction${touched === 1 ? '' : 's'}.`
      : 'Rule created.'
  })
}

export async function undoAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await undoLast(actor)
    return result.undone > 0
      ? `Undid ${result.undone} change${result.undone === 1 ? '' : 's'}.`
      : 'Nothing left to undo.'
  })
}

/**
 * Connects the feed and imports it.
 *
 * With `BANK_PROVIDER=mock` — the default, and what every deployment runs
 * until an aggregator is contracted — the transactions this brings in are
 * **generated, not real**. That is right for a demo and wrong to do quietly to
 * somebody's books, so the result says which it was rather than letting
 * "Imported 60 transactions" read the same either way. The honest path for a
 * real business is a statement import (`/settings/import`), which needs no
 * vendor at all.
 */
export async function connectAndSyncAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()

    const existing = await listConnections(actor)
    const connectionId =
      existing[0]?.id ??
      (await connectInstitution(actor, { publicToken: 'demo' })).connectionId

    const summary = await syncConnection(actor, connectionId)
    const isDemoFeed = (process.env.BANK_PROVIDER?.trim() || 'mock') === 'mock'

    /*
      Revisions are reported before the early return, because "no new
      transactions" stopped being true for a sync that imported nothing and
      changed three (Phase 177). A feed that revises a pending transaction into
      a posted one did something, and a message saying otherwise is the kind
      this project keeps finding in its own prose.
    */
    const revised: string[] = []
    if (summary.revisionsApplied > 0) {
      revised.push(`${summary.revisionsApplied} updated by the bank`)
    }
    if (summary.revisionsHeld > 0) {
      revised.push(`${summary.revisionsHeld} changed by the bank and waiting on you`)
    }

    if (summary.imported === 0) {
      return revised.length > 0
        ? `No new transactions — ${revised.join(', ')}.`
        : 'Already up to date — no new transactions.'
    }

    const parts = [`Imported ${summary.imported} transactions`]
    if (summary.autoCategorized > 0) parts.push(`${summary.autoCategorized} auto-categorized`)
    if (summary.suggested > 0) parts.push(`${summary.suggested} suggested`)
    parts.push(...revised)

    return isDemoFeed
      ? `${parts.join(', ')} — from the sample feed, not a real bank. ` +
          'To bring in your own, import a statement from Settings → Bring in your books.'
      : `${parts.join(', ')}.`
  })
}

/**
 * Applies a revision the bank made after the transaction was already posted
 * (Phase 177).
 *
 * The service re-decides whether the hold still stands rather than trusting the
 * one recorded at sync time — a revision held on `reconciled` last week may be
 * held on nothing today, because the remedy told somebody to reopen the
 * reconciliation. A closed period refuses this with `ClosedPeriodError`, which
 * `run` turns into the sentence the panel shows.
 */
export async function applyRevisionAction(revisionId: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await applyHeldRevision(actor, revisionId)

    return result.reposted
      ? 'Applied, and the journal entry was re-posted at the new amount.'
      : 'Applied.'
  })
}

/** Records that the stored figure stands, and why. */
export async function dismissRevisionAction(
  revisionId: string,
  note: string,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await dismissRevision(actor, revisionId, note)
    return 'Dismissed. The books keep the figure they have.'
  })
}
