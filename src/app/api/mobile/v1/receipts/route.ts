import { NextResponse, type NextRequest } from 'next/server'
import { currentActor } from '@/lib/current-user'
import { PermissionError } from '@/modules/permissions'
import { MAX_RECEIPT_BYTES, uploadReceipt } from '@/modules/mobile/receipts'
import { messageFor } from '@/modules/errors'

/**
 * Receipt upload (spec §3).
 *
 *   POST /api/mobile/v1/receipts   multipart/form-data, field "file"
 *
 * Separate from the sync endpoint on purpose. Sync carries a JSON queue of
 * decisions; a receipt is a megabyte of JPEG, and putting it in the same
 * request would mean base64-inflating it by a third and holding the whole
 * batch hostage to one slow upload.
 *
 * The upload returns an asset id. *Attaching* it to a transaction is a queued
 * operation like any other, so a photo taken underground uploads when signal
 * returns and the attachment replays with the rest of the outbox.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const actor = await currentActor()
  if (!actor) {
    return NextResponse.json(
      { error: 'Not signed in.', code: 'unauthenticated' },
      { status: 401 },
    )
  }

  // Checked before the body is read, so an oversized upload is refused rather
  // than buffered. The service checks the real length again, because a
  // content-length header is a claim rather than a fact.
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_RECEIPT_BYTES * 1.1) {
    return NextResponse.json(
      { error: 'That receipt is too large.', code: 'too_large' },
      { status: 413 },
    )
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json(
      { error: 'Expected a multipart upload.', code: 'bad_request' },
      { status: 400 },
    )
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'No file was included.', code: 'bad_request' },
      { status: 400 },
    )
  }

  try {
    const asset = await uploadReceipt(actor, {
      filename: file.name || 'receipt.jpg',
      contentType: file.type,
      data: Buffer.from(await file.arrayBuffer()),
    })

    return NextResponse.json(
      {
        assetId: asset.id,
        filename: asset.filename,
        sizeBytes: asset.sizeBytes,
        contentType: asset.contentType,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    if (error instanceof PermissionError) {
      return NextResponse.json({ error: error.message, code: 'forbidden' }, { status: 403 })
    }

    return NextResponse.json(
      {
        error: messageFor(error, 'That upload failed.'),
        code: 'rejected',
      },
      { status: 400 },
    )
  }
}
