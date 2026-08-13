CREATE TYPE "public"."asset_kind" AS ENUM('logo', 'image', 'document');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('proposal', 'marketing', 'template');--> statement-breakpoint
CREATE TYPE "public"."page_size" AS ENUM('letter', 'a4', 'legal');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_blobs" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "asset_kind" DEFAULT 'image' NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"storage_provider" text DEFAULT 'database' NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"primary_color" text DEFAULT '#0d6e60' NOT NULL,
	"accent_color" text DEFAULT '#0f766e' NOT NULL,
	"text_color" text DEFAULT '#0f172a' NOT NULL,
	"muted_color" text DEFAULT '#64748b' NOT NULL,
	"surface_color" text DEFAULT '#ffffff' NOT NULL,
	"heading_font" text DEFAULT 'Georgia, serif' NOT NULL,
	"body_font" text DEFAULT 'system-ui, sans-serif' NOT NULL,
	"base_size_pt" integer DEFAULT 11 NOT NULL,
	"logo_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clause_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"clause_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"body" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clause_versions_unique" UNIQUE("clause_id","version_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text DEFAULT 'terms' NOT NULL,
	"current_version_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"legal_name" text,
	"dba" text,
	"tagline" text,
	"description" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"phone" text,
	"email" text,
	"website" text,
	"tax_id" text,
	"payment_instructions" text,
	"credentials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_footer" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_profiles_company_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"unit" text DEFAULT 'each' NOT NULL,
	"unit_price_cents" bigint DEFAULT 0 NOT NULL,
	"unit_cost_cents" bigint DEFAULT 0 NOT NULL,
	"is_taxable" boolean DEFAULT false NOT NULL,
	"chart_account_id" uuid,
	"default_proposal_copy" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_items_company_code_unique" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "document_kind" DEFAULT 'proposal' NOT NULL,
	"name" text NOT NULL,
	"proposal_id" uuid,
	"brand_kit_id" uuid,
	"page_size" "page_size" DEFAULT 'letter' NOT NULL,
	"orientation" text DEFAULT 'portrait' NOT NULL,
	"margin_top_pt" integer DEFAULT 54 NOT NULL,
	"margin_right_pt" integer DEFAULT 54 NOT NULL,
	"margin_bottom_pt" integer DEFAULT 54 NOT NULL,
	"margin_left_pt" integer DEFAULT 54 NOT NULL,
	"header_text" text,
	"footer_text" text,
	"show_page_numbers" boolean DEFAULT true NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "document_kind" DEFAULT 'proposal' NOT NULL,
	"industry" text,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_company_key_unique" UNIQUE("company_id","key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"proposal_version_id" uuid,
	"signer_name" text NOT NULL,
	"signer_email" text,
	"signer_title" text,
	"signature_text" text NOT NULL,
	"selected_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_total_cents" integer NOT NULL,
	"ip_prefix" text,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_acceptances_proposal_unique" UNIQUE("proposal_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_clause_id_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."clauses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clauses" ADD CONSTRAINT "clauses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_items" ADD CONSTRAINT "service_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_items" ADD CONSTRAINT "service_items_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "design_documents" ADD CONSTRAINT "design_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "design_documents" ADD CONSTRAINT "design_documents_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "design_documents" ADD CONSTRAINT "design_documents_brand_kit_id_brand_kits_id_fk" FOREIGN KEY ("brand_kit_id") REFERENCES "public"."brand_kits"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "design_documents" ADD CONSTRAINT "design_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_version_fk" FOREIGN KEY ("proposal_version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_company_idx" ON "assets" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_kits_company_idx" ON "brand_kits" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clauses_company_idx" ON "clauses" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_items_company_idx" ON "service_items" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_documents_company_kind_idx" ON "design_documents" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "design_documents_proposal_idx" ON "design_documents" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_templates_gallery_idx" ON "document_templates" USING btree ("kind","industry");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposal_acceptances_company_idx" ON "proposal_acceptances" USING btree ("company_id","accepted_at");