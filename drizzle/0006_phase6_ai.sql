CREATE TYPE "public"."ai_feature" AS ENUM('bookkeeping_categorize', 'bookkeeping_anomalies', 'bookkeeping_rule', 'bookkeeping_summary', 'reconciliation_explain', 'proposal_draft', 'marketing_draft', 'business_insights');--> statement-breakpoint
CREATE TYPE "public"."ai_outcome" AS ENUM('ok', 'invalid_output', 'provider_error', 'refused', 'blocked_quota', 'blocked_disabled');--> statement-breakpoint
CREATE TYPE "public"."ai_suggestion_status" AS ENUM('pending', 'accepted', 'rejected', 'superseded');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"system_prompt" text NOT NULL,
	"template" text NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_prompts_scope_key_version_key" UNIQUE("company_id","key","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"feature" "ai_feature" NOT NULL,
	"prompt_key" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"outcome" "ai_outcome" NOT NULL,
	"detail" text,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'mock' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"monthly_ceiling_micros" bigint DEFAULT 2000000 NOT NULL,
	"hourly_request_limit" integer DEFAULT 120 NOT NULL,
	"disabled_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid,
	"feature" "ai_feature" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"status" "ai_suggestion_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence_bp" integer,
	"rationale" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_request_id_ai_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."ai_requests"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_prompts_key_idx" ON "ai_prompts" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_company_created_idx" ON "ai_requests" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_company_feature_idx" ON "ai_requests" USING btree ("company_id","feature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_company_status_idx" ON "ai_suggestions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_entity_idx" ON "ai_suggestions" USING btree ("company_id","entity_type","entity_id");