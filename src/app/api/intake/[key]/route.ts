import { NextResponse, type NextRequest } from 'next/server'
import { submitLead } from '@/modules/crm/intake'

/**
 * Public lead intake endpoint (spec §6).
 *
 *   POST /api/intake/<public key>
 *
 * The only unauthenticated write path in the system. It creates a lead and
 * nothing else — see `modules/crm/intake` for the defences, which live in the
 * service rather than here so they are covered by tests rather than only by
 * this route.
 *
 * The response deliberately carries no data: an anonymous caller learns
 * whether the submission was accepted and nothing about the tenant, the
 * records created, or why a rejection happened beyond its category.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Permissive CORS: the endpoint is meant to be called from customer sites. */
function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get('origin')),
  })
}

export async function POST(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params
  const origin = request.headers.get('origin')
  const headers = corsHeaders(origin)

  // A body that is not JSON, or is enormous, is refused before parsing spends
  // memory on it.
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > 32_000) {
    return NextResponse.json({ ok: false, message: 'Payload too large.' }, { status: 413, headers })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json(
      { ok: false, message: 'Expected a JSON body.' },
      { status: 400, headers },
    )
  }

  const result = await submitLead(key, payload, {
    ip: request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip'),
    userAgent: request.headers.get('user-agent'),
    origin,
  })

  if (result.ok) {
    return NextResponse.json({ ok: true }, { status: 201, headers })
  }

  return NextResponse.json(
    { ok: false, message: result.message },
    { status: result.status, headers },
  )
}
