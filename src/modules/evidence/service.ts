import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { documentBlobs, documentLinks, documents, users } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { digestOf, freeBlobIfUnused, getObjectStore } from './store'
import {
  requireSubject,
  subjectDefinition,
  type EvidenceSubject,
  type SubjectRef,
} from './subjects'
import { DomainError } from '@/modules/errors'

/**
 * Attachments (spec §13, §18).
 *
 * Three levels, and the separation is the whole design:
 *
 *   **bytes** — content-addressed, shared, reference-counted
 *   **document** — one company's claim on those bytes, with its own filename
 *   **link** — that document hanging on one record
 *
 * A supplier invoice attached to the bill, to the payment that cleared it, and
 * to the month's journal entry is one set of bytes, one document, three links.
 * Detaching it from the payment leaves the other two untouched, and deleting
 * the document removes all three at once and only then frees the bytes.
 */

/**
 * What may be uploaded as evidence.
 *
 * Wider than the brand asset library, because evidence is whatever the
 * supplier sent: a PDF invoice, a photographed till receipt, a spreadsheet of
 * hours, an emailed CSV statement. SVG is excluded for the same reason it is
 * excluded from the asset library — it can carry script, and these files are
 * served back to browsers.
 */
export const EVIDENCE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

/**
 * The ceiling on one file.
 *
 * Larger than the 2 MB mobile receipt limit, because a scanned twelve-page
 * contract is a real thing somebody attaches to a bill from a desk, and
 * smaller than anything that belongs in a database row comfortably. The
 * mobile limit stays where it is: it exists to protect somebody's data
 * allowance, not the server.
 */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024

export class EvidenceError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceError'
  }
}

export type StoreInput = {
  filename: string
  contentType: string
  data: Buffer
  note?: string | null
}

export type StoredDocument = {
  id: string
  digest: string
  filename: string
  contentType: string
  sizeBytes: number
  /** True when these exact bytes were already held by this company. */
  deduplicated: boolean
}

/**
 * Stores bytes and returns this company's document for them.
 *
 * Uploading the same file twice returns the same row rather than a second one.
 * That is not only a storage saving: an evidence list that shows the same
 * receipt four times because somebody re-sent an email is a list people stop
 * reading.
 *
 * The reference count is incremented only when a *new* document row is
 * created, so it counts documents rather than uploads. Attaching one document
 * to six records does not touch it — the links cascade from the document, and
 * the document is what holds the bytes alive.
 */
