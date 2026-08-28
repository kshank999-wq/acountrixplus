-- Phase 53: somewhere to put the money the customer sent that nothing was
-- owed for.
--
-- A customer owed $7,400 and sent $8,000. The screen said:
--
--   "$8,000.00 is more than the $7,400.00 outstanding. Reduce it to $7,400.00,
--    or raise the document the rest covers first."
--
-- Both are wrong, and the first is worse. Recording $7,400 puts a figure in
-- the books the bank statement disagrees with and leaves the reconciliation
-- $600 out for ever, because the difference was never recorded as anything.
-- "Raise the document the rest covers" means inventing an invoice for money
-- the customer does not owe, fabricating revenue to make a bank line match.
--
-- `allocate` has computed `unappliedCents` correctly since Phase 41. Nothing
-- was ever done with it except refuse.

-- A liability, because a customer who has paid more than they owe is a
-- customer the business owes money to.
--
-- Deliberately not `2500 Unearned Revenue`: that is money taken for work that
-- will be done, and an overpayment carries no promise of future work — often
-- it is a keying error whose honest end is a refund. Phase 15's retainers are
-- the deliberate version and already have `2550 Client Retainers Held`. Same
-- reasoning as Phase 44 keeping money at a processor apart from cash in hand:
-- two things that both look like "money we hold" and behave differently.
INSERT INTO "chart_accounts" ("company_id", "number", "name", "type", "subtype", "description", "is_system")
SELECT
  c."id",
  '2520',
  'Customer Overpayments',
  'liability',
  'other_current_liability',
  'Money customers have sent beyond what they owed, held until it is applied to an invoice or refunded.',
  true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_accounts" a
  WHERE a."company_id" = c."id" AND a."number" = '2520'
);

-- How much of this receipt is against nothing.
--
-- Derivable as `amount_cents - sum(applications)`, and stored anyway for the
-- reason Phase 2 stores document balances: the alternative is summing the whole
-- application history on every read of every customer's credit, and the figure
-- is wanted on a screen that lists a hundred payments.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "unapplied_cents" bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_unapplied_within_amount'
  ) THEN
    -- Cannot hold more than arrived, and cannot hold a negative.
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_unapplied_within_amount"
      CHECK ("unapplied_cents" >= 0 AND "unapplied_cents" <= "amount_cents");
  END IF;
END $$;

-- The index the "what is this customer holding" query runs on. Partial,
-- because the overwhelming majority of payments land exactly and carry zero.
CREATE INDEX IF NOT EXISTS "payments_unapplied_idx"
  ON "payments" ("company_id", "customer_id")
  WHERE "unapplied_cents" > 0 AND "status" = 'posted';

-- Nothing is backfilled. Every payment recorded before this phase applied
-- exactly, because the application refused anything else — so zero is not a
-- guess, it is the only value those rows could ever have had.
