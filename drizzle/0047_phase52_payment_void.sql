-- Phase 52: a payment you can take back.
--
-- There was no way to void a payment at all — not a server action with no
-- caller, not a service function nobody wired up. Nothing. A receipt keyed as
-- $1,500 instead of $150, or a pay run aimed at the wrong supplier, was
-- permanent: the document showed settled, the bank showed the money gone, and
-- the only move left was a hand-posted journal entry that fixes the ledger and
-- leaves the invoice still claiming to be paid.
--
-- `payments` had no status column, so there was nowhere for "this did not
-- happen" to be recorded even if somebody had written the code.

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'posted';

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone;

-- Deliberately not a foreign key to `users`, matching what Phase 50 did for
-- `bills.approved_by`: a person can leave the company and their row can go,
-- and the fact that they voided a $1,500 receipt in March must not go with it.
-- A SET NULL here would erase exactly the thing the column exists to record.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "voided_by" uuid;

-- Why, not just that. A void with no reason is a hole in the record that
-- somebody has to reconstruct from dates six months later.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "void_reason" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_status_check'
  ) THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_status_check" CHECK ("status" IN ('posted', 'void'));
  END IF;
END $$;

-- Everything that sums payments now has to exclude the void ones — cash-basis
-- reporting above all, where a voided receipt left in place would report
-- revenue that was never received. This index is what makes that cheap.
CREATE INDEX IF NOT EXISTS "payments_company_status_idx"
  ON "payments" ("company_id", "status", "payment_date");

-- The applications stay. They are the record of what the payment settled, and
-- deleting them would leave the void payment saying an amount and nothing
-- saying where it went. Readers exclude them by joining to the payment's
-- status instead.
