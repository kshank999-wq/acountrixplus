import type { Executor } from '@/db'
import { type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import {
  attachDocument,
  detachDocument,
  evidenceFor,
  storeDocument,
} from '@/modules/evidence/service'

/**
 * Receipt capture (spec §3 "attach receipts/documents").
 *
 * The mobile case this exists for is narrow and worth naming: somebody is
 * standing at a counter with a paper receipt they will lose before they get to
 * a desk. Photographing it there is the whole feature, and everything below is
 * in service of that moment working on a bad connection.
 *
 * ## What this is now
 *
 * As of Phase 20 this is a thin front on `modules/evidence`, not its own
 * storage. Phase 8 built receipts before anything else could carry a document,
 * so it wrote its own upload path into the brand asset library and its own
 * `jsonb` array on the transaction row. Both were the right size then and both
 * were wrong in the same way: a receipt is evidence, evidence belongs to more
 * than bank transactions, and an array on a row cannot answer "which of these
 * has no paperwork?"
 *
 * What survives is the part that was about *phones*: a tighter file-size
 * ceiling than the desk gets, a narrower list of accepted types, and the split
 * between uploading and attaching. Those are still right, and they are still
 * here.
 */

/**
 * Receipts are photographs and scans. PDF is included because a supplier
 * emailing one is the second most common case; SVG is excluded because it can
 * carry script and these files are served back to browsers.
 */
export const RECEIPT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'application/pdf',
] as const

/**
 * The ceiling on an uploaded receipt.
 *
 * Deliberately a fifth of the 10 MB the evidence store allows. A phone camera
 * produces 4 MB of JPEG for a piece of till paper; the client downscales before
 * sending, and this limit is what makes a client that forgot to fail loudly
 * rather than burning somebody's mobile data. The desk limit protects the
 * server; this one protects the person.
 */
export const MAX_RECEIPT_BYTES = 2 * 1024 * 1024

export type ReceiptUpload = {
  filename: string
  contentType: string
  data: Buffer
}

/**
 * Stores a receipt and returns it.
 *
 * Separate from attaching it, because on a phone the two happen at different
 * times: the photo uploads while the person is still choosing a category, and
 * the attachment is queued with the rest of their decisions.
 *
 * The return shape keeps `id`, `filename`, `contentType` and `sizeBytes`,
 * because the mobile v1 response is built from them and a versioned contract
 * does not change underneath a phone that has not been updated.
 */
export async function uploadReceipt(ctx: ActorContext, input: ReceiptUpload) {
  if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new Refusal(
      `Unsupported file type ${input.contentType}. Use a photo (PNG, JPEG, WebP) or a PDF.`,
    )
  }
  if (input.data.byteLength > MAX_RECEIPT_BYTES) {
    throw new Refusal('That receipt is larger than 2 MB. Try again with a smaller photo.')
  }

  const document = await storeDocument(ctx, input)

  return {
    id: document.id,
    filename: document.filename,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
  }
}

/**
 * Attaches an already-uploaded receipt to a transaction.
 *
 * Idempotent by construction — the unique index on `document_links` decides,
 * not a read-then-write. That is not politeness: it is what lets this operation
 * sit in the offline outbox and be replayed, and it means the guarantee holds
 * even for a client that lost its idempotency key.
 *
 * Answers with the document id rather than a link id, because that is what a
 * later detach names and what the phone already holds.
 */
export async function attachReceipt(
  ctx: ActorContext,
  transactionId: string,
  documentId: string,
  exec?: Executor,
): Promise<{ documentId: string; alreadyAttached: boolean }> {
  const result = await attachDocument(
    ctx,
    { subjectType: 'bank_transaction', subjectId: transactionId, documentId },
    exec,
  )

  return { documentId, alreadyAttached: result.alreadyAttached }
}

/**
 * Removes a receipt from a transaction.
 *
 * The document itself stays. A receipt attached to the wrong transaction is
 * the common case, and deleting the bytes would mean re-photographing a piece
 * of paper that is now in a bin.
 */
export async function detachReceipt(
  ctx: ActorContext,
  transactionId: string,
  documentId: string,
): Promise<void> {
  await detachDocument(ctx, {
    subjectType: 'bank_transaction',
    subjectId: transactionId,
    documentId,
  })
}

/** Receipts on a transaction, for the detail view. */
export async function receiptsFor(ctx: ActorContext, transactionId: string) {
  return evidenceFor(ctx, { subjectType: 'bank_transaction', subjectId: transactionId })
}
