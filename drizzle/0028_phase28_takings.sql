CREATE TYPE "public"."pos_source" AS ENUM('register', 'marketplace', 'processor', 'manual');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'takings';--> statement-breakpoint
CREATE TABLE "pos_day_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pos_day_id" uuid NOT NULL,
	"name" text NOT NULL,
	"account_number" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "pos_day_categories_unique" UNIQUE("pos_day_id","name")
);
--> statement-breakpoint
CREATE TABLE "pos_day_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pos_day_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "pos_day_tenders_unique" UNIQUE("pos_day_id","name"),
	CONSTRAINT "pos_day_tenders_fee_not_negative" CHECK ("pos_day_tenders"."fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source" "pos_source" DEFAULT 'register' NOT NULL,
	"label" text,
	"gross_sales_cents" bigint NOT NULL,
	"net_sales_cents" bigint NOT NULL,
	"discounts_cents" bigint DEFAULT 0 NOT NULL,
	"refunds_cents" bigint DEFAULT 0 NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"tips_cents" bigint DEFAULT 0 NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"takings_cents" bigint DEFAULT 0 NOT NULL,
	"over_short_cents" bigint,
	"out_of_balance_cents" bigint DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"notes" text,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_days_company_date_source_unique" UNIQUE("company_id","business_date","source"),
	CONSTRAINT "pos_days_sales_not_negative" CHECK ("pos_days"."gross_sales_cents" >= 0 AND "pos_days"."discounts_cents" >= 0 AND "pos_days"."refunds_cents" >= 0
          AND "pos_days"."tax_cents" >= 0 AND "pos_days"."tips_cents" >= 0 AND "pos_days"."fee_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pos_day_categories" ADD CONSTRAINT "pos_day_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_day_categories" ADD CONSTRAINT "pos_day_categories_pos_day_id_pos_days_id_fk" FOREIGN KEY ("pos_day_id") REFERENCES "public"."pos_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_day_tenders" ADD CONSTRAINT "pos_day_tenders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_day_tenders" ADD CONSTRAINT "pos_day_tenders_pos_day_id_pos_days_id_fk" FOREIGN KEY ("pos_day_id") REFERENCES "public"."pos_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_days" ADD CONSTRAINT "pos_days_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_days" ADD CONSTRAINT "pos_days_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_days" ADD CONSTRAINT "pos_days_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_day_categories_day_idx" ON "pos_day_categories" USING btree ("company_id","pos_day_id");--> statement-breakpoint
CREATE INDEX "pos_day_tenders_day_idx" ON "pos_day_tenders" USING btree ("company_id","pos_day_id");--> statement-breakpoint
CREATE INDEX "pos_days_date_idx" ON "pos_days" USING btree ("company_id","business_date");