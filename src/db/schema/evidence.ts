import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  index,
  unique,
  pgEnum,
  check,
  customType,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'

/**
 * Evidence: attachments and accountant notes (spec §13, §18).
 *
 * §13's list of what a professional accounting workspace needs ends "period
 * close/lock controls, audit trail, accountant notes, attachments, exports".
 * Four of those five have been built since Phase 12. The two missing ones are
 * here, and they turn out to be the same shape: a thing that hangs off *any*
 * accounting record and belongs to whoever may read that record.
 *
 * Before this, exactly one kind of record could carry evidence — a bank
 * transaction, through a `jsonb` array — which is the wrong answer twice over.
 * A supplier invoice belongs on the bill, not on the payment that happened to
 * clear it; and an array on a row cannot be queried ("show me everything with
 * no receipt"), cannot be counted, and cannot be constrained.
 */

/** Raw bytes, for the database-backed object store adapter. */
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType: () => 'bytea',
})

/**
 * The bytes themselves, addressed by their SHA-256.
 *
 * **Not tenant-scoped, and deliberately so.** Two companies that upload the
 * same government form share one row. Nothing is ever reachable through this
 * table: every read starts from a `documents` row found under a tenant filter,
 * and the digest is used only after that. See the note in
 * `src/modules/evidence/store.ts` — this is the design's one sharp edge and it
 * is worth stating in both places.
 */
export const documentBlobs = pgTable('document_blobs', {
  digest: text('digest').primaryKey(),
  contentType: text('content_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  /** Which adapter holds the bytes. Read from here, never from the setting. */
  storageProvider: text('storage_provider').notNull(),
  /**
   * How many `documents` rows point here.
   *
   * The bytes are freed when this reaches zero and not before. Kept as a
   * column rather than derived by counting because the delete path needs to
   * decide under a lock, and `UPDATE ... SET n = n - 1 RETURNING n` is that
   * lock — the same shape as every other contested write in this codebase.
   */
  referenceCount: integer('reference_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Backing store for the database adapter. An S3 adapter never touches this. */
export const documentBytes = pgTable('document_bytes', {
  digest: text('digest').primaryKey(),
  data: bytea('data').notNull(),
})

/**
 * One company's claim on some bytes, with the name that company knows them by.
 *
 * The filename lives here rather than on the blob because two companies can
 * hold identical bytes under different names, and because renaming a document
 * must not touch anybody else's.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    digest: text('digest')
      .notNull()
      .references(() => documentBlobs.digest),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),

    /** Free text the uploader typed — "signed copy", "page 2 missing". */
    note: text('note'),

    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('documents_company_idx').on(t.companyId, t.createdAt),
    // "Does anybody still hold these bytes?" — the question the delete path
    // asks, and the reason the reference count is a report rather than the
    // authority.
    digestIdx: index('documents_digest_idx').on(t.digest),
    /**
     * One company holds one document per distinct file.
     *
     * Uploading the same receipt twice returns the row that already exists
     * rather than making a second one, so "how many documents do we have" is
     * answerable and the evidence list does not fill with duplicates. Attaching
     * that one document to three records is what `document_links` is for.
     */
    perCompanyUnique: unique('documents_company_digest_unique').on(t.companyId, t.digest),
  }),
)

/**
 * What can carry evidence.
 *
 * An enum rather than free text, because a typo in a subject type is a document
 * that is attached to nothing and displayed nowhere, and nothing would ever
 * report it. Adding a kind means adding it here *and* to the registry in
 * `src/modules/evidence/subjects.ts`, which is the point: the registry names
 * the permission that guards it, so a new kind cannot arrive unguarded.
 */
export const evidenceSubjectEnum = pgEnum('evidence_subject', [
  'bank_transaction',
  'journal_entry',
  'invoice',
  'bill',
  'payment',
  'fixed_asset',
  'reconciliation',
  'payroll_run',
  'expense',
  'customer',
  'vendor',
])

/**
 * A document hanging on a record.
 *
 * The link is what a person sees; the document is what is stored. One
 * supplier invoice PDF attached to the bill, the payment, and the month's
 * journal entry is one blob, one document, three links.
 */
export const documentLinks = pgTable(
  'document_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    subjectType: evidenceSubjectEnum('subject_type').notNull(),
    /**
     * No foreign key, because there is no one table to point at. The registry
     * checks existence under the tenant filter before a link is written, which
     * is the same guarantee a constraint would give and the only one available
     * for a polymorphic reference.
     */
    subjectId: uuid('subject_id').notNull(),

    attachedBy: uuid('attached_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectIdx: index('document_links_subject_idx').on(
      t.companyId,
      t.subjectType,
      t.subjectId,
    ),
    documentIdx: index('document_links_document_idx').on(t.documentId),
    /**
     * Attaching the same document to the same record twice is one link.
     *
     * Load-bearing: the mobile outbox replays attachments after a bad
     * connection, and two deliveries of one queued action must leave one link
     * — the same claim Phase 8 made about every other replayed operation.
     */
    onceEach: unique('document_links_unique').on(t.documentId, t.subjectType, t.subjectId),
  }),
)

/**
 * An accountant's note on a record (spec §13 "accountant notes").
 *
 * Separate from the audit log, which records what the *software* did. A note
 * records what a person concluded — "reclassified per client email 14 Aug",
 * "supplier confirms this is a deposit not a prepayment" — and it is the thing
 * a reviewer reads first at year end.
 *
 * Edits keep the original: a note that can be silently rewritten is not
 * evidence of anything. `resolvedAt` closes a question without deleting it.
 */
export const recordNotes = pgTable(
  'record_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    subjectType: evidenceSubjectEnum('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    body: text('body').notNull(),
    /**
     * A note that asks something rather than states it.
     *
     * The distinction earns its column: "what is this?" left on forty
     * transactions is a work list, and a work list nobody can filter for is
     * forty notes nobody answers.
     */
    isQuestion: boolean('is_question').notNull().default(false),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),

    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Frozen at write time, so a note keeps its author after they leave. */
    authorName: text('author_name').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subjectIdx: index('record_notes_subject_idx').on(t.companyId, t.subjectType, t.subjectId),
    openIdx: index('record_notes_open_idx').on(t.companyId, t.resolvedAt),
    bodyNotEmpty: check('record_notes_body_not_empty', sql`length(btrim(${t.body})) > 0`),
    // Only a question can be resolved. Marking a statement "resolved" is a
    // category error, and one that would quietly hide it from the work list.
    resolvableShape: check(
      'record_notes_resolvable',
      sql`${t.resolvedAt} IS NULL OR ${t.isQuestion}`,
    ),
  }),
)
