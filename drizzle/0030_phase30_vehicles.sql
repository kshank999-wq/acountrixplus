CREATE TYPE "public"."authorisation_channel" AS ENUM('in_person', 'phone', 'email', 'sms', 'online');--> statement-breakpoint
CREATE TYPE "public"."repair_line_kind" AS ENUM('labour', 'part', 'sublet');--> statement-breakpoint
CREATE TYPE "public"."repair_order_status" AS ENUM('estimate', 'authorised', 'completed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'repair';--> statement-breakpoint
CREATE TABLE "repair_order_authorisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repair_order_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"channel" "authorisation_channel" DEFAULT 'phone' NOT NULL,
	"approved_by" text,
	"taken_by" uuid,
	"notes" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_order_authorisations_not_zero" CHECK ("repair_order_authorisations"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "repair_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"repair_order_id" uuid NOT NULL,
	"kind" "repair_line_kind" NOT NULL,
	"description" text NOT NULL,
	"item_id" uuid,
	"quantity_milli" bigint DEFAULT 1000 NOT NULL,
	"unit_price_cents" bigint DEFAULT 0 NOT NULL,
	"sublet_cost_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_order_lines_quantity_positive" CHECK ("repair_order_lines"."quantity_milli" > 0),
	CONSTRAINT "repair_order_lines_prices_not_negative" CHECK ("repair_order_lines"."unit_price_cents" >= 0 AND "repair_order_lines"."sublet_cost_cents" >= 0),
	CONSTRAINT "repair_order_lines_kind_matches_fields" CHECK (("repair_order_lines"."kind" = 'part' OR "repair_order_lines"."item_id" IS NULL) AND ("repair_order_lines"."kind" = 'sublet' OR "repair_order_lines"."sublet_cost_cents" = 0))
);
--> statement-breakpoint
CREATE TABLE "repair_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "repair_order_status" DEFAULT 'estimate' NOT NULL,
	"complaint" text,
	"authorised_cents" bigint DEFAULT 0 NOT NULL,
	"tolerance_bp" integer DEFAULT 0 NOT NULL,
	"odometer_in" integer,
	"odometer_out" integer,
	"opened_on" date NOT NULL,
	"completed_on" date,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_orders_company_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "repair_orders_tolerance_sane" CHECK ("repair_orders"."tolerance_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "repair_orders_authorised_not_negative" CHECK ("repair_orders"."authorised_cents" >= 0),
	CONSTRAINT "repair_orders_completed_knows_when" CHECK ("repair_orders"."status" <> 'completed' OR "repair_orders"."completed_on" IS NOT NULL),
	CONSTRAINT "repair_orders_authorised_has_an_amount" CHECK ("repair_orders"."status" = 'estimate' OR "repair_orders"."status" = 'cancelled' OR "repair_orders"."authorised_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"vin" text,
	"registration" text,
	"make" text,
	"model" text,
	"year" integer,
	"colour" text,
	"odometer_miles" integer,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_company_vin_unique" UNIQUE("company_id","vin"),
	CONSTRAINT "vehicles_year_sane" CHECK ("vehicles"."year" IS NULL OR "vehicles"."year" BETWEEN 1885 AND 2200),
	CONSTRAINT "vehicles_odometer_not_negative" CHECK ("vehicles"."odometer_miles" IS NULL OR "vehicles"."odometer_miles" >= 0)
);
--> statement-breakpoint
ALTER TABLE "repair_order_authorisations" ADD CONSTRAINT "repair_order_authorisations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_order_authorisations" ADD CONSTRAINT "repair_order_authorisations_repair_order_id_repair_orders_id_fk" FOREIGN KEY ("repair_order_id") REFERENCES "public"."repair_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_order_authorisations" ADD CONSTRAINT "repair_order_authorisations_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_order_lines" ADD CONSTRAINT "repair_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_order_lines" ADD CONSTRAINT "repair_order_lines_repair_order_id_repair_orders_id_fk" FOREIGN KEY ("repair_order_id") REFERENCES "public"."repair_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_order_lines" ADD CONSTRAINT "repair_order_lines_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repair_order_authorisations_order_idx" ON "repair_order_authorisations" USING btree ("company_id","repair_order_id");--> statement-breakpoint
CREATE INDEX "repair_order_lines_order_idx" ON "repair_order_lines" USING btree ("company_id","repair_order_id");--> statement-breakpoint
CREATE INDEX "repair_orders_vehicle_idx" ON "repair_orders" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "repair_orders_status_idx" ON "repair_orders" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "vehicles_company_idx" ON "vehicles" USING btree ("company_id","registration");--> statement-breakpoint
CREATE INDEX "vehicles_customer_idx" ON "vehicles" USING btree ("company_id","customer_id");