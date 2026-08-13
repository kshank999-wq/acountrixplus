import { NextResponse, type NextRequest } from 'next/server'
import { acceptProposal } from '@/modules/crm/acceptance'
import { truncateIp } from '@/modules/crm/intake'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Public proposal acceptance (spec §7).
 *
 * The second unauthenticated write path in the system. Everything that decides
 * whether the acceptance is valid — including recomputing the total from the
 * client's selection — lives in `modules/crm/acceptance`, so it is covered by
 * tests rather than only by this route.
 *
 * Deliberately no CORS headers: unlike lead intake, this is only ever called
 * from the proposal page served on this origin. A cross-origin caller has no
 * legitimate reason to submit an acceptance.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > 16_000) {
    return NextResponse.json({ ok: false, message: 'Payload too large.' }, { status: 413 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Expected a JSON body.' }, { status: 400 })
  }

  const result = await acceptProposal(token, payload, {
    ipPrefix: truncateIp(
      request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip'),
    ),
    userAgent: request.headers.get('user-agent'),
  })

  if (result.ok) {
    return NextResponse.json({ ok: true, total: result.acceptedTotalCents }, { status: 201 })
  }

  return NextResponse.json({ ok: false, message: result.message }, { status: result.status })
}
