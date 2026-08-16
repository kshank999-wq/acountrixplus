CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'open', 'partial', 'received', 'closed', 'void');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('receipt', 'sale', 'sale_return', 'adjustment', 'purchase_return');--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"purchase_order_line_id" uuid,
	"quantity_milli" bigint NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"lot_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "goods_receipt_lines_quantity" CHECK ("goods_receipt_lines"."quantity_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"received_on" date NOT NULL,
	"reference" text,
	"memo" text,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"bill_id" uuid,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_number_unique" UNIQUE("company_id","number")
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"received_milli" bigint NOT NULL,
	"remaining_milli" bigint NOT NULL,
	"remaining_value_cents" bigint NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"received_on" date NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_lots_quantity_sane" CHECK ("inventory_lots"."received_milli" > 0 AND "inventory_lots"."remaining_milli" >= 0 AND "inventory_lots"."remaining_milli" <= "inventory_lots"."received_milli"),
	CONSTRAINT "inventory_lots_value_tracks_quantity" CHECK (("inventory_lots"."remaining_milli" = 0) = ("inventory_lots"."remaining_value_cents" = 0)),
	CONSTRAINT "inventory_lots_cost_non_negative" CHECK ("inventory_lots"."unit_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_costings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"cost_cents" bigint NOT NULL,
	"lot_breakdown" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"received_milli" bigint DEFAULT 0 NOT NULL,
	"unit_cost_cents" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "purchase_order_lines_quantity" CHECK ("purchase_order_lines"."quantity_milli" > 0),
	CONSTRAINT "purchase_order_lines_received" CHECK ("purchase_order_lines"."received_milli" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"number" text NOT NULL,
	"ordered_on" date NOT NULL,
	"expected_on" date,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"memo" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("company_id","number")
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"adjusted_on" date NOT NULL,
	"expected_milli" bigint NOT NULL,
	"counted_milli" bigint NOT NULL,
	"value_change_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_reason" CHECK (length(trim("stock_adjustments"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"moved_on" date NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"cost_cents" bigint NOT NULL,
	"lot_breakdown" text,
	"reason" text,
	"memo" text,
	"source_type" text,
	"source_id" uuid,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_quantity_non_zero" CHECK ("stock_movements"."quantity_milli" <> 0)
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "inventory_cost_method" text DEFAULT 'weighted_average' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "is_inventoried" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "inventory_account_id" uuid;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "cogs_account_id" uuid;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "reorder_point_milli" bigint;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_po_line_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_costings" ADD CONSTRAINT "invoice_costings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_costings" ADD CONSTRAINT "invoice_costings_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_costings" ADD CONSTRAINT "invoice_costings_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_service_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."service_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_receipt_idx" ON "goods_receipt_lines" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_company_idx" ON "goods_receipts" USING btree ("company_id","received_on");--> statement-breakpoint
CREATE INDEX "goods_receipts_unbilled_idx" ON "goods_receipts" USING btree ("company_id","bill_id");--> statement-breakpoint
CREATE INDEX "inventory_lots_open_idx" ON "inventory_lots" USING btree ("company_id","item_id","received_on");--> statement-breakpoint
CREATE INDEX "invoice_costings_invoice_idx" ON "invoice_costings" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_order_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("company_id","vendor_id","status");--> statement-breakpoint
CREATE INDEX "stock_adjustments_item_idx" ON "stock_adjustments" USING btree ("company_id","item_id","adjusted_on");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("company_id","item_id","moved_on");--> statement-breakpoint
CREATE INDEX "stock_movements_source_idx" ON "stock_movements" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_inventory_account_id_chart_accounts_id_fk" FOREIGN KEY ("inventory_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_cogs_account_id_chart_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;