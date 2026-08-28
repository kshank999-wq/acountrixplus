'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { invoiceByShareToken } from '@/modules/receivables/send'
import { settleCheckout, startCheckout } from '@/modules/payments/service'
import { getPaymentSettings } from '@/modules/payments/settings'
import { mockPaymentProvider } from '@/modules/payments/mock-provider'
import { getPaymentProvider } from '@/modules/payments/registry'
import { appBaseUrl } from '@/modules/notify/transactional'
import { messageFor } from '@/modules/errors'

/**
 * Paying an invoice from the link (spec §13, Phase 44).
 *
 * ## These actions have no actor, on purpose
 *
 * Whoever holds the link is the caller, and they are not a user of this
 * system. The **token** is what stands in for an actor, exactly as it does on
 * the page itself — so every action here takes one, resolves it, and works
 * only from what it resolved. Nothing accepts an invoice id or a company id
 * from the request, because those are what a token exists to avoid trusting.
 */

export type PayResult = { ok: true; url: string } | { ok: false; error: string }

const startSchema = z.object({
  token: z.string().min(1),
  /** A part payment, in cents. Omitted means the whole balance. */
  amountCents: z.coerce.number().int().positive().optional(),
})

export async function startPaymentAction(input: unknown): Promise<PayResult> {
  try {
    const parsed = startSchema.parse(input)

    const found = await invoiceByShareToken(parsed.token)
    if (!found) return { ok: false, error: 'That link is no longer valid.' }

    const started = await startCheckout({
      invoiceId: found.invoiceId,
      requestedCents: parsed.amountCents ?? null,
    })

    return { ok: true, url: started.url }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That payment could not be started.') }
  }
}

export type ConfirmResult = { ok: true; returnUrl: string } | { ok: false; error: string }

const confirmSchema = z.object({
  providerCheckoutId: z.string().min(1),
  returnUrl: z.string().min(1),
})

/**
 * Confirms a payment on the mock processor's stand-in page.
 *
 * **Only reachable while the mock adapter is in use.** A real processor takes
 * the card on its own page and this action has no part in it — which is the
 * point of the seam, and why the check below is a refusal rather than a
 * comment: an endpoint that could mark a real payment as succeeded without a
 * processor saying so would be the most dangerous thing in the codebase.
 */
export async function confirmMockPaymentAction(input: unknown): Promise<ConfirmResult> {
  try {
    const parsed = confirmSchema.parse(input)

    // The refusal the comment above promises. An endpoint that could mark a
    // real payment succeeded without a processor saying so would be the most
    // dangerous thing in this codebase, so it stops existing the moment a real
    // adapter is configured.
    if (getPaymentProvider().key !== 'mock') {
      return { ok: false, error: 'That payment could not be completed.' }
    }

    const reported = await mockPaymentProvider.getPayment(parsed.providerCheckoutId)
    if (reported.grossCents === 0 && reported.status === 'failed') {
      return { ok: false, error: 'That payment session has expired. Please start again.' }
    }

    await mockPaymentProvider.confirm(parsed.providerCheckoutId)
    const settled = await settleCheckout(parsed.providerCheckoutId)

    if (!settled.ok) return { ok: false, error: settled.reason }

    // Where the customer came from — a page on this application, built from
    // the invoice's own share token when the checkout was created. Checked
    // against our own origin anyway: a redirect target read out of a query
    // string is an open redirect unless somebody checks, and this one is
    // reachable by anybody.
    const safe = samePathOnThisApp(parsed.returnUrl)

    revalidatePath(safe)
    return { ok: true, returnUrl: safe }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That payment could not be completed.') }
  }
}

/**
 * Reduces a return URL to a path on this application, or the front page.
 *
 * Anything that is not ours becomes `/`. Refusing rather than sanitising: a
 * URL that needed cleaning up was not one of ours to begin with.
 */
function samePathOnThisApp(candidate: string): string {
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate

  try {
    const target = new URL(candidate)
    const ours = new URL(appBaseUrl())
    if (target.origin !== ours.origin) return '/'
    return `${target.pathname}${target.search}`
  } catch {
    return '/'
  }
}

/** Whether this business can take a card, for deciding to render the button. */
export async function canTakeCards(companyId: string): Promise<boolean> {
  const settings = await getPaymentSettings(companyId)
  return settings.enabled
}
