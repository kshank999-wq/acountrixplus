import { NextResponse, type NextRequest } from 'next/server'
import { askOnProposal } from '@/modules/engagement/questions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * A question asked through the client link (spec §7, Phase 174).
 *
 * The **third** unauthenticated write path in the system. `intake.ts` still
 * calls itself "the only" one and the acceptance route beside this called itself
 * "the second"; the count has been wrong in one file or another since the
 * acceptance route was written, which is why Phase 174 stopped counting in
 * prose and put the list in `modules/tenancy` instead.
 *
 * Everything that decides whether the question may be recorded — the token, the
 * draft check, the rate limit, the length bounds — is in
 * `modules/engagement/questions`, so it is covered by tests rather than by this
 * route. The route's own job is the HTTP envelope and nothing else.
 *
 * Deliberately no CORS headers, matching the acceptance route: this is only ever
 * called from the proposal page served on this origin, and a cross-origin caller
 * has no legitimate reason to submit a question.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params

  /*
    Smaller than the acceptance route's 16 KB, because a question is prose and
    the service caps the body at 4,000 characters. Rejecting the oversize
    payload here saves parsing it; the service rejects it again, because a
    bound enforced only at the edge is a bound one new caller removes.
  */
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > 8_000) {
    return NextResponse.json({ ok: false, message: 'That is too long to send.' }, { status: 413 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Expected a JSON body.' }, { status: 400 })
  }

  const body = (payload as { body?: unknown } | null)?.body
  const askerName = (payload as { askerName?: unknown } | null)?.askerName

  if (typeof body !== 'string') {
    return NextResponse.json({ ok: false, message: 'Type your question first.' }, { status: 400 })
  }

  const result = await askOnProposal(token, {
    body,
    askerName: typeof askerName === 'string' ? askerName.slice(0, 120) : null,
  })

  if (result.ok) {
    return NextResponse.json({ ok: true }, { status: 201 })
  }

  /*
    404 for a token that names nothing *and* for a proposal that may not take
    questions, because the service gives both the same sentence on purpose: two
    different statuses would restore the oracle the shared message removes.
  */
  const status = result.reason === 'rate_limited' ? 429 : result.reason === 'empty' ? 400 : 404

  return NextResponse.json({ ok: false, message: result.message }, { status })
}
