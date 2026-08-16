import { NextResponse } from 'next/server'
import { requireActor } from '@/lib/current-user'
import { PermissionError } from '@/modules/permissions'
import { NoInvoiceError, renderInvoicePdf } from '@/modules/pdf/invoice'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * An invoice as a PDF, rendered from the record on every request.
 *
 * Not snapshotted, unlike a proposal — see the note at the top of
 * `modules/pdf/invoice.ts`. The date stamped into the file is the moment it was
 * generated, which is honest for a document that is regenerated: it is a print
 * of the current record, not a copy of something historic.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params

  try {
    const actor = await requireActor()
    const { bytes, filename } = await renderInvoicePdf(actor, id, new Date())

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof PermissionError) return new NextResponse(null, { status: 403 })
    if (error instanceof NoInvoiceError) return new NextResponse(null, { status: 404 })
    throw error
  }
}
