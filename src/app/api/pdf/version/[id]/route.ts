import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { proposalVersions } from '@/db/schema'
import { requireActor } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { readDocument } from '@/modules/evidence/service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The internal copy of what a client was sent.
 *
 * The same bytes the public link serves, reached from the workspace instead of
 * from a token — so a salesperson answering "what exactly did we quote them in
 * March?" opens the March file rather than reasoning about it from the current
 * record.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const actor = await requireActor()

  if (!can(actor, 'proposals:view')) return new NextResponse(null, { status: 403 })

  const [version] = await db
    .select({
      documentId: proposalVersions.pdfDocumentId,
      versionNumber: proposalVersions.versionNumber,
    })
    .from(proposalVersions)
    .where(
      and(eq(proposalVersions.id, id), eq(proposalVersions.companyId, actor.companyId)),
    )
    .limit(1)

  if (!version?.documentId) return new NextResponse(null, { status: 404 })

  const result = await readDocument(actor.companyId, version.documentId)
  if (!result) return new NextResponse(null, { status: 404 })

  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(result.data.byteLength),
      'Content-Disposition': `inline; filename="${result.document.filename}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
