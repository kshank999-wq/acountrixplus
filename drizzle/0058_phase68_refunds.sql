-- Phase 68: one record for money handed back, whichever way it went.
--
-- ## Why this replaces a table one phase old
--
-- Phase 67 created `retainer_refunds` because a retainer refund is three facts
-- rather than one and storing only the face amount would have been Phase 65's
-- defect again. That reasoning was right. What it got wrong was the scope of
-- the noun.
--
-- By the end of that phase there were already three refunds in the system and
-- three different answers to "where is it written down":
--
--   * `refundRetainer`   → a row in `retainer_refunds`
--   * `refundCredit`     → nothing but a journal entry
--   * a vendor credit    → no way to do it at all
--
-- Phase 68 adds the third, and `vendor_credit_refunds` beside `retainer_refunds`
-- would have made the split permanent. The vendor-credits module has said since
-- Phase 12 why that is wrong, about this very shape:
--
--   > Two tables would mean two copies of the remaining-balance arithmetic, the
--   > application rules, and the aging treatment, and the first bug fixed in one
--   > would leave the other wrong.
--
-- So: one `refunds` table with a subject, the way `journal_entries` has carried
-- `source_type`/`source_id` since Phase 2. `retainer_refunds` is one phase old
-- and has one caller, which is the cheapest this will ever be to undo.
--
-- ## Why `direction` is stored rather than inferred
--
-- Money going back to a client and money coming back from a supplier are the
-- same three amounts with the debit and the credit swapped, and therefore with
-- opposite signs on the realised gain. Nothing about the amounts themselves
-- says which — a swapped sign still balances, which is exactly what makes it
-- dangerous. The column says it, and the check below makes the database refuse
-- a row whose three amounts do not add up the way its direction claims.

CREATE TABLE IF NOT EXISTS "refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,

  -- Polymorphic on purpose: a retainer, a customer's overpayment and a vendor
  -- credit are different records, and giving each its own nullable column would
  -- put the "exactly one of these is set" problem in every query that reads it.
  "subject_type" text NOT NULL,
  "subject_id" uuid NOT NULL,

  -- 'out' — the business handed money back (a retainer, an overpayment).
  -- 'in'  — the business got money back (a vendor credit).
  "direction" text NOT NULL,

  -- What changed hands, in the other party's currency. They are owed, or owe,
  -- in their money.
  "amount_cents" bigint NOT NULL,
  -- Functional. What left the balance being cleared, at the rate that balance
  -- has been carried at since it was recorded.
  "carried_cents" bigint NOT NULL,
  -- Functional. What actually moved through the bank, at the rate on the day —
  -- which is what the statement will say and what the reconciliation needs.
  "cash_cents" bigint NOT NULL,
  -- Positive is a gain. Derivable from the two above and `direction`, and kept
  -- anyway: the sign is the part that is silently wrong when it is wrong.
  "realised_cents" bigint NOT NULL DEFAULT 0,
  "exchange_rate_millionths" bigint NOT NULL DEFAULT 1000000,

  "refunded_on" date NOT NULL,
  "reference" text,
  "financial_account_id" uuid REFERENCES "financial_accounts"("id") ON DELETE SET NULL,
  "journal_entry_id" uuid REFERENCES "journal_entries"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "refunds_amount_positive" CHECK ("amount_cents" > 0),
  CONSTRAINT "refunds_subject_known" CHECK (
    "subject_type" IN ('retainer', 'payment', 'credit_note')
  ),
  CONSTRAINT "refunds_direction_known" CHECK ("direction" IN ('out', 'in')),
  -- The three amounts have to add up the way the direction says they do.
  -- Going out, the balance is debited and covers the cash plus the gap; coming
  -- in, the cash is debited and covers the balance plus the gap.
  CONSTRAINT "refunds_balances" CHECK (
    ("direction" = 'out' AND "carried_cents" = "cash_cents" + "realised_cents")
    OR
    ("direction" = 'in' AND "cash_cents" = "carried_cents" + "realised_cents")
  )
);

CREATE INDEX IF NOT EXISTS "refunds_subject_idx"
  ON "refunds" ("subject_type", "subject_id");

CREATE INDEX IF NOT EXISTS "refunds_company_date_idx"
  ON "refunds" ("company_id", "refunded_on");

-- Carry Phase 67's rows across. Every one of them is a retainer going out, and
-- `released - paid` is the realised figure that phase computed and did not keep.
INSERT INTO "refunds" (
  "id", "company_id", "subject_type", "subject_id", "direction",
  "amount_cents", "carried_cents", "cash_cents", "realised_cents",
  "exchange_rate_millionths", "refunded_on", "reference",
  "financial_account_id", "journal_entry_id", "created_by", "created_at"
)
SELECT
  r."id", r."company_id", 'retainer', r."retainer_id", 'out',
  r."amount_cents", r."released_cents", r."paid_cents",
  r."released_cents" - r."paid_cents",
  r."exchange_rate_millionths", r."refunded_on", r."reference",
  r."financial_account_id", r."journal_entry_id", r."created_by", r."created_at"
FROM "retainer_refunds" r
ON CONFLICT ("id") DO NOTHING;

DROP TABLE IF EXISTS "retainer_refunds";
