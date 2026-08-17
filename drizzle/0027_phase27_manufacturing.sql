CREATE TYPE "public"."work_order_entry_kind" AS ENUM('material', 'labour', 'overhead');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('draft', 'released', 'completed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_kind" ADD VALUE 'work_order_issue';--> statement-breakpoint
CREATE TABLE "bills_of_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"output_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"batch_milli" bigint NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boms_batch_positive" CHECK ("bills_of_materials"."batch_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "bom_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bom_id" uuid NOT NULL,
	"component_item_id" uuid NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"scrap_bp" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "bom_components_unique" UNIQUE("bom_id","component_item_id"),
	CONSTRAINT "bom_components_quantity_positive" CHECK ("bom_components"."quantity_milli" > 0),
	CONSTRAINT "bom_components_scrap_sane" CHECK ("bom_components"."scrap_bp" >= 0 AND "bom_components"."scrap_bp" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "work_order_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"kind" "work_order_entry_kind" NOT NULL,
	"item_id" uuid,
	"quantity_milli" bigint,
	"cost_cents" bigint NOT NULL,
	"occurred_on" date NOT NULL,
	"memo" text,
	"journal_entry_id" uuid,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_entries_cost_positive" CHECK ("work_order_entries"."cost_cents" > 0),
	CONSTRAINT "work_order_entries_material_has_item" CHECK (("work_order_entries"."kind" = 'material' AND "work_order_entries"."item_id" IS NOT NULL AND "work_order_entries"."quantity_milli" > 0)
          OR ("work_order_entries"."kind" <> 'material' AND "work_order_entries"."item_id" IS NULL AND "work_order_entries"."quantity_milli" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"output_item_id" uuid NOT NULL,
	"bom_id" uuid,
	"status" "work_order_status" DEFAULT 'draft' NOT NULL,
	"planned_milli" bigint NOT NULL,
	"produced_milli" bigint DEFAULT 0 NOT NULL,
	"scrapped_milli" bigint DEFAULT 0 NOT NULL,
	"wip_cents" bigint DEFAULT 0 NOT NULL,
	"material_cents" bigint DEFAULT 0 NOT NULL,
	"labour_cents" bigint DEFAULT 0 NOT NULL,
	"overhead_cents" bigint DEFAULT 0 NOT NULL,
	"started_on" date,
	"completed_on" date,
	"output_lot_id" uuid,
	"journal_entry_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_orders_company_number_unique" UNIQUE("company_id","number"),
	CONSTRAINT "work_orders_planned_positive" CHECK ("work_orders"."planned_milli" > 0),
	CONSTRAINT "work_orders_quantities_not_negative" CHECK ("work_orders"."produced_milli" >= 0 AND "work_orders"."scrapped_milli" >= 0 AND "work_orders"."wip_cents" >= 0),
	CONSTRAINT "work_orders_settled_holds_nothing" CHECK ("work_orders"."status" IN ('draft', 'released') OR "work_orders"."wip_cents" = 0)
);
--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD CONSTRAINT "bills_of_materials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD CONSTRAINT "bills_of_materials_output_item_id_service_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD CONSTRAINT "bills_of_materials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_bom_id_bills_of_materials_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_component_item_id_service_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_entries" ADD CONSTRAINT "work_order_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_entries" ADD CONSTRAINT "work_order_entries_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_entries" ADD CONSTRAINT "work_order_entries_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_entries" ADD CONSTRAINT "work_order_entries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_entries" ADD CONSTRAINT "work_order_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_output_item_id_service_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_bom_id_bills_of_materials_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_materials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boms_output_idx" ON "bills_of_materials" USING btree ("company_id","output_item_id","is_active");--> statement-breakpoint
CREATE INDEX "bom_components_bom_idx" ON "bom_components" USING btree ("company_id","bom_id");--> statement-breakpoint
CREATE INDEX "work_order_entries_order_idx" ON "work_order_entries" USING btree ("company_id","work_order_id","occurred_on");--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("company_id","status");