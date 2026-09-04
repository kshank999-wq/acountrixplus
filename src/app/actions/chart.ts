'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { createAccount, setAccountRetired } from '@/modules/coa/service'
import { messageFor } from '@/modules/errors'

/**
 * Server actions for the chart of accounts (spec §5, Phase 118).
 *
 * `createAccount` was written in Phase 1 and had no caller for 117 phases.
 * This is the caller.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

/**
 * Every screen that offers an account in a picker.
 *
 * Listed rather than revalidating the layout, because adding an account is the
 * moment somebody wants to use it — and a chart that needs a reload before the
 * journal screen can see the account is a chart people work around.
 */
const PATHS = [
  '/settings/chart',
  '/accounting/journal',
  '/accounting/invoices',
  '/accounting/payables',
  '/accounting/budgets',
  '/bookkeeping',
]

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

const TYPES = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'cogs',
  'expense',
  'other_income',
  'other_expense',
] as const

const createSchema = z.object({
  number: z.string().trim().min(1, 'Give the account a number.'),
  name: z.string().trim().min(1, 'Give the account a name.'),
  type: z.enum(TYPES),
  description: z.string().trim().optional(),
})

export async function addChartAccountAction(input: unknown): Promise<ActionResult> {
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details.' }
  }

  return run(async () => {
    const actor = await requireActor()
    const account = await createAccount(actor, {
      number: parsed.data.number,
      name: parsed.data.name,
      type: parsed.data.type,
      description: parsed.data.description || null,
    })
    return `${account.number} ${account.name} added.`
  })
}

const retireSchema = z.object({
  accountId: z.string().uuid(),
  retired: z.boolean(),
})

export async function setChartAccountRetiredAction(input: unknown): Promise<ActionResult> {
  const parsed = retireSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Check the details.' }

  return run(async () => {
    const actor = await requireActor()
    const account = await setAccountRetired(actor, parsed.data)
    return parsed.data.retired
      ? `${account.number} ${account.name} retired. Its history stays where it is.`
      : `${account.number} ${account.name} is back in use.`
  })
}
