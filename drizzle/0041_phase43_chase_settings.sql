-- Phase 43: how a company wants its overdue invoices chased.
--
-- One row per company, and no rows are created here. Absence means off, and a
-- backfill that inserted a row per company would be a migration that decides,
-- on everybody's behalf, that their customers should start receiving email.
-- The defaults on the columns describe what a company gets *when somebody
-- turns it on*, not what happens tonight.

CREATE TABLE IF NOT EXISTS "chase_settings" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT false NOT NULL,
  "first_after_days" integer DEFAULT 3 NOT NULL,
  "every_days" integer DEFAULT 14 NOT NULL,
  "max_chases" integer DEFAULT 3 NOT NULL,
  "minimum_balance_cents" bigint DEFAULT 500 NOT NULL,
  "quiet_days_after_payment" integer DEFAULT 5 NOT NULL,
  "max_per_run" integer DEFAULT 50 NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
