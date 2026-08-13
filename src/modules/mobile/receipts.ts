import { randomUUID, createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { assets, bankTransactions, type Attachment } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { getAssetStore, ALLOWED_IMAGE_TYPES } from '@/modules/studio/assets'

/**
 * Receipt capture (spec §3 "attach receipts/documents").
 *
 * The mobile case this exists for is narrow and worth naming: somebody is
 * standing at a counter with a paper receipt they will lose before they get to
 * a desk. Photographing it there is the whole feature, and everything below is
 * in service of that moment working on a bad connection.
 *
 * ## Why receipts do not go through `uploadAsset`
 *
 * `uploadAsset` requires `company:manage`, because it is the brand asset
 * library — a bookkeeper has no business replacing the logo. A bookkeeper has
 * every business photographing a receipt, so this is a separate entry point
 * with its own permission (`bookkeeping:categorize`) writing into the same
 * store. Sharing the storage and splitting the permission is the right way
 * round; sharing the permission would have meant either widening it for
 * everyone or refusing the person who actually holds the receipt.
 */

/**
 * Receipts are photographs and scans. PDF is included because a supplier
 * emailing one is the second most common case; SVG is excluded for the same
 * reason it is excluded from the asset library — it can carry script.
 */
export const RECEIPT_CONTENT_TYPES = [...ALLOWED_IMAGE_TYPES, 'application/pdf'] as const

/**
 * The ceiling on an uploaded receipt.
 *
 * Smaller than the 5 MB asset limit on purpose. A phone camera produces 4 MB
 * of JPEG for a piece of till paper; the client downscales before sending, and
 * this limit is what makes a client that forgot to fail loudly rather than
 * burning somebody's mobile data.
 */
export const MAX_RECEIPT_BYTES = 2 * 1024 * 1024

export type ReceiptUpload = {
  filename: string
  contentType: string
  data: Buffer
}

/**
 * Stores a receipt image and returns the asset.
 *
 * Separate from attaching it, because on a phone the two happen at different
 * times: the photo uploads while the person is still choosing a category, and
 * the attachment is queued with the rest of their decisions.
 */
export async function uploadReceipt(ctx: ActorContext, input: ReceiptUpload) {
  requirePermission(ctx, 'bookkeeping:categorize')

  if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new Error(
      `Unsupported file type ${input.contentType}. Use a photo (PNG, JPEG, WebP) or a PDF.`,
    )
  }
  if (input.data.byteLength === 0) throw new Error('That file is empty.')
  if (input.data.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error('That receipt is larger than 2 MB. Try again with a smaller photo.')
  }

  // Same key shape as the asset library: content hash for stability, tenant
  // prefix so one company's key can never collide with another's.
  const digest = createHash('sha256').update(input.data).digest('hex').slice(0, 32)
  const storageKey = `${ctx.companyId}/receipts/${digest}-${randomUUID().slice(0, 8)}`

  const store = getAssetStore()
  await store.put(storageKey, input.data, input.contentType)

  const [asset] = await db
    .insert(assets)
    .values({
      companyId: ctx.companyId,
      kind: 'document',
      filename: input.filename.slice(0, 200),
      contentType: input.contentType,
      sizeBytes: input.data.byteLength,
      storageProvider: store.key,
      storageKey,
      uploadedBy: ctx.userId,
    })
    .returning()

  await recordAudit(ctx, {
    action: 'asset.upload',
    entityType: 'asset',
    entityId: asset.id,
    after: { filename: asset.filename, sizeBytes: asset.sizeBytes, kind: 'receipt' },
  })

  return asset
}

/**
 * Attaches an already-uploaded asset to a transaction.
 *
 * Idempotent by construction: attaching the same asset twice leaves one
 * attachment. That is not politeness — it is what lets this operation sit in
 * the offline outbox and be replayed, and it means the guarantee holds even
 * for a client that lost its idempotency key.
 */
export async function attachReceipt(
  ctx: ActorContext,
  transactionId: string,
  assetId: string,
  exec?: Executor,
): Promise<Attachment> {
  requirePermission(ctx, 'bookkeeping:categorize')

  const write = async (tx: Executor): Promise<Attachment> => {
    const [transaction] = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )
      .limit(1)

    if (!transaction) throw new Error('Transaction not found')

    // Looked up under the tenant filter rather than trusted from the request:
    // an asset id from a phone is a string until the database agrees it is
    // this company's (spec §19).
    const [asset] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.companyId, ctx.companyId)))
      .limit(1)

    if (!asset) throw new Error('Receipt not found')

    const existing = transaction.attachments.find((entry) => entry.id === asset.id)
    if (existing) return existing

    const attachment: Attachment = {
      id: asset.id,
      filename: asset.filename,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      storageKey: asset.storageKey,
      uploadedAt: new Date().toISOString(),
    }

    await tx
      .update(bankTransactions)
      .set({
        attachments: [...transaction.attachments, attachment],
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'receipt.attach',
        entityType: 'bank_transaction',
        entityId: transactionId,
        after: { assetId: asset.id, filename: asset.filename },
      },
      tx,
    )

    return attachment
  }

  return exec ? write(exec) : db.transaction(write)
}

/**
 * Removes an attachment from a transaction.
 *
 * The asset itself stays. A receipt attached to the wrong transaction is the
 * common case, and deleting the bytes would mean re-photographing a piece of
 * paper that is now in a bin.
 */
export async function detachReceipt(
  ctx: ActorContext,
  transactionId: string,
  assetId: string,
): Promise<void> {
  requirePermission(ctx, 'bookkeeping:categorize')

  await db.transaction(async (tx) => {
    const [transaction] = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )
      .limit(1)

    if (!transaction) throw new Error('Transaction not found')

    const remaining = transaction.attachments.filter((entry) => entry.id !== assetId)
    if (remaining.length === transaction.attachments.length) return

    await tx
      .update(bankTransactions)
      .set({ attachments: remaining, updatedAt: new Date() })
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'receipt.detach',
        entityType: 'bank_transaction',
        entityId: transactionId,
        before: { assetId },
      },
      tx,
    )
  })
}

/** Attachments on a transaction, for the detail view. */
export async function receiptsFor(ctx: ActorContext, transactionId: string) {
  requirePermission(ctx, 'bookkeeping:view')

  const [transaction] = await db
    .select({ attachments: bankTransactions.attachments })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.id, transactionId),
        eq(bankTransactions.companyId, ctx.companyId),
      ),
    )
    .limit(1)

  return transaction?.attachments ?? []
}
