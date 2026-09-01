import { NextResponse, type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { getEmailProvider } from '@/modules/marketing/email-provider'
import { recordDeliveryEvent } from '@/modules/marketing/delivery'
import { logUnexpected } from '@/modules/errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The email provider's delivery callback (spec §10, §19).
 *
 * The fifth unauthenticated-by-session entry point, and the only one not
 * reached from a link in an email. This one is reached by the provider, hours
 * after the send, to say that a message it accepted was delivered, bounced, or
 * reported as spam.
 *
 * ## Why this exists
 *
 * `campaign_recipients.provider_message_id` has been stored since Phase 5 with
 * the comment "for reconciling delivery webhooks later", and nothing
 * reconciled. A hard bounce never suppressed the address, so the same dead
 * mailbox was mailed again on every campaign — which is the fastest way to
 * lose a sending domain's reputation, and invisible from this end.
 *
 * ## How it authenticates
 *
 * A shared secret in `Authorization: Bearer`, configured on both sides, and
 * **no development fallback**. The other public endpoints are safe to leave
 * open because a token identifies exactly one recipient and bounds what can
 * happen; this one names any recipient by a provider id, so an open version of
 * it would let anyone suppress any address they could guess a message id for.
 *
 * With `EMAIL_WEBHOOK_SECRET` unset the endpoint refuses everything. Failing
 * closed is right here: an unconfigured webhook loses bounce handling, and an
 * unauthenticated one hands somebody a way to silence a company's mailing list.
 */
function authorized(request: NextRequest): boolean {
  const secret = process.env.EMAIL_WEBHOOK_SECRET
  if (!secret) return false

  const header = request.headers.get('authorization') ?? ''
  const provided = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${secret}`)

  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const provider = getEmailProvider()
  if (!provider.parseDeliveryEvents) {
    // An adapter that reports nothing is still a usable adapter. Saying so is
    // better than accepting a body and silently discarding it.
    return NextResponse.json({ ok: false, reason: 'no_callback_support' }, { status: 404 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ ok: false, reason: 'unparseable' }, { status: 400 })
  }

  const callbacks = provider.parseDeliveryEvents(payload)
  let recorded = 0
  let unknown = 0

  for (const callback of callbacks) {
    try {
      const result = await recordDeliveryEvent(callback)
      if (result.ok) recorded += 1
      else unknown += 1
    } catch (error) {
      // One bad event must not cost the rest of the batch, and must not make
      // the provider retry the whole thing — most retry policies disable a
      // webhook that keeps erroring.
      logUnexpected(error, 'Recording a delivery callback')
      unknown += 1
    }
  }

  // 200 even when nothing matched. A callback for a recipient row that
  // retention has already swept is expected rather than suspicious, and a
  // provider that gets errors back turns the webhook off.
  return NextResponse.json({ ok: true, recorded, unknown })
}
