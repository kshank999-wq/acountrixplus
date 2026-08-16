CREATE TYPE "public"."dimension_requirement" AS ENUM('optional', 'expected');--> statement-breakpoint
CREATE TYPE "public"."depreciation_convention" AS ENUM('full_month', 'mid_month', 'half_year');--> statement-breakpoint
CREATE TYPE "public"."depreciation_method" AS ENUM('straight_line', 'declining_balance', 'declining_balance_switch');--> statement-breakpoint
CREATE TYPE "public"."fixed_asset_status" AS ENUM('active', 'fully_depreciated', 'disposed');--> statement-breakpoint
CREATE TABLE "dimension_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"dimension_value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "dimension_defaults_unique" UNIQUE("owner_type","owner_id","dimension_id")
);
--> statement-breakpoint
CREATE TABLE "dimension_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dimension_values_code_unique" UNIQUE("dimension_id","code"),
	CONSTRAINT "dimension_values_no_self_parent" CHECK ("dimension_values"."parent_id" <> "dimension_values"."id")
);
--> statement-breakpoint
CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"requirement" "dimension_requirement" DEFAULT 'optional' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dimensions_code_unique" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE "journal_line_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"dimension_value_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_line_dimensions_unique" UNIQUE("journal_line_id","dimension_id")
);
--> statement-breakpoint
CREATE TABLE "depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"accumulated_cents" bigint NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "depreciation_entries_period_unique" UNIQUE("fixed_asset_id","period_end"),
	CONSTRAINT "depreciation_entries_amount_positive" CHECK ("depreciation_entries"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"serial_number" text,
	"location" text,
	"cost_cents" bigint NOT NULL,
	"salvage_value_cents" bigint DEFAULT 0 NOT NULL,
	"life_months" integer NOT NULL,
	"method" "depreciation_method" DEFAULT 'straight_line' NOT NULL,
	"convention" "depreciation_convention" DEFAULT 'full_month' NOT NULL,
	"declining_factor_bp" integer DEFAULT 20000 NOT NULL,
	"acquired_date" date NOT NULL,
	"in_service_date" date NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"accumulated_account_id" uuid NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"vendor_id" uuid,
	"project_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"status" "fixed_asset_status" DEFAULT 'active' NOT NULL,
	"disposed_on" date,
	"disposal_proceeds_cents" bigint,
	"disposal_reason" text,
	"disposal_journal_entry_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_tag_unique" UNIQUE("company_id","tag"),
	CONSTRAINT "fixed_assets_salvage_below_cost" CHECK ("fixed_assets"."salvage_value_cents" >= 0 AND "fixed_assets"."salvage_value_cents" <= "fixed_assets"."cost_cents"),
	CONSTRAINT "fixed_assets_cost_positive" CHECK ("fixed_assets"."cost_cents" > 0),
	CONSTRAINT "fixed_assets_life_positive" CHECK ("fixed_assets"."life_months" >= 1),
	CONSTRAINT "fixed_assets_in_service_after_acquired" CHECK ("fixed_assets"."in_service_date" >= "fixed_assets"."acquired_date"),
	CONSTRAINT "fixed_assets_disposal_complete" CHECK (("fixed_assets"."status" = 'disposed') = ("fixed_assets"."disposed_on" IS NOT NULL)
          AND ("fixed_assets"."disposed_on" IS NULL) = ("fixed_assets"."disposal_proceeds_cents" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "dimension_defaults" ADD CONSTRAINT "dimension_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_defaults" ADD CONSTRAINT "dimension_defaults_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_defaults" ADD CONSTRAINT "dimension_defaults_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_defaults" ADD CONSTRAINT "dimension_defaults_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_parent_id_dimension_values_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dimension_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_value_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_fixed_asset_id_fixed_assets_id_fk" FOREIGN KEY ("fixed_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_chart_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_account_id_chart_accounts_id_fk" FOREIGN KEY ("accumulated_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_expense_account_id_chart_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_entry_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dimension_defaults_lookup_idx" ON "dimension_defaults" USING btree ("company_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "dimension_values_dimension_idx" ON "dimension_values" USING btree ("company_id","dimension_id","is_active","sort_order");--> statement-breakpoint
CREATE INDEX "dimensions_company_idx" ON "dimensions" USING btree ("company_id","is_active","sort_order");--> statement-breakpoint
CREATE INDEX "journal_line_dimensions_line_idx" ON "journal_line_dimensions" USING btree ("journal_line_id");--> statement-breakpoint
CREATE INDEX "journal_line_dimensions_value_idx" ON "journal_line_dimensions" USING btree ("company_id","dimension_value_id");--> statement-breakpoint
CREATE INDEX "journal_line_dimensions_dim_idx" ON "journal_line_dimensions" USING btree ("company_id","dimension_id");--> statement-breakpoint
CREATE INDEX "depreciation_entries_asset_idx" ON "depreciation_entries" USING btree ("fixed_asset_id","period_end");--> statement-breakpoint
CREATE INDEX "depreciation_entries_company_idx" ON "depreciation_entries" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE INDEX "fixed_assets_company_idx" ON "fixed_assets" USING btree ("company_id","status","in_service_date");--> statement-breakpoint
CREATE INDEX "fixed_assets_category_idx" ON "fixed_assets" USING btree ("company_id","category");