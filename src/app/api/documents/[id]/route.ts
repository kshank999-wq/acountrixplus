import { NextResponse, type NextRequest } from 'next/server'
import { currentActor } from '@/lib/current-user'
import { readDocument } from '@/modules/evidence/service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Serves an attached document.
 *
 * The owning company comes from the *session*, never from the request. A
 * document id alone reveals nothing, and there is deliberately no token route
 * of the kind `/api/assets/[id]` has for public proposal pages: a brand logo is
 * meant to be shown to strangers and a scanned bank statement is not.
 *
 * `readDocument` is also the only function anywhere that reads the object
 * store, which matters here because the store is content-addressed and
 * therefore *not* partitioned by tenant. The tenant check is this lookup. A
 * route that took a digest and fetched bytes would be a cross-tenant read, and
 * that is why no such route exists.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const actor = await currentActor()

  if (!actor) return new NextResponse(null, { status: 404 })

  const result = await readDocument(actor.companyId, id)
  // 404 rather than 403 for a document belonging to somebody else: "this
  // exists but is not yours" is a fact worth not confirming.
  if (!result) return new NextResponse(null, { status: 404 })

  const download = request.nextUrl.searchParams.get('download') !== null
  const filename = result.document.filename.replace(/["\\]/g, '')

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      'Content-Type': result.document.contentType,
      'Content-Length': String(result.data.byteLength),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      // Private, because this is somebody's paperwork and a shared cache in
      // front of the app must never hold it.
      'Cache-Control': 'private, max-age=300',
      // The bytes are whatever a supplier sent. Rendering them as anything the
      // browser guesses is how a text file becomes a script.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; object-src 'none'",
    },
  })
}
