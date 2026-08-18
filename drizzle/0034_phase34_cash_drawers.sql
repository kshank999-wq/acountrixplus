CREATE TYPE "public"."drawer_shift_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "cash_drawers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_float_cents" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_drawers_company_name_key" UNIQUE("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "drawer_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"chart_account_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawer_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"drawer_id" uuid NOT NULL,
	"status" "drawer_shift_status" DEFAULT 'open' NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"float_cents" bigint DEFAULT 0 NOT NULL,
	"closed_by_user_id" uuid,
	"closed_at" timestamp with time zone,
	"counted_cents" bigint,
	"expected_cents" bigint,
	"over_short_cents" bigint,
	"float_retained_cents" bigint,
	"opening_entry_id" uuid,
	"closing_entry_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "drawer_shift_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_drawers" ADD CONSTRAINT "cash_drawers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_payouts" ADD CONSTRAINT "drawer_payouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_payouts" ADD CONSTRAINT "drawer_payouts_shift_id_drawer_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."drawer_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_payouts" ADD CONSTRAINT "drawer_payouts_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_payouts" ADD CONSTRAINT "drawer_payouts_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_shifts" ADD CONSTRAINT "drawer_shifts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_shifts" ADD CONSTRAINT "drawer_shifts_drawer_id_cash_drawers_id_fk" FOREIGN KEY ("drawer_id") REFERENCES "public"."cash_drawers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_shifts" ADD CONSTRAINT "drawer_shifts_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_shifts" ADD CONSTRAINT "drawer_shifts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_shifts" ADD CONSTRAINT "drawer_shifts_opening_entry_id_journal_entries_id_fk" FOREIGN KEY ("opening_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawer_shifts" ADD CONSTRAINT "drawer_shifts_closing_entry_id_journal_entries_id_fk" FOREIGN KEY ("closing_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drawer_payouts_shift_idx" ON "drawer_payouts" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "drawer_shifts_company_opened_idx" ON "drawer_shifts" USING btree ("company_id","opened_at");--> statement-breakpoint
CREATE INDEX "drawer_shifts_drawer_idx" ON "drawer_shifts" USING btree ("drawer_id","status");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_drawer_shift_id_drawer_shifts_id_fk" FOREIGN KEY ("drawer_shift_id") REFERENCES "public"."drawer_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_drawer_shift_idx" ON "payments" USING btree ("drawer_shift_id");--> statement-breakpoint
-- One open shift per drawer, enforced by the database (Phase 34).
--
-- Hand-written because drizzle-kit cannot express a partial unique index, and
-- a partial one is the point: a drawer may have any number of *closed* shifts
-- and at most one open.
--
-- In the service rather than the database it would be a read-then-write, which
-- loses the race by construction — and this is exactly Phase 29's situation,
-- two people acting at the same moment. Two staff opening one till at 9am would
-- each get a share of the same cash and neither an account of it.
CREATE UNIQUE INDEX "drawer_shifts_one_open_per_drawer"
  ON "drawer_shifts" ("drawer_id")
  WHERE ("status" = 'open');
