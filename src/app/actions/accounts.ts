'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createFinancialAccount,
  renameFinancialAccount,
  setFinancialAccountActive,
} from '@/modules/banking/accounts'
import { restatePosting } from '@/modules/ledger/restate'
import { messageFor } from '@/modules/errors'
import { formatCents } from '@/lib/money'

/** Server actions for the bank accounts screen (spec §3, §5). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

// Everywhere an account appears in a picker, so opening one does not need a
// reload before the statement import can use it.
const PATHS = ['/settings/accounts', '/settings/import', '/bookkeeping', '/accounting/reconcile']

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const KINDS = ['checking', 'savings', 'credit_card', 'loan', 'cash', 'other'] as const

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the account a name.'),
  kind: z.enum(KINDS),
  mask: z.string().trim().optional(),
  currency: z.string().trim().length(3).optional(),
})

export async function createAccountAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = createSchema.parse(input)

    const account = await createFinancialAccount(actor, {
      name: parsed.name,
      kind: parsed.kind,
      mask: parsed.mask || null,
      currency: parsed.currency,
    })

    // The ledger account is the part nobody expects, so it is said out loud
    // rather than discovered later on the balance sheet.
    return `${account.name} added, posting to ${account.chartAccountNumber} ${account.chartAccountName}.`
  })
}

const renameSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, 'Give the account a name.'),
  mask: z.string().trim().optional(),
})

export async function renameAccountAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = renameSchema.parse(input)

    await renameFinancialAccount(actor, parsed.id, {
      name: parsed.name,
      mask: parsed.mask ?? null,
    })

    return 'Renamed, on the ledger too.'
  })
}

const activeSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() })

export async function setAccountActiveAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = activeSchema.parse(input)

    await setFinancialAccountActive(actor, parsed.id, parsed.isActive)

    return parsed.isActive
      ? 'Reopened.'
      : 'Closed. Nothing was deleted — its transactions and reconciliations are all still there.'
  })
}


/**
 * Putting a posting right at a rate a person supplies (Phase 130).
 *
 * The rate is typed as a decimal because that is how a rate is written down
 * anywhere else — on a broker's note, in a spreadsheet, on the FX screen. It
 * becomes millionths here, once, rather than asking somebody to count zeroes.
 */
const restateSchema = z.object({
  transactionId: z.string().uuid(),
  rate: z
    .number()
    .positive('An exchange rate has to be greater than zero.')
    .finite('Give the rate as a number.'),
  reason: z.string().trim().max(500).optional(),
})

export async function restatePostingAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = restateSchema.parse(input)

    const result = await restatePosting(actor, {
      transactionId: parsed.transactionId,
      toRateMillionths: Math.round(parsed.rate * 1_000_000),
      reason: parsed.reason ?? '',
      // The day the decision is made, never the day the money moved — which is
      // what makes it a correction rather than a quiet edit, and what lets a
      // closed period refuse it.
      correctionDate: new Date().toISOString().slice(0, 10),
    })

    const direction = result.deltaCents > 0 ? 'added' : 'taken off'
    return (
      `Restated from ${formatCents(result.fromCents)} to ${formatCents(result.toCents)}. ` +
      `${formatCents(Math.abs(result.deltaCents))} ${direction} in a correcting entry dated today; ` +
      'the original is untouched.'
    )
  })
}
