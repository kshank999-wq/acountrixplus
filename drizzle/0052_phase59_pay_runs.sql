-- Phase 59: the pay run that half-happened.
--
-- Phase 49 pays one supplier at a time, in a plain loop with no transaction
-- around it. Its own doc comment promised "the message says how far it got" —
-- and the `catch` threw away the list of who had already been paid and returned
-- "That pay run could not be completed." A business paying eight bills across
-- four suppliers, where the third failed, was told the run failed while real
-- money had left its bank for the first two.
--
-- No transaction is still right: rolling back would undo payments the business
-- may already have sent from its bank. What was missing is the *record* that
-- the loop happened at all.

-- Grouping payments by (payment_date, reference) after the fact would be a
-- guess: two runs on the same day with no reference are indistinguishable, and
-- a run that paid NOBODY has no payments to group. That last case is the one
-- most worth keeping — "somebody tried to send $40,000 on Friday and none of it
-- went" is exactly the fact a business needs, and a row of its own is the only
-- place it can live.
CREATE TABLE IF NOT EXISTS "pay_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,

  "run_date" date NOT NULL,
  "reference" text,
  -- Not null: a run always names the account the money leaves. Unlike a
  -- receipt, which may be undeposited (Phase 12), there is no such thing as
  -- paying a supplier out of an account nobody has chosen.
  "financial_account_id" uuid NOT NULL,

  -- The BatchStatus of src/modules/payables/batch.ts. 'partial' is its own
  -- value rather than folded into either neighbour, because it is the only one
  -- that needs a person to do something.
  "status" text NOT NULL,

  "suppliers_attempted" integer NOT NULL DEFAULT 0,
  "suppliers_paid" integer NOT NULL DEFAULT 0,
  "bills_settled" integer NOT NULL DEFAULT 0,
  "paid_cents" bigint NOT NULL DEFAULT 0,
  -- What the suppliers that failed were owed, and still are.
  "unpaid_cents" bigint NOT NULL DEFAULT 0,

  -- Kept verbatim rather than re-derived: the sentence a person reads a week
  -- later has to be the one the domain wrote at the time, and re-deriving it
  -- would mean re-running the failure.
  "failures" text,

  -- Phase 58 gave one payment a remittance advice. This is the whole run's.
  "advised_at" timestamptz,
  "advise_count" integer NOT NULL DEFAULT 0,

  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "pay_runs_status_check"
    CHECK ("status" IN ('complete', 'partial', 'nothing')),
  CONSTRAINT "pay_runs_counts_check"
    CHECK ("suppliers_paid" >= 0 AND "suppliers_paid" <= "suppliers_attempted")
);

CREATE INDEX IF NOT EXISTS "pay_runs_company_date_idx"
  ON "pay_runs" ("company_id", "run_date" DESC);

-- Null for every payment made one at a time, which is most of them, and for all
-- 58 phases of payments made before runs were recorded. No backfill: inventing
-- runs for historic payments would put a claim in the books that nobody made.
-- ON DELETE SET NULL, because the payment is a real disbursement whatever
-- happened to the record of the batch it went out in.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "pay_run_id" uuid
  REFERENCES "pay_runs"("id") ON DELETE SET NULL;

-- How a run reads back the payments it made, to advise them together.
CREATE INDEX IF NOT EXISTS "payments_pay_run_idx"
  ON "payments" ("pay_run_id")
  WHERE "pay_run_id" IS NOT NULL;
