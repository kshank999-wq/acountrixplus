-- Phase 44: taking money by card, and the days it spends in transit.

CREATE TYPE "checkout_status" AS ENUM('pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payment_settings" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT false NOT NULL,
  "provider" text DEFAULT 'mock' NOT NULL,
  "fee_percent_bp" integer DEFAULT 290 NOT NULL,
  "fee_fixed_cents" bigint DEFAULT 30 NOT NULL,
  "payout_financial_account_id" uuid REFERENCES "financial_accounts"("id") ON DELETE set null,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "checkouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "invoice_id" uuid NOT NULL REFERENCES "invoices"("id") ON DELETE cascade,
  "provider_checkout_id" text NOT NULL,
  "provider_payment_id" text,
  "provider" text NOT NULL,
  "status" "checkout_status" DEFAULT 'pending' NOT NULL,
  "gross_cents" bigint NOT NULL,
  "fee_cents" bigint DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "payment_id" uuid REFERENCES "payments"("id") ON DELETE set null,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  CONSTRAINT "checkouts_provider_checkout_unique" UNIQUE("provider_checkout_id"),
  -- What stops a double-clicked Pay button settling an invoice twice. The
  -- database decides, not the code.
  CONSTRAINT "checkouts_payment_unique" UNIQUE("payment_id"),
  CONSTRAINT "checkouts_gross_positive" CHECK ("gross_cents" > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "checkouts_invoice_idx" ON "checkouts" ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkouts_company_status_idx" ON "checkouts" ("company_id", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "provider_payout_id" text NOT NULL,
  "provider" text NOT NULL,
  "arrival_date" date NOT NULL,
  "amount_cents" bigint NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "expected_cents" bigint DEFAULT 0 NOT NULL,
  "difference_cents" bigint DEFAULT 0 NOT NULL,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payouts_provider_payout_unique" UNIQUE("company_id", "provider_payout_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payouts_company_date_idx" ON "payouts" ("company_id", "arrival_date");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "payout_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "payout_id" uuid NOT NULL REFERENCES "payouts"("id") ON DELETE cascade,
  "checkout_id" uuid NOT NULL REFERENCES "checkouts"("id") ON DELETE cascade,
  "gross_cents" bigint NOT NULL,
  "fee_cents" bigint NOT NULL,
  -- Paying the same money out twice would silently double the bank balance.
  CONSTRAINT "payout_items_checkout_unique" UNIQUE("checkout_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payout_items_payout_idx" ON "payout_items" ("payout_id");--> statement-breakpoint

-- Every company gets 1250 Payments in Transit.
--
-- The application looks this account up by number, so a company without it
-- cannot take a card payment at all. Added here rather than left to the chart
-- seed because existing companies have already been seeded and would never
-- get it.
--
-- Creating an account posts nothing and changes no balance: a new account with
-- no journal lines is worth zero, so this is safe on live books. Skipped for
-- any company that already has something at 1250 — that number is theirs.
INSERT INTO "chart_accounts" ("company_id", "number", "name", "type", "subtype", "description", "is_system")
SELECT
  c."id",
  '1250',
  'Payments in Transit',
  'asset',
  'other_current_asset',
  'Card payments the processor has taken and not yet deposited. Cleared by the payout.',
  true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_accounts" a
  WHERE a."company_id" = c."id" AND a."number" = '1250'
);
