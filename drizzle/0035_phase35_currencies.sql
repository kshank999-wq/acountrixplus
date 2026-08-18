CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate_date" date NOT NULL,
	"rate_millionths" bigint NOT NULL,
	"source" text DEFAULT 'entered' NOT NULL,
	"entered_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_company_pair_date_key" UNIQUE("company_id","base_currency","quote_currency","rate_date")
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "exchange_rate_millionths" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "functional_total_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "functional_balance_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate_millionths" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "functional_total_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "functional_balance_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rates_lookup_idx" ON "exchange_rates" USING btree ("company_id","base_currency","quote_currency","rate_date");