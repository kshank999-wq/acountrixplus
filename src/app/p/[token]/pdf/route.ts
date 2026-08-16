import { NextResponse } from 'next/server'
import { proposalByToken } from '@/modules/crm/proposals'
import { readDocument } from '@/modules/evidence/service'
import { latestSentPdf } from '@/modules/pdf/service'

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
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params

  const view = await proposalByToken(token)
  if (!view) return new NextResponse(null, { status: 404 })

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

  const filename = `${view.proposal.number || 'proposal'}-v${latest.versionNumber}.pdf`

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(result.data.byteLength),
      'Content-Disposition': `inline; filename="${filename}"`,
      // Private and short: the token is a capability, and a shared cache in
      // front of the app must not hold somebody's pricing.
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