export async function storeDocument(
  ctx: ActorContext,
  input: StoreInput,
  exec?: Executor,
): Promise<StoredDocument> {
  if (!(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new EvidenceError(
      `${input.contentType} is not a file type this keeps. Use a PDF, an image, or a spreadsheet.`,
    )
  }
  if (input.data.byteLength === 0) throw new EvidenceError('That file is empty.')
  if (input.data.byteLength > MAX_EVIDENCE_BYTES) {
    throw new EvidenceError(
      `That file is ${(input.data.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
    )
  }

  const digest = digestOf(input.data)
  const store = getObjectStore()

  // The bytes go down before any row points at them. The other order leaves a
  // document row whose file cannot be fetched, which is worse than an orphaned
  // blob: one is invisible, the other is a broken link in somebody's evidence.
  await store.put(digest, input.data, input.contentType)

  const write = async (tx: Executor): Promise<StoredDocument> => {
    await tx
      .insert(documentBlobs)
      .values({
        digest,
        contentType: input.contentType,
        sizeBytes: input.data.byteLength,
        storageProvider: store.key,
      })
      .onConflictDoNothing()

    const [existing] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.companyId, ctx.companyId), eq(documents.digest, digest)))
      .limit(1)

    if (existing) {
      return {
        id: existing.id,
        digest,
        filename: existing.filename,
        contentType: existing.contentType,
        sizeBytes: existing.sizeBytes,
        deduplicated: true,
      }
    }

    const [document] = await tx
      .insert(documents)
      .values({
        companyId: ctx.companyId,
        digest,
        filename: input.filename.slice(0, 200),
        contentType: input.contentType,
        sizeBytes: input.data.byteLength,
        note: input.note ?? null,
        uploadedBy: ctx.userId,
      })
      .returning()

    await tx
      .update(documentBlobs)
      .set({ referenceCount: sql`${documentBlobs.referenceCount} + 1` })
      .where(eq(documentBlobs.digest, digest))

    await recordAudit(
      ctx,
      {
        action: 'document.store',
        entityType: 'document',
        entityId: document.id,
        after: { filename: document.filename, sizeBytes: document.sizeBytes },
      },
      tx,
    )

    return {
      id: document.id,
      digest,
      filename: document.filename,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      deduplicated: false,
    }
  }

  return exec ? write(exec) : db.transaction(write)
}

/**
 * Hangs an existing document on a record.
 *
 * Both halves are proved before anything is written: the document under the
 * tenant filter, and the subject through the registry. A uuid arriving from a
 * phone is a string until the database agrees it belongs here (spec §19).
 */
export async function attachDocument(
  ctx: ActorContext,
  input: SubjectRef & { documentId: string },
  exec?: Executor,
): Promise<{ linkId: string; alreadyAttached: boolean }> {
  requirePermission(ctx, subjectDefinition(input.subjectType).manage)

  const write = async (tx: Executor) => {
    const [document] = await tx
      .select({ id: documents.id, filename: documents.filename })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.companyId, ctx.companyId)))
      .limit(1)

    if (!document) throw new EvidenceError('That document does not exist.')

    await requireSubject(ctx.companyId, input, tx)

    // The unique index is the arbiter, not a read-then-write: the mobile
    // outbox replays attachments, and two deliveries of one queued action must
    // leave one link. Same claim Phase 8 made about every replayed operation.
    const [link] = await tx
      .insert(documentLinks)
      .values({
        companyId: ctx.companyId,
        documentId: document.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        attachedBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: documentLinks.id })

    if (!link) {
      const [already] = await tx
        .select({ id: documentLinks.id })
        .from(documentLinks)
        .where(
          and(
            eq(documentLinks.documentId, document.id),
            eq(documentLinks.subjectType, input.subjectType),
            eq(documentLinks.subjectId, input.subjectId),
          ),
        )
        .limit(1)

      return { linkId: already.id, alreadyAttached: true }
    }

    await recordAudit(
      ctx,
      {
        action: 'document.attach',
        entityType: input.subjectType,
        entityId: input.subjectId,
        after: { documentId: document.id, filename: document.filename },
      },
      tx,
    )

    return { linkId: link.id, alreadyAttached: false }
  }

  return exec ? write(exec) : db.transaction(write)
}

/**
 * Takes a document off one record.
 *
 * The document stays, and so do its other links. A receipt attached to the
 * wrong transaction is the common case, and deleting the file would mean
 * re-photographing a piece of paper that is now in a bin — the same reasoning
 * Phase 8 gave for `detachReceipt`, kept because it was right.
 */
export async function detachDocument(
  ctx: ActorContext,
  input: SubjectRef & { documentId: string },
): Promise<boolean> {
  requirePermission(ctx, subjectDefinition(input.subjectType).manage)

  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(documentLinks)
      .where(
        and(
          eq(documentLinks.companyId, ctx.companyId),
          eq(documentLinks.documentId, input.documentId),
          eq(documentLinks.subjectType, input.subjectType),
          eq(documentLinks.subjectId, input.subjectId),
        ),
      )
      .returning({ id: documentLinks.id })

    if (removed.length === 0) return false

    await recordAudit(
      ctx,
      {
        action: 'document.detach',
        entityType: input.subjectType,
        entityId: input.subjectId,
        before: { documentId: input.documentId },
      },
      tx,
    )

    return true
  })
}

/**
 * Removes a document and every link to it, and frees the bytes if nobody else
 * holds them.
 *
 * Guarded by `accounting:journal` rather than by the permissions of whatever
 * the document happens to be attached to, and deliberately so: this removes it
 * from *every* record at once, and there is no permission that means "may
 * delete a file that is on a bank transaction and a payroll run". A bookkeeper
 * can take a receipt off a transaction — that is `detachDocument`, guarded by
 * the subject — and cannot destroy the file.
 */
export async function deleteDocument(ctx: ActorContext, documentId: string): Promise<boolean> {
  requirePermission(ctx, 'accounting:journal')

  // The row work commits first; the bytes are freed afterwards, outside the
  // transaction, for the reason spelled out on `freeBlobIfUnused`.
  const digest = await db.transaction(async (tx) => {
    const [document] = await tx
      .delete(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, ctx.companyId)))
      .returning()

    if (!document) return null

    // `greatest(… , 0)` rather than a bare subtraction: a count that has drifted
    // below zero would make every future delete think the bytes are still in
    // use, and the sweep would never reclaim them.
    await tx
      .update(documentBlobs)
      .set({ referenceCount: sql`greatest(${documentBlobs.referenceCount} - 1, 0)` })
      .where(eq(documentBlobs.digest, document.digest))

    await recordAudit(
      ctx,
      {
        action: 'document.delete',
        entityType: 'document',
        entityId: documentId,
        before: { filename: document.filename },
      },
      tx,
    )

    return document.digest
  })

  if (!digest) return false

  await freeBlobIfUnused(digest)
  return true
}

export type EvidenceItem = {
  documentId: string
  filename: string
  contentType: string
  sizeBytes: number
  note: string | null
  uploadedByName: string | null
  attachedAt: Date
}

/** What is attached to one record. */
export async function evidenceFor(
  ctx: ActorContext,
  ref: SubjectRef,
): Promise<EvidenceItem[]> {
  requirePermission(ctx, subjectDefinition(ref.subjectType).view)

  const rows = await db
    .select({
      documentId: documents.id,
      filename: documents.filename,
      contentType: documents.contentType,
      sizeBytes: documents.sizeBytes,
      note: documents.note,
      uploadedByName: users.name,
      attachedAt: documentLinks.createdAt,
    })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(
      scoped(
        ctx,
        documentLinks,
        eq(documentLinks.subjectType, ref.subjectType),
        eq(documentLinks.subjectId, ref.subjectId),
      ),
    )
    .orderBy(documentLinks.createdAt)

  return rows
}

/**
 * The same, for a page of records at once.
 *
 * One query rather than one per row. A register of forty assets each asking
 * for its own attachments is forty round trips to render one table, and it is
 * the shape that makes people give up and not show the evidence at all.
 */
export async function evidenceForMany(
  ctx: ActorContext,
  subjectType: EvidenceSubject,
  subjectIds: string[],
): Promise<Map<string, EvidenceItem[]>> {
  if (subjectIds.length === 0) return new Map()
  requirePermission(ctx, subjectDefinition(subjectType).view)

  const rows = await db
    .select({
      subjectId: documentLinks.subjectId,
      documentId: documents.id,
      filename: documents.filename,
      contentType: documents.contentType,
      sizeBytes: documents.sizeBytes,
      note: documents.note,
      uploadedByName: users.name,
      attachedAt: documentLinks.createdAt,
    })
    .from(documentLinks)
    .innerJoin(documents, eq(documents.id, documentLinks.documentId))
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(
      scoped(
        ctx,
        documentLinks,
        eq(documentLinks.subjectType, subjectType),
        inArray(documentLinks.subjectId, subjectIds),
      ),
    )
    .orderBy(documentLinks.createdAt)

  const grouped = new Map<string, EvidenceItem[]>()
  for (const { subjectId, ...item } of rows) {
    const list = grouped.get(subjectId) ?? []
    list.push(item)
    grouped.set(subjectId, list)
  }

  return grouped
}

/**
 * How many documents hang on each of a list of records.
 *
 * One query for a whole page, because the alternative is the inbox asking
 * "does this one have a receipt?" fifty times. Records with none are simply
 * absent from the map.
 */
export async function evidenceCounts(
  ctx: ActorContext,
  subjectType: EvidenceSubject,
  subjectIds: string[],
): Promise<Map<string, number>> {
  if (subjectIds.length === 0) return new Map()
  requirePermission(ctx, subjectDefinition(subjectType).view)

  const rows = await db
    .select({
      subjectId: documentLinks.subjectId,
      count: sql<string>`count(*)`,
    })
    .from(documentLinks)
    .where(
      scoped(
        ctx,
        documentLinks,
        eq(documentLinks.subjectType, subjectType),
        inArray(documentLinks.subjectId, subjectIds),
      ),
    )
    .groupBy(documentLinks.subjectId)

  return new Map(rows.map((row) => [row.subjectId, Number(row.count)]))
}

export type DocumentSummary = {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  note: string | null
  uploadedByName: string | null
  createdAt: Date
  attachedTo: number
}

/** Everything this company holds, newest first, with how many records use it. */
export async function listDocuments(ctx: ActorContext, limit = 200): Promise<DocumentSummary[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      contentType: documents.contentType,
      sizeBytes: documents.sizeBytes,
      note: documents.note,
      uploadedByName: users.name,
      createdAt: documents.createdAt,
      attachedTo: sql<string>`(
        select count(*) from ${documentLinks}
        where ${documentLinks.documentId} = ${documents.id}
      )`,
    })
    .from(documents)
    .leftJoin(users, eq(users.id, documents.uploadedBy))
    .where(scoped(ctx, documents))
    .orderBy(desc(documents.createdAt))
    .limit(limit)

  return rows.map((row) => ({ ...row, attachedTo: Number(row.attachedTo) }))
}

/**
 * Where a document is used, so "can I delete this?" has an answer.
 *
 * Returns the subject kind and id rather than a link to each record: this
 * module knows what a bill is only well enough to check it exists, and
 * teaching it to build a URL for one would put routing in a service.
 */
export async function usesOf(ctx: ActorContext, documentId: string) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      subjectType: documentLinks.subjectType,
      subjectId: documentLinks.subjectId,
      attachedAt: documentLinks.createdAt,
    })
    .from(documentLinks)
    .where(scoped(ctx, documentLinks, eq(documentLinks.documentId, documentId)))
    .orderBy(documentLinks.createdAt)
}

/**
 * Reads a document's bytes for a tenant-scoped caller.
 *
 * **The only function that reads the object store.** The store is not
 * partitioned by tenant — bytes are shared between companies that hold
 * identical files — so the authorization is entirely this lookup: the digest
 * is taken from a `documents` row already filtered by company, never from the
 * request. A route that accepted a digest and called `getObjectStore().get()`
 * would be a cross-tenant read, and that is why there is no such route.
 */
export async function readDocument(companyId: string, documentId: string) {
  const [document] = await db
    .select({
      id: documents.id,
      digest: documents.digest,
      filename: documents.filename,
      contentType: documents.contentType,
      storageProvider: documentBlobs.storageProvider,
    })
    .from(documents)
    .innerJoin(documentBlobs, eq(documentBlobs.digest, documents.digest))
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
    .limit(1)

  if (!document) return null

  const data = await getObjectStore(document.storageProvider).get(document.digest)
  if (!data) return null

  return { document, data }
}

/**
 * Records with no evidence at all.
 *
 * The question §13's attachments line exists to answer at year end: which of
 * these do we have paperwork for? A left join rather than a `NOT IN`, because
 * the id list is the whole ledger and the anti-join plans better.
 */
export async function withoutEvidence(
  ctx: ActorContext,
  subjectType: EvidenceSubject,
  candidateIds: string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const counts = await evidenceCounts(ctx, subjectType, candidateIds)
  return candidateIds.filter((id) => !counts.has(id))
}
