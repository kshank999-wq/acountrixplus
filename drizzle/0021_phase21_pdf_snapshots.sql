ALTER TYPE "public"."evidence_subject" ADD VALUE 'proposal_version';--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD COLUMN "pdf_document_id" uuid;