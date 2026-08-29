-- Phase 67: the money you gave back at the wrong rate.
--
-- Two halves of one rule.
--
-- ## The operation that was missing
--
-- ADR 0066 named it: "a retainer cannot be refunded in its own currency,
-- because it cannot be refunded at all — there has never been a way to give one
-- back." An engagement that ends with money unearned leaves a liability on
-- `2550 Client Retainers Held` that nobody can clear, and a client owed money
-- the product cannot record returning.
--
-- That is Phase 49's lesson, which found `applyVendorCredit` written since
-- Phase 12 with no caller anywhere in `src/app`. A balance with no way out is
-- not a feature that is merely inconvenient; it is a number that becomes wrong
-- and stays wrong.
--
-- ## The operation that was wrong
--
-- `refundCredit`, built in Phase 53 for a customer's overpayment, posts:
--
--   Dr Customer Overpayments   amountCents
--   Cr Bank                    amountCents
--
-- — the **face amount**, with no conversion. While every holding was in the
-- company's own money that was right. Phase 62 let a receipt arrive in euro and
-- Phase 65 taught the column to carry what it was worth, and this entry was
-- left behind: refunding a EUR 500 overpayment posted 50000 to a dollar ledger
-- and released 50000 of a liability carried at 54175, leaving 4175 of somebody
-- else's money on the balance sheet for ever.
--
-- Both are the same decision, and Phase 66 already made it. `settleHeld`: the
-- liability released at what it has been carried at, the other side at what
-- actually moved, the difference realised.

CREATE TABLE IF NOT EXISTS "retainer_refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "retainer_id" uuid NOT NULL REFERENCES "retainers"("id") ON DELETE CASCADE,

  -- What the client was given back, in the currency they gave it in. A refund
  -- of a EUR retainer is a EUR refund: the client is owed money in theirs.
  "amount_cents" bigint NOT NULL,
  -- What left the liability, at the rate the retainer has been carried at.
  "released_cents" bigint NOT NULL,
  -- What actually left the bank, at the rate on the day it left — which is what
  -- the bank statement will say, and the number the reconciliation needs.
  "paid_cents" bigint NOT NULL,
  "exchange_rate_millionths" bigint NOT NULL DEFAULT 1000000,

  "refunded_on" date NOT NULL,
  "reference" text,
  "financial_account_id" uuid REFERENCES "financial_accounts"("id") ON DELETE SET NULL,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "retainer_refunds_amount_positive" CHECK ("amount_cents" > 0)
);

CREATE INDEX IF NOT EXISTS "retainer_refunds_retainer_idx"
  ON "retainer_refunds" ("retainer_id");

CREATE INDEX IF NOT EXISTS "retainer_refunds_company_date_idx"
  ON "retainer_refunds" ("company_id", "refunded_on");
