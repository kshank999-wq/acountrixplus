CREATE TYPE "public"."credit_note_status" AS ENUM('draft', 'open', 'applied', 'void');--> statement-breakpoint
CREATE TYPE "public"."recurring_cadence" AS ENUM('weekly', 'monthly', 'quarterly', 'annually');--> statement-breakpoint
ALTER TYPE "public"."document_status" ADD VALUE 'written_off';--> statement-breakpoint
CREATE TABLE "credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"applied_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_applications_amount_positive" CHECK ("credit_applications"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity_milli" integer DEFAULT 1000 NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"issue_date" date NOT NULL,
	"invoice_id" uuid,
	"status" "credit_note_status" DEFAULT 'open' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"remaining_cents" bigint DEFAULT 0 NOT NULL,
	"reason" text,
	"memo" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "credit_notes_total_positive" CHECK ("credit_notes"."total_cents" > 0),
	CONSTRAINT "credit_notes_remaining_sane" CHECK ("credit_notes"."remaining_cents" >= 0 AND "credit_notes"."remaining_cents" <= "credit_notes"."total_cents")
);
--> statement-breakpoint
CREATE TABLE "customer_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text DEFAULT 'open_item' NOT NULL,
	"period_start" date,
	"as_of_date" date NOT NULL,
	"opening_balance_cents" bigint DEFAULT 0 NOT NULL,
	"closing_balance_cents" bigint DEFAULT 0 NOT NULL,
	"figures" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_write_offs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"written_off_on" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" uuid,
	"recovered_on" date,
	"recovered_cents" bigint,
	"recovery_journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_write_offs_invoice_unique" UNIQUE("invoice_id"),
	CONSTRAINT "invoice_write_offs_amount_positive" CHECK ("invoice_write_offs"."amount_cents" > 0),
	CONSTRAINT "invoice_write_offs_reason_not_blank" CHECK (length(trim("invoice_write_offs"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "fiscal_year_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"closing_date" date NOT NULL,
	"fiscal_year" integer NOT NULL,
	"net_income_cents" bigint NOT NULL,
	"revenue_cents" bigint NOT NULL,
	"expense_cents" bigint NOT NULL,
	"journal_entry_id" uuid,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_year_closes_year_unique" UNIQUE("company_id","fiscal_year")
);
--> statement-breakpoint
CREATE TABLE "recurring_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"memo" text,
	"cadence" "recurring_cadence" NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"auto_post" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"last_run_on" date,
	"next_run_on" date NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_entries_name_unique" UNIQUE("company_id","name"),
	CONSTRAINT "recurring_entries_day_range" CHECK ("recurring_entries"."day_of_month" >= 1 AND "recurring_entries"."day_of_month" <= 28),
	CONSTRAINT "recurring_entries_ends_after_start" CHECK ("recurring_entries"."ends_on" IS NULL OR "recurring_entries"."ends_on" >= "recurring_entries"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "recurring_entry_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recurring_entry_id" uuid NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"debit_cents" bigint DEFAULT 0 NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "recurring_entry_lines_one_sided" CHECK (("recurring_entry_lines"."debit_cents" = 0) <> ("recurring_entry_lines"."credit_cents" = 0)),
	CONSTRAINT "recurring_entry_lines_non_negative" CHECK ("recurring_entry_lines"."debit_cents" >= 0 AND "recurring_entry_lines"."credit_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recurring_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recurring_entry_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"occurred_on" date NOT NULL,
	"was_posted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_occurrences_unique" UNIQUE("recurring_entry_id","occurred_on")
);
--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_write_offs" ADD CONSTRAINT "invoice_write_offs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_write_offs" ADD CONSTRAINT "invoice_write_offs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_write_offs" ADD CONSTRAINT "invoice_write_offs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_write_offs" ADD CONSTRAINT "invoice_write_offs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_write_offs" ADD CONSTRAINT "invoice_write_offs_recovery_entry_fk" FOREIGN KEY ("recovery_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_closes" ADD CONSTRAINT "fiscal_year_closes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_closes" ADD CONSTRAINT "fiscal_year_closes_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_closes" ADD CONSTRAINT "fiscal_year_closes_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_entries" ADD CONSTRAINT "recurring_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_entries" ADD CONSTRAINT "recurring_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_entry_lines" ADD CONSTRAINT "recurring_entry_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_entry_lines" ADD CONSTRAINT "recurring_entry_lines_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_entry_lines" ADD CONSTRAINT "recurring_entry_lines_entry_fk" FOREIGN KEY ("recurring_entry_id") REFERENCES "public"."recurring_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_occurrences" ADD CONSTRAINT "recurring_occurrences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_occurrences" ADD CONSTRAINT "recurring_occurrences_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_occurrences" ADD CONSTRAINT "recurring_occurrences_entry_fk" FOREIGN KEY ("recurring_entry_id") REFERENCES "public"."recurring_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_applications_note_idx" ON "credit_applications" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX "credit_applications_invoice_idx" ON "credit_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "credit_note_lines_note_idx" ON "credit_note_lines" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX "credit_notes_customer_idx" ON "credit_notes" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "credit_notes_open_idx" ON "credit_notes" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "customer_statements_customer_idx" ON "customer_statements" USING btree ("company_id","customer_id","as_of_date");--> statement-breakpoint
CREATE INDEX "invoice_write_offs_company_idx" ON "invoice_write_offs" USING btree ("company_id","written_off_on");--> statement-breakpoint
CREATE INDEX "fiscal_year_closes_company_idx" ON "fiscal_year_closes" USING btree ("company_id","closing_date");--> statement-breakpoint
CREATE INDEX "recurring_entries_due_idx" ON "recurring_entries" USING btree ("company_id","is_active","next_run_on");--> statement-breakpoint
CREATE INDEX "recurring_entry_lines_entry_idx" ON "recurring_entry_lines" USING btree ("recurring_entry_id");--> statement-breakpoint
CREATE INDEX "recurring_occurrences_entry_idx" ON "recurring_occurrences" USING btree ("recurring_entry_id");