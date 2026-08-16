CREATE TYPE "public"."evidence_subject" AS ENUM('bank_transaction', 'journal_entry', 'invoice', 'bill', 'payment', 'fixed_asset', 'reconciliation', 'payroll_run', 'expense', 'customer', 'vendor');--> statement-breakpoint
CREATE TABLE "document_blobs" (
	"digest" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_provider" text NOT NULL,
	"reference_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_bytes" (
	"digest" text PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"subject_type" "evidence_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"attached_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_links_unique" UNIQUE("document_id","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"note" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_company_digest_unique" UNIQUE("company_id","digest")
);
--> statement-breakpoint
CREATE TABLE "record_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" "evidence_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"body" text NOT NULL,
	"is_question" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_notes_body_not_empty" CHECK (length(btrim("record_notes"."body")) > 0),
	CONSTRAINT "record_notes_resolvable" CHECK ("record_notes"."resolved_at" IS NULL OR "record_notes"."is_question")
);
--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_attached_by_users_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_digest_document_blobs_digest_fk" FOREIGN KEY ("digest") REFERENCES "public"."document_blobs"("digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_notes" ADD CONSTRAINT "record_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_notes" ADD CONSTRAINT "record_notes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_notes" ADD CONSTRAINT "record_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_links_subject_idx" ON "document_links" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "document_links_document_idx" ON "document_links" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_company_idx" ON "documents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_digest_idx" ON "documents" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "record_notes_subject_idx" ON "record_notes" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "record_notes_open_idx" ON "record_notes" USING btree ("company_id","resolved_at");--> statement-breakpoint
-- Phase 20, hand-written below this line.
--
-- The backfill that moves Phase 8's receipts onto the evidence tables, before
-- the column holding them is dropped. drizzle-kit generates schema, not data.

-- Backfill: every receipt Phase 8 attached to a bank transaction becomes a
-- blob, a document, and a link.
--
-- Only the database asset store can be migrated in SQL, because only its bytes
-- are reachable from here — which is fine, because it is the only adapter that
-- has ever existed. A deployment running something else would need to re-hash
-- its objects, and would know it.
INSERT INTO "document_blobs" ("digest", "content_type", "size_bytes", "storage_provider", "reference_count")
SELECT DISTINCT ON (encode(sha256(b.data), 'hex'))
       encode(sha256(b.data), 'hex'), a.content_type, a.size_bytes, 'database', 0
  FROM "assets" a
  JOIN "asset_blobs" b ON b.storage_key = a.storage_key
 WHERE a.storage_provider = 'database'
   AND EXISTS (
         SELECT 1 FROM "bank_transactions" t
          WHERE t.attachments @> jsonb_build_array(jsonb_build_object('id', a.id::text))
       )
ON CONFLICT ("digest") DO NOTHING;
--> statement-breakpoint

INSERT INTO "document_bytes" ("digest", "data")
SELECT DISTINCT ON (encode(sha256(b.data), 'hex')) encode(sha256(b.data), 'hex'), b.data
  FROM "assets" a
  JOIN "asset_blobs" b ON b.storage_key = a.storage_key
 WHERE a.storage_provider = 'database'
   AND EXISTS (
         SELECT 1 FROM "bank_transactions" t
          WHERE t.attachments @> jsonb_build_array(jsonb_build_object('id', a.id::text))
       )
ON CONFLICT ("digest") DO NOTHING;
--> statement-breakpoint

-- The document keeps the asset's own id, so a phone holding a queued
-- `receipt.attach` for an asset uploaded before the deploy still finds it.
-- That is Phase 8's replay contract, and it outranks a tidier key.
INSERT INTO "documents" ("id", "company_id", "digest", "filename", "content_type", "size_bytes", "uploaded_by", "created_at")
SELECT DISTINCT ON (a.company_id, encode(sha256(b.data), 'hex'))
       a.id, a.company_id, encode(sha256(b.data), 'hex'), a.filename, a.content_type,
       a.size_bytes, a.uploaded_by, a.created_at
  FROM "assets" a
  JOIN "asset_blobs" b ON b.storage_key = a.storage_key
 WHERE a.storage_provider = 'database'
   AND EXISTS (
         SELECT 1 FROM "bank_transactions" t
          WHERE t.attachments @> jsonb_build_array(jsonb_build_object('id', a.id::text))
       )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

UPDATE "document_blobs" bl
   SET "reference_count" = (SELECT count(*) FROM "documents" d WHERE d.digest = bl.digest);
--> statement-breakpoint

--
-- Resolved through the digest rather than through `d.id = asset id`. A company
-- that uploaded the same receipt twice has two assets and, correctly, one
-- document — so matching on the id alone would silently drop the attachment
-- belonging to whichever asset lost the de-duplication.
INSERT INTO "document_links" ("company_id", "document_id", "subject_type", "subject_id", "created_at")
-- The cast is required: SELECT DISTINCT resolves the bare literal to `text`
-- before the target column's type can be inferred from it.
SELECT DISTINCT t.company_id, d.id, 'bank_transaction'::evidence_subject, t.id, now()
  FROM "bank_transactions" t
  CROSS JOIN LATERAL jsonb_array_elements(t.attachments) AS entry
  JOIN "assets" a ON a.id = (entry->>'id')::uuid AND a.company_id = t.company_id
  JOIN "asset_blobs" b ON b.storage_key = a.storage_key
  JOIN "documents" d
    ON d.digest = encode(sha256(b.data), 'hex') AND d.company_id = t.company_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The column goes. Leaving a jsonb array that nothing writes is the "two
-- answers to one question" problem this codebase keeps refusing elsewhere:
-- one of them would eventually be read.
ALTER TABLE "bank_transactions" DROP COLUMN IF EXISTS "attachments";
