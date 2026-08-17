CREATE TYPE "public"."appointment_status" AS ENUM('booked', 'completed', 'no_show', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'appointment';--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"customer_id" uuid,
	"service_item_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'booked' NOT NULL,
	"price_cents" bigint DEFAULT 0 NOT NULL,
	"product_cents" bigint DEFAULT 0 NOT NULL,
	"commission_bp" integer DEFAULT 0 NOT NULL,
	"product_commission_bp" integer DEFAULT 0 NOT NULL,
	"practitioner_cents" bigint,
	"notes" text,
	"journal_entry_id" uuid,
	"completed_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_ends_after_start" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_prices_not_negative" CHECK ("appointments"."price_cents" >= 0 AND "appointments"."product_cents" >= 0),
	CONSTRAINT "appointments_completed_knows_its_split" CHECK ("appointments"."status" <> 'completed' OR ("appointments"."practitioner_cents" IS NOT NULL AND "appointments"."completed_on" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gift_card_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"appointment_id" uuid,
	"applied_cents" bigint NOT NULL,
	"redeemed_on" date NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_redemptions_appointment_unique" UNIQUE("appointment_id"),
	CONSTRAINT "gift_card_redemptions_applied_positive" CHECK ("gift_card_redemptions"."applied_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"purchaser_customer_id" uuid,
	"issued_cents" bigint NOT NULL,
	"balance_cents" bigint NOT NULL,
	"issued_on" date NOT NULL,
	"journal_entry_id" uuid,
	"deposit_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_company_code_unique" UNIQUE("company_id","code"),
	CONSTRAINT "gift_cards_balance_in_range" CHECK ("gift_cards"."balance_cents" >= 0 AND "gift_cards"."balance_cents" <= "gift_cards"."issued_cents")
);
--> statement-breakpoint
CREATE TABLE "practitioners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"user_id" uuid,
	"commission_bp" integer DEFAULT 0 NOT NULL,
	"product_commission_bp" integer DEFAULT 0 NOT NULL,
	"is_employee" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practitioners_company_name_unique" UNIQUE("company_id","name"),
	CONSTRAINT "practitioners_rates_sane" CHECK ("practitioners"."commission_bp" BETWEEN 0 AND 10000 AND "practitioners"."product_commission_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_practitioner_id_practitioners_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_item_id_service_items_id_fk" FOREIGN KEY ("service_item_id") REFERENCES "public"."service_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_purchaser_customer_id_customers_id_fk" FOREIGN KEY ("purchaser_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_deposit_account_id_chart_accounts_id_fk" FOREIGN KEY ("deposit_account_id") REFERENCES "public"."chart_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_diary_idx" ON "appointments" USING btree ("company_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_practitioner_idx" ON "appointments" USING btree ("practitioner_id","starts_at");--> statement-breakpoint
CREATE INDEX "gift_card_redemptions_card_idx" ON "gift_card_redemptions" USING btree ("company_id","gift_card_id");--> statement-breakpoint
CREATE INDEX "practitioners_company_name_idx" ON "practitioners" USING btree ("company_id","name");--> statement-breakpoint
-- Hand-written: drizzle-kit does not generate exclusion constraints.
--
-- A double-booking is not a duplicate row — two appointments at 10:00 and 10:30
-- collide on an *interval*, not on any column, so a unique key cannot express
-- it and only Postgres knows at the moment of insert. Without this, `book`
-- would have to read the practitioner's diary, decide there is room, and then
-- insert: correct exactly until the receptionist and the online form do it in
-- the same second.
--
-- btree_gist is what lets a plain uuid equality sit beside a range overlap in
-- the same GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_double_booking"
  EXCLUDE USING gist (
    "practitioner_id" WITH =,
    tstzrange("starts_at", "ends_at") WITH &&
  )
  -- Only bookings that still hold the slot. A cancelled appointment must stop
  -- reserving its hour, or calling off Tuesday blocks it for ever.
  WHERE ("status" IN ('booked', 'completed'));
