'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { remittanceLinkFor, sendRemittance } from '@/modules/payables/remittance-send'
import { DomainError, messageFor } from '@/modules/errors'

/** Server actions for remittance advice (spec §13, Phase 58). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = ['/accounting/payments', '/accounting/payables']

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

export async function sendRemittanceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ paymentId: uuid, to: z.string().trim().optional() }).parse(input)

    const result = await sendRemittance(actor, parsed.paymentId, { to: parsed.to || null })

    if (!result.delivered) {
      throw new DomainError(
        `The link is ready but the email did not go: ${result.error ?? 'the provider refused it'}. ` +
          'Copy the link and send it yourself, or check the address and try again.',
      )
    }

    return (
      `${result.isResend ? 'Resent' : 'Sent'} to ${result.to}. ` +
      'They can see which of their invoices it covers, so they can apply it.'
    )
  })
}

export async function shareRemittanceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const { paymentId } = z.object({ paymentId: uuid }).parse(input)

    const url = await remittanceLinkFor(actor, paymentId)
    // Handing somebody a link is not the same event as sending the advice, so
    // this deliberately does not mark the payment as advised.
    return `Anybody with this link can see what the payment covers:\n${url}`
  })
}
