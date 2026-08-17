CREATE TYPE "public"."contribution_kind" AS ENUM('gift', 'pledge');--> statement-breakpoint
CREATE TYPE "public"."fund_restriction" AS ENUM('unrestricted', 'restricted', 'perpetual');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'contribution';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'release';--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	"donor_id" uuid,
	"kind" "contribution_kind" DEFAULT 'gift' NOT NULL,
	"received_on" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"received_cents" bigint DEFAULT 0 NOT NULL,
	"reference" text,
	"memo" text,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contributions_amount_positive" CHECK ("contributions"."amount_cents" > 0),
	CONSTRAINT "contributions_received_within_amount" CHECK ("contributions"."received_cents" >= 0 AND "contributions"."received_cents" <= "contributions"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "fund_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"spent_cents" bigint NOT NULL,
	"released_cents" bigint NOT NULL,
	"shortfall_cents" bigint DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"released_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fund_releases_fund_period_unique" UNIQUE("fund_id","period_start"),
	CONSTRAINT "fund_releases_amounts_not_negative" CHECK ("fund_releases"."spent_cents" >= 0 AND "fund_releases"."released_cents" >= 0 AND "fund_releases"."shortfall_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"restriction" "fund_restriction" DEFAULT 'restricted' NOT NULL,
	"purpose" text,
	"expires_on" date,
	"dimension_value_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funds_company_code_unique" UNIQUE("company_id","code")
);
--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_donor_id_customers_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_releases" ADD CONSTRAINT "fund_releases_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contributions_fund_idx" ON "contributions" USING btree ("company_id","fund_id","received_on");--> statement-breakpoint
CREATE INDEX "contributions_donor_idx" ON "contributions" USING btree ("company_id","donor_id");--> statement-breakpoint
CREATE INDEX "fund_releases_company_idx" ON "fund_releases" USING btree ("company_id","period_start");--> statement-breakpoint
CREATE INDEX "funds_company_idx" ON "funds" USING btree ("company_id","is_active");