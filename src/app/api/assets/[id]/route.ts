import { NextResponse, type NextRequest } from 'next/server'
import { currentActor } from '@/lib/current-user'
import { readAsset } from '@/modules/studio/assets'
import { proposalByToken } from '@/modules/crm/proposals'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Serves an uploaded asset.
 *
 * Two ways to be authorized, and no third:
 *
 *  1. A signed-in user of the owning company.
 *  2. A `?proposal=<public token>` that resolves to a proposal — this is how a
 *     client-facing page shows the company's logo without a login.
 *
 * In both cases the owning company is derived from the *authorization*, never
 * from the request, so an asset id alone reveals nothing.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const token = request.nextUrl.searchParams.get('proposal')

  let companyId: string | null = null

  if (token) {
    const proposal = await proposalByToken(token)
    companyId = proposal?.proposal.companyId ?? null
  } else {
    const actor = await currentActor()
    companyId = actor?.companyId ?? null
  }

  if (!companyId) {
    return new NextResponse(null, { status: 404 })
  }

  const result = await readAsset(companyId, id)
  if (!result) {
    return new NextResponse(null, { status: 404 })
  }

  /*
    SVG is served under a policy the other formats do not need (Phase 190).

    A PNG cannot execute. An SVG navigated to **directly** is a document in
    this origin, and a document in this origin can read a colleague's session
    or a client's proposal token. Loaded in an `<img>` — which is how the
    proposal page and the Design Center use it — it cannot: browsers disable
    scripting for an SVG used as an image, and they ignore
    `Content-Disposition` for a subresource load. So the two uses can be told
    apart by the response alone, and are:

     - `Content-Disposition: attachment` makes a direct visit a download
       rather than a page, and leaves `<img>` untouched.
     - The policy allows nothing at all. `default-src 'none'` stops a fetch,
       `script-src 'none'` stops a script, and `sandbox` denies the document
       an origin to be in — so even a script that somehow survived the
       sanitiser would run as nobody, against nothing.

    Belt and braces behind `sanitizeSvg`, which is the defence that is
    supposed to hold. This is the one that catches it not holding.
  */
  const isSvg = result.asset.contentType === 'image/svg+xml'

  return new NextResponse(new Uint8Array(result.data), {
    status: 200,
    headers: {
      'Content-Type': result.asset.contentType,
      'Content-Length': String(result.data.byteLength),
      // Content is immutable: a new upload gets a new id.
      'Cache-Control': 'private, max-age=3600',
      // Belt and braces against a crafted file being sniffed as HTML.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${isSvg ? 'attachment' : 'inline'}; filename="${encodeURIComponent(result.asset.filename)}"`,
      ...(isSvg
        ? {
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          }
        : {}),
    },
  })
}
