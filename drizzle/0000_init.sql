CREATE TYPE "public"."industry" AS ENUM('professional_services', 'construction', 'retail', 'restaurant', 'manufacturing', 'real_estate', 'creative', 'healthcare', 'nonprofit', 'ecommerce', 'automotive', 'personal_care', 'wholesale', 'general');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'manager', 'bookkeeper', 'accountant', 'sales', 'marketing', 'readonly');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'other_income', 'other_expense');--> statement-breakpoint
CREATE TYPE "public"."financial_account_kind" AS ENUM('checking', 'savings', 'credit_card', 'loan', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'needs_reauth', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('new', 'suggested', 'needs_review', 'categorized', 'matched', 'excluded', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."rule_action" AS ENUM('auto', 'suggest');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"industry" "industry" DEFAULT 'general' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"permission_overrides" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_company_user_unique" UNIQUE("company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"active_company_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chart_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"subtype" text,
	"parent_id" uuid,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_accounts_company_number_unique" UNIQUE("company_id","number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"bank_connection_id" uuid,
	"name" text NOT NULL,
	"mask" text,
	"kind" "financial_account_kind" DEFAULT 'checking' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"current_balance_cents" bigint DEFAULT 0 NOT NULL,
	"available_balance_cents" bigint,
	"provider_account_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_accounts_provider_unique" UNIQUE("company_id","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_item_id" text NOT NULL,
	"institution_name" text NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_connections_provider_item_unique" UNIQUE("company_id","provider","provider_item_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"posted_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text NOT NULL,
	"merchant_name" text,
	"provider_category" text,
	"pending" boolean DEFAULT false NOT NULL,
	"review_state" "review_state" DEFAULT 'new' NOT NULL,
	"chart_account_id" uuid,
	"applied_rule_id" uuid,
	"is_split" boolean DEFAULT false NOT NULL,
	"is_transfer" boolean DEFAULT false NOT NULL,
	"transfer_pair_id" uuid,
	"exclude_reason" text,
	"notes" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_dedup_unique" UNIQUE("company_id","financial_account_id","provider_transaction_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"memo" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categorization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match_type" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"action" "rule_action" DEFAULT 'suggest' NOT NULL,
	"financial_account_id" uuid,
	"is_vendor_memory" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"is_undo" boolean DEFAULT false NOT NULL,
	"undone_by_event_id" uuid,
	"batch_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chart_accounts" ADD CONSTRAINT "chart_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chart_accounts" ADD CONSTRAINT "chart_accounts_parent_id_chart_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_transfer_pair_id_bank_transactions_id_fk" FOREIGN KEY ("transfer_pair_id") REFERENCES "public"."bank_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_financial_account_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_financial_account_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chart_accounts_company_type_idx" ON "chart_accounts" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financial_accounts_company_idx" ON "financial_accounts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_connections_company_idx" ON "bank_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_inbox_idx" ON "bank_transactions" USING btree ("company_id","review_state","posted_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_account_idx" ON "bank_transactions" USING btree ("financial_account_id","posted_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transaction_splits_transaction_idx" ON "transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categorization_rules_company_active_idx" ON "categorization_rules" USING btree ("company_id","is_active","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_company_idx" ON "audit_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_entity_idx" ON "audit_events" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_batch_idx" ON "audit_events" USING btree ("batch_id");