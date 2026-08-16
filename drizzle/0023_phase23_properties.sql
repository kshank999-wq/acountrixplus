CREATE TYPE "public"."deposit_movement_kind" AS ENUM('received', 'refunded', 'applied');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('pending', 'active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('available', 'occupied', 'unavailable');--> statement-breakpoint
CREATE TABLE "deposit_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"kind" "deposit_movement_kind" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"occurred_on" date NOT NULL,
	"journal_entry_id" uuid,
	"invoice_id" uuid,
	"memo" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_movements_amount_positive" CHECK ("deposit_movements"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "lease_status" DEFAULT 'pending' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"rent_cents" bigint NOT NULL,
	"due_day" integer DEFAULT 1 NOT NULL,
	"deposit_required_cents" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_on" date,
	"ended_reason" text,
	CONSTRAINT "leases_rent_positive" CHECK ("leases"."rent_cents" > 0),
	CONSTRAINT "leases_deposit_not_negative" CHECK ("leases"."deposit_required_cents" >= 0),
	CONSTRAINT "leases_due_day_in_range" CHECK ("leases"."due_day" BETWEEN 1 AND 28),
	CONSTRAINT "leases_term_ordered" CHECK ("leases"."ends_on" IS NULL OR "leases"."ends_on" >= "leases"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"acquired_on" date,
	"dimension_value_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_company_code_unique" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE "property_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"status" "unit_status" DEFAULT 'available' NOT NULL,
	"market_rent_cents" bigint DEFAULT 0 NOT NULL,
	"area_units" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_units_code_unique" UNIQUE("property_id","code"),
	CONSTRAINT "property_units_market_rent_not_negative" CHECK ("property_units"."market_rent_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rent_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"prorated_days" integer,
	"period_days" integer,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rent_charges_lease_period_unique" UNIQUE("lease_id","period_start"),
	CONSTRAINT "rent_charges_amount_positive" CHECK ("rent_charges"."amount_cents" > 0),
	CONSTRAINT "rent_charges_period_ordered" CHECK ("rent_charges"."period_end" >= "rent_charges"."period_start")
);
--> statement-breakpoint
ALTER TABLE "deposit_movements" ADD CONSTRAINT "deposit_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_movements" ADD CONSTRAINT "deposit_movements_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_movements" ADD CONSTRAINT "deposit_movements_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_movements" ADD CONSTRAINT "deposit_movements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_movements" ADD CONSTRAINT "deposit_movements_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_unit_id_property_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."property_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_units" ADD CONSTRAINT "property_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_units" ADD CONSTRAINT "property_units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_movements_lease_idx" ON "deposit_movements" USING btree ("company_id","lease_id","occurred_on");--> statement-breakpoint
CREATE INDEX "leases_unit_idx" ON "leases" USING btree ("company_id","unit_id","status");--> statement-breakpoint
CREATE INDEX "leases_customer_idx" ON "leases" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "properties_company_idx" ON "properties" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "property_units_property_idx" ON "property_units" USING btree ("company_id","property_id","status");--> statement-breakpoint
CREATE INDEX "rent_charges_company_idx" ON "rent_charges" USING btree ("company_id","period_start");