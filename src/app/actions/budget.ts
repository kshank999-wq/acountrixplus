'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  approveBudget,
  clearAccountBudget,
  copyFromActuals,
  createBudget,
  setAccountBudget,
} from '@/modules/budget/service'
import { formatCents, parseAmountToCents } from '@/lib/money'
import { messageFor } from '@/modules/errors'

/** Server actions for budgets (spec §13, Phase 36). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/accounting/budgets', '/accounting']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export async function createBudgetAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        name: z.string().trim().min(1),
        fiscalYear: z.number().int().min(1900).max(9999),
        notes: z.string().trim().optional(),
      })
      .parse(input)

    const budget = await createBudget(actor, parsed)
    return `"${budget.name}" is ready. Nothing in it posts to the ledger — it is a plan.`
  })
}

export async function setAccountBudgetAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        budgetId: z.string().uuid(),
        chartAccountId: z.string().uuid(),
        annual: z.string().trim().min(1),
        method: z.enum(['even', 'weighted']).optional(),
      })
      .parse(input)

    const annualCents = parseAmountToCents(parsed.annual)

    const result = await setAccountBudget(actor, {
      budgetId: parsed.budgetId,
      chartAccountId: parsed.chartAccountId,
      annualCents,
      method: parsed.method ?? 'even',
    })

    return (
      `${formatCents(result.totalCents)} across the year. ` +
      'The months add back to exactly that — the odd cents are placed, not dropped.'
    )
  })
}

export async function clearAccountBudgetAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({ budgetId: z.string().uuid(), chartAccountId: z.string().uuid() })
      .parse(input)

    await clearAccountBudget(actor, parsed)
    return 'Removed from the plan. That is not the same as planning it to zero — it will now ' +
      'report as unbudgeted if anything lands on it.'
  })
}

export async function approveBudgetAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ budgetId: z.string().uuid() }).parse(input)

    const budget = await approveBudget(actor, parsed.budgetId)
    return `"${budget.name}" is the agreed plan for ${budget.fiscalYear}. Any budget that was ` +
      'approved before it has been archived, so nothing is ambiguous.'
  })
}

export async function copyFromActualsAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        budgetId: z.string().uuid(),
        sourceYear: z.number().int().min(1900).max(9999),
        upliftBasisPoints: z.number().int().optional(),
      })
      .parse(input)

    const result = await copyFromActuals(actor, parsed)

    return (
      `${result.accounts} account${result.accounts === 1 ? '' : 's'} filled in from ` +
      `${result.sourceYear}, month by month` +
      (result.upliftBasisPoints
        ? `, up ${(result.upliftBasisPoints / 100).toFixed(2).replace(/\.?0+$/, '')}%.`
        : '.')
    )
  })
}
