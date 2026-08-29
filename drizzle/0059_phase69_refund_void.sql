-- Phase 69: taking a refund back.
--
-- ## The operation
--
-- ADR 0068 named it: "a recovery cannot be voided, the same gap ADR 0067 left
-- for refunds. Phase 52 taught payments to unwind; none of the three refunds
-- can." A refund is entered from a bank line, in somebody else's currency, on a
-- day somebody chooses — the easiest thing in the system to key wrongly, and
-- until now the only correction was a hand-posted journal that fixed the ledger
-- and left `refunds` still claiming it happened.
--
-- `voided_at` / `voided_by` rather than a delete, for the reason Phase 52 gave
-- when it voided payments: the row is the record of what somebody did, and
-- readers exclude it instead of losing the history.
--
-- There is deliberately **no reversing-entry column**. `voidJournalEntry` marks
-- the original entry `status = 'void'` and every balance query filters on
-- `status = 'posted'` — the ledger's way since Phase 2, and the path Phase 52
-- uses. A second mechanism that posted a mirror entry would give the books two
-- answers to "did this refund happen", which is the defect this project keeps
-- refactoring out. `journal_entry_id` already names the entry; voiding it is
-- the whole ledger half.
--
-- ## The column that should have been there
--
-- `refunds` stores `amount_cents` "in the other party's currency" and never
-- stored the currency. Every reader had to join back to the retainer, payment
-- or credit note to find out what money the number was in — and a reversal has
-- to print it, which is how this was noticed.
--
-- That is Phase 65's defect again, and its fifth outing: **a fact the code has
-- and does not keep.** The service knew the currency at the moment it wrote the
-- row, and threw it away.
--
-- Backfilled from each subject, which is exactly the join this removes.

ALTER TABLE "refunds"
  ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS "voided_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "voided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- One statement per subject kind: each reads its own table, and a row whose
-- subject has since been deleted keeps the 'USD' default rather than failing
-- the migration.
UPDATE "refunds" r
SET "currency" = t."currency"
FROM "retainers" t
WHERE r."subject_type" = 'retainer' AND r."subject_id" = t."id";

UPDATE "refunds" r
SET "currency" = p."currency"
FROM "payments" p
WHERE r."subject_type" = 'payment' AND r."subject_id" = p."id";

UPDATE "refunds" r
SET "currency" = n."currency"
FROM "credit_notes" n
WHERE r."subject_type" = 'credit_note' AND r."subject_id" = n."id";

CREATE INDEX IF NOT EXISTS "refunds_open_idx"
  ON "refunds" ("company_id", "voided_at");
