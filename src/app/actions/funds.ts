'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { closeFund, createFund } from '@/modules/funds/service'
import { recordContribution, receivePledge } from '@/modules/funds/contributions'
import { runReleases } from '@/modules/funds/releases'
import { formatCents } from '@/lib/money'
import { messageFor } from '@/modules/errors'

/** Server actions for funds, contributions and releases (spec §5, Phase 26). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'That is not a date.')

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of ['/funds', '/accounting', '/accounting/dimensions']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export async function createFundAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        code: z.string().trim().min(1, 'A fund needs a short code.'),
        name: z.string().trim().min(1, 'A fund needs a name.'),
        restriction: z.enum(['unrestricted', 'restricted', 'perpetual']).optional(),
        purpose: z.string().trim().optional(),
        expiresOn: isoDate.optional(),
      })
      .parse(input)

    const fund = await createFund(actor, parsed)
    return `${fund.name} opened, and reportable as ${fund.code}.`
  })
}

export async function closeFundAction(fundId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const fund = await closeFund(actor, uuid.parse(fundId))
    return `${fund.name} closed to new money. What it still holds is unchanged.`
  })
}

export async function recordContributionAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        fundId: uuid,
        donorId: uuid.nullable().optional(),
        kind: z.enum(['gift', 'pledge']).optional(),
        source: z.enum(['donation', 'grant']).optional(),
        receivedOn: isoDate,
        amountCents: z.number().int().positive('A contribution must be more than nothing.'),
        financialAccountId: uuid.nullable().optional(),
        reference: z.string().trim().optional(),
        memo: z.string().trim().optional(),
      })
      .parse(input)

    await recordContribution(actor, parsed)

    // The wording is the phase: a promise is revenue on the day it is made,
    // and somebody recording one should be told that rather than discover it
    // when the income for the year is higher than the bank.
    return parsed.kind === 'pledge'
      ? `${formatCents(parsed.amountCents)} promised — recognised as income today, and outstanding until it arrives.`
      : `${formatCents(parsed.amountCents)} received.`
  })
}

export async function receivePledgeAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z
      .object({
        contributionId: uuid,
        amountCents: z.number().int().positive('A receipt must be more than nothing.'),
        receivedOn: isoDate,
        financialAccountId: uuid,
      })
      .parse(input)

    const result = await receivePledge(actor, parsed)

    return result.outstandingCents === 0
      ? 'Promise settled in full. No income was posted — it was recognised when the promise was made.'
      : `${formatCents(result.outstandingCents)} of that promise is still outstanding.`
  })
}

export async function runReleasesAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ month: isoDate }).parse(input)
    const result = await runReleases(actor, parsed)

    if (result.postedCount === 0) {
      return 'Nothing to release — every fund spent this month has already had its restriction released.'
    }

    const released = `${formatCents(result.releasedCents)} released across ${result.postedCount} ${
      result.postedCount === 1 ? 'fund' : 'funds'
    }. The total income for the month is unchanged.`

    // The shortfall goes in the same sentence rather than a quieter place. A
    // charity that has spent money it was never given for that purpose needs to
    // be told at the moment somebody is looking.
    return result.shortfallCents > 0
      ? `${released} ${formatCents(result.shortfallCents)} was spent beyond what those funds were given.`
      : released
  })
}
