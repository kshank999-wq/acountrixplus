import { NextResponse } from 'next/server'
import { proposalByToken } from '@/modules/crm/proposals'
import { readDocument } from '@/modules/evidence/service'
import { latestSentPdf } from '@/modules/pdf/service'
import { versionForClient } from '@/modules/crm/client-link'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The client's copy of their proposal (spec §7 "PDF download", §18).
 *
 * Serves the **snapshot taken when the proposal was sent**, never a fresh
 * render of the live record. That is the whole point of the phase: a client who
 * opens their link a month after the price list changed downloads what they
 * were sent, not what the proposal has since become.
 *
 * Authorized by the public token, exactly as the page beside it is — the token
 * names the proposal, the proposal names the company, and the document is
 * looked up under that company. No document id is ever taken from the request.
 */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params

  const view = await proposalByToken(token)
  if (!view) return new NextResponse(null, { status: 404 })

  /*
    An earlier version, by number (Phase 189, §7's "version history").

    A query parameter and not a second route, deliberately: two routes is two
    places to get "may this client read this version" right, and one of them
    would eventually not. `versionForClient` is the single answer, and it
    refuses a version the client never opened — see its own docstring for why
    the rule is a view rather than a policy.
  */
  const asked = new URL(request.url).searchParams.get('version')
  if (asked !== null) {
    const wanted = Number(asked)
    const allowed = Number.isInteger(wanted)
      ? await versionForClient(token, wanted)
      : null

    if (!allowed?.pdfDocumentId) {
      // The same 404 for "no such version", "not yours" and "you never opened
      // it". A distinct refusal for the last would confirm that a version
      // exists, which is the one thing withholding it is for.
      return new NextResponse(null, { status: 404 })
    }

    const earlier = await readDocument(allowed.companyId, allowed.pdfDocumentId)
    if (!earlier) return new NextResponse(null, { status: 404 })

    return pdfResponse(earlier.data, `${view.proposal.number || 'proposal'}-v${wanted}.pdf`)
  }

  const latest = await latestSentPdf(view.proposal.companyId, view.proposal.id)
  if (!latest) {
    // A proposal sent before it had a design document, or one that has not
    // been sent at all. The page still works; there is simply nothing to
    // download, and saying so beats serving a live render that would quietly
    // differ from what they were shown.
    return NextResponse.json(
      { error: 'No PDF was issued for this proposal.', code: 'not_found' },
      { status: 404 },
    )
  }

  const result = await readDocument(view.proposal.companyId, latest.documentId)
  if (!result) return new NextResponse(null, { status: 404 })

  return pdfResponse(
    result.data,
    `${view.proposal.number || 'proposal'}-v${latest.versionNumber}.pdf`,
  )
}

function pdfResponse(data: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(data.byteLength),
      'Content-Disposition': `inline; filename="${filename}"`,
      // Private and short: the token is a capability, and a shared cache in
      // front of the app must not hold somebody's pricing.
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
