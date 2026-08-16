CREATE TYPE "public"."import_kind" AS ENUM('chart_of_accounts', 'customers', 'vendors', 'trial_balance', 'open_invoices', 'open_bills');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('committed', 'reverted');--> statement-breakpoint
CREATE TABLE "import_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"import_run_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source_row" integer
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "import_kind" NOT NULL,
	"status" "import_status" DEFAULT 'committed' NOT NULL,
	"file_name" text,
	"headers" text,
	"column_mapping" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"total_cents" bigint,
	"journal_entry_id" uuid,
	"receivable_control_cents" bigint,
	"payable_control_cents" bigint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reverted_at" timestamp with time zone,
	"reverted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_records_run_idx" ON "import_records" USING btree ("import_run_id");--> statement-breakpoint
CREATE INDEX "import_records_entity_idx" ON "import_records" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "import_runs_company_idx" ON "import_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "import_runs_kind_idx" ON "import_runs" USING btree ("company_id","kind","status");