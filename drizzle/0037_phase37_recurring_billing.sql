CREATE TABLE "recurring_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recurring_invoice_id" uuid NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity_milli" bigint DEFAULT 1000 NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoice_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"recurring_invoice_id" uuid NOT NULL,
	"invoice_id" uuid,
	"occurred_on" date NOT NULL,
	"was_raised" boolean NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_invoice_occurrences_unique" UNIQUE("recurring_invoice_id","occurred_on")
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"memo" text,
	"cadence" "recurring_cadence" NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"auto_raise" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"last_run_on" date,
	"next_run_on" date NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_invoices_name_unique" UNIQUE("company_id","name"),
	CONSTRAINT "recurring_invoices_day_range" CHECK ("recurring_invoices"."day_of_month" >= 1 AND "recurring_invoices"."day_of_month" <= 28),
	CONSTRAINT "recurring_invoices_ends_after_start" CHECK ("recurring_invoices"."ends_on" IS NULL OR "recurring_invoices"."ends_on" >= "recurring_invoices"."starts_on"),
	CONSTRAINT "recurring_invoices_terms" CHECK ("recurring_invoices"."payment_terms_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_chart_account_id_chart_accounts_id_fk" FOREIGN KEY ("chart_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_schedule_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_occurrences" ADD CONSTRAINT "recurring_invoice_occurrences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_occurrences" ADD CONSTRAINT "recurring_invoice_occurrences_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_occurrences" ADD CONSTRAINT "recurring_invoice_occurrences_schedule_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_invoice_lines_schedule_idx" ON "recurring_invoice_lines" USING btree ("recurring_invoice_id");--> statement-breakpoint
CREATE INDEX "recurring_invoice_occurrences_schedule_idx" ON "recurring_invoice_occurrences" USING btree ("recurring_invoice_id");--> statement-breakpoint
CREATE INDEX "recurring_invoices_due_idx" ON "recurring_invoices" USING btree ("company_id","is_active","next_run_on");