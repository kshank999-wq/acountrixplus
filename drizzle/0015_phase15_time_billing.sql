CREATE TYPE "public"."billable_expense_status" AS ENUM('unbilled', 'billed', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."time_entry_status" AS ENUM('draft', 'submitted', 'approved', 'billed', 'written_off');--> statement-breakpoint
CREATE TABLE "billable_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"customer_id" uuid,
	"incurred_on" date NOT NULL,
	"description" text NOT NULL,
	"cost_cents" bigint NOT NULL,
	"markup_basis_points" integer DEFAULT 0 NOT NULL,
	"billable_cents" bigint NOT NULL,
	"chart_account_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"status" "billable_expense_status" DEFAULT 'unbilled' NOT NULL,
	"invoice_id" uuid,
	"write_off_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billable_expenses_cost_positive" CHECK ("billable_expenses"."cost_cents" > 0),
	CONSTRAINT "billable_expenses_markup_sane" CHECK ("billable_expenses"."markup_basis_points" >= -10000),
	CONSTRAINT "billable_expenses_billed_has_invoice" CHECK ("billable_expenses"."status" <> 'billed' OR "billable_expenses"."invoice_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "person_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rate_cents" bigint NOT NULL,
	"cost_rate_cents" bigint,
	CONSTRAINT "person_rates_company_user_unique" UNIQUE("company_id","user_id"),
	CONSTRAINT "person_rates_non_negative" CHECK ("person_rates"."rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"rate_cents" bigint NOT NULL,
	CONSTRAINT "project_rates_project_person_unique" UNIQUE("project_id","user_id"),
	CONSTRAINT "project_rates_non_negative" CHECK ("project_rates"."rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retainer_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"retainer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"applied_on" date NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retainer_applications_amount_positive" CHECK ("retainer_applications"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "retainers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"project_id" uuid,
	"received_on" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"remaining_cents" bigint NOT NULL,
	"reference" text,
	"memo" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retainers_amount_positive" CHECK ("retainers"."amount_cents" > 0),
	CONSTRAINT "retainers_remaining_sane" CHECK ("retainers"."remaining_cents" >= 0 AND "retainers"."remaining_cents" <= "retainers"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"service_item_id" uuid,
	"worked_on" date NOT NULL,
	"minutes" integer NOT NULL,
	"description" text NOT NULL,
	"is_billable" boolean DEFAULT true NOT NULL,
	"rate_cents" bigint,
	"amount_cents" bigint,
	"status" time_entry_status DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"invoice_id" uuid,
	"write_off_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_minutes_positive" CHECK ("time_entries"."minutes" > 0),
	CONSTRAINT "time_entries_minutes_sane" CHECK ("time_entries"."minutes" <= 1440),
	CONSTRAINT "time_entries_billed_has_invoice" CHECK ("time_entries"."status" <> 'billed' OR "time_entries"."invoice_id" IS NOT NULL),
	CONSTRAINT "time_entries_write_off_reason" CHECK ("time_entries"."status" <> 'written_off' OR length(trim(coalesce("time_entries"."write_off_reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "billable_expenses" ADD CONSTRAINT "billable_expenses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_expenses" ADD CONSTRAINT "billable_expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_expenses" ADD CONSTRAINT "billable_expenses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_expenses" ADD CONSTRAINT "billable_expenses_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_expenses" ADD CONSTRAINT "billable_expenses_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_expenses" ADD CONSTRAINT "billable_expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_rates" ADD CONSTRAINT "person_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_rates" ADD CONSTRAINT "person_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rates" ADD CONSTRAINT "project_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rates" ADD CONSTRAINT "project_rates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_rates" ADD CONSTRAINT "project_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_retainer_id_retainers_id_fk" FOREIGN KEY ("retainer_id") REFERENCES "public"."retainers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainers" ADD CONSTRAINT "retainers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_service_item_id_service_items_id_fk" FOREIGN KEY ("service_item_id") REFERENCES "public"."service_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billable_expenses_unbilled_idx" ON "billable_expenses" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "billable_expenses_invoice_idx" ON "billable_expenses" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "project_rates_project_idx" ON "project_rates" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "retainer_applications_retainer_idx" ON "retainer_applications" USING btree ("retainer_id");--> statement-breakpoint
CREATE INDEX "retainer_applications_invoice_idx" ON "retainer_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "retainers_customer_idx" ON "retainers" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "time_entries_person_week_idx" ON "time_entries" USING btree ("company_id","user_id","worked_on");--> statement-breakpoint
CREATE INDEX "time_entries_unbilled_idx" ON "time_entries" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "time_entries_invoice_idx" ON "time_entries" USING btree ("invoice_id");