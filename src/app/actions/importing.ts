'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { commitAccountImport, planAccountImport } from '@/modules/importing/accounts'
import { commitContactImport, planContactImport } from '@/modules/importing/contacts'
import {
  commitOpenDocumentImport,
  commitTrialBalanceImport,
  planOpenDocumentImport,
  planTrialBalanceImport,
} from '@/modules/importing/opening-balances'
import { revertImport } from '@/modules/importing/reversal'
import type { ImportPlan } from '@/modules/importing/plan'
import { IMPORT_KINDS } from '@/modules/importing/vocabulary'

/** Server actions for the migration wizard (spec §20 Phase 8). */

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string }

const PATHS = ['/settings/import', '/accounting/reports', '/bookkeeping']

async function run<T>(fn: () => Promise<{ message?: string; data?: T }>): Promise<ActionResult<T>> {
  try {
    const { message, data } = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

const planSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  text: z.string().min(1, 'Paste the file’s contents, or choose a file.'),
  columns: z.record(z.string(), z.string().nullable()).optional(),
  dateOrder: z.enum(['mdy', 'dmy']).optional(),
})

/**
 * Works out what an import would do, without doing any of it.
 *
 * Returns the whole plan to the browser so the wizard can show every problem
 * at once. The plan is then handed back to `commit`, which re-derives it from
 * the same text rather than trusting what came back — a plan is a *preview*,
 * and letting the client post one would let it post any figures it liked.
 */
export async function planImportAction(input: unknown): Promise<ActionResult<ImportPlan<unknown>>> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = planSchema.parse(input)

    const plan = await buildPlan(actor, parsed)
    return { data: plan as ImportPlan<unknown> }
  })
}

async function buildPlan(
  actor: Awaited<ReturnType<typeof requireActor>>,
  input: z.infer<typeof planSchema>,
) {
  switch (input.kind) {
    case 'chart_of_accounts':
      return planAccountImport(actor, { text: input.text, columns: input.columns })
    case 'customers':
    case 'vendors':
      return planContactImport(actor, {
        kind: input.kind,
        text: input.text,
        columns: input.columns,
      })
    case 'trial_balance':
      return planTrialBalanceImport(actor, { text: input.text, columns: input.columns })
    case 'open_invoices':
    case 'open_bills':
      return planOpenDocumentImport(actor, {
        kind: input.kind,
        text: input.text,
        columns: input.columns,
        dateOrder: input.dateOrder,
      })
  }
}

const commitSchema = planSchema.extend({
  fileName: z.string().trim().optional(),
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-01-31.')
    .optional(),
})

export async function commitImportAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = commitSchema.parse(input)

    // Re-planned from the text rather than taking a plan from the browser.
    // A plan carries the amounts that will be posted, and accepting one over
    // the wire would let a client post any figures it liked.
    const plan = await buildPlan(actor, parsed)
    const meta = { fileName: parsed.fileName || undefined }

    switch (parsed.kind) {
      case 'chart_of_accounts': {
        const result = await commitAccountImport(actor, plan as never, meta)
        return {
          message:
            `${result.created} ${result.created === 1 ? 'account' : 'accounts'} added, ` +
            `${result.updated} updated.`,
        }
      }
      case 'customers':
      case 'vendors': {
        const result = await commitContactImport(actor, parsed.kind, plan as never, meta)
        const noun = parsed.kind === 'customers' ? 'customer' : 'vendor'
        return {
          message:
            `${result.created} ${result.created === 1 ? noun : `${noun}s`} added, ` +
            `${result.updated} updated.`,
        }
      }
      case 'trial_balance': {
        if (!parsed.asOfDate) {
          throw new Error('Say what date these balances are as at.')
        }
        const result = await commitTrialBalanceImport(actor, plan as never, {
          asOfDate: parsed.asOfDate,
          fileName: meta.fileName,
        })
        return {
          message:
            `Entry ${result.entryNumber} posted with ${result.lineCount} opening balances. ` +
            'Receivables and payables come from the open documents, not from this file.',
        }
      }
      case 'open_invoices':
      case 'open_bills': {
        const result = await commitOpenDocumentImport(actor, parsed.kind, plan as never, meta)
        const noun = parsed.kind === 'open_invoices' ? 'invoice' : 'bill'
        return {
          message: `${result.created} open ${result.created === 1 ? noun : `${noun}s`} brought across.`,
        }
      }
    }
  })
}

export async function revertImportAction(runId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const result = await revertImport(actor, z.string().uuid().parse(runId))

    const removed = Object.entries(result.deleted)
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${count} ${count === 1 ? label : `${label}s`}`)

    const parts: string[] = []
    if (removed.length > 0) parts.push(`Removed ${removed.join(', ')}.`)
    if (result.entriesVoided > 0) {
      parts.push(
        `${result.entriesVoided} journal ${
          result.entriesVoided === 1 ? 'entry was' : 'entries were'
        } voided rather than deleted — the history stays.`,
      )
    }
    if (result.updatesLeftAlone > 0) {
      parts.push(
        `${result.updatesLeftAlone} ${
          result.updatesLeftAlone === 1 ? 'row that already existed was' : 'rows that already existed were'
        } left alone.`,
      )
    }

    return { message: parts.join(' ') || 'Undone.' }
  })
}
