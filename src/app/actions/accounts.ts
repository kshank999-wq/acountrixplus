'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createFinancialAccount,
  renameFinancialAccount,
  setFinancialAccountActive,
} from '@/modules/banking/accounts'
import { messageFor } from '@/modules/errors'

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
