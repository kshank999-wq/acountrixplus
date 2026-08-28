-- Phase 47: the supplier's reference is not our bill number.
--
-- `bills.number` has carried two different things since Phase 2: the number
-- this system generates, and — because the composer's field is labelled "Their
-- reference" with the placeholder INV-4471 — the supplier's own. That column is
-- unique per *company*, so the constraint has been wrong in both directions:
--
--   * two different suppliers both using INV-4471 could not both be entered,
--     and the second failed on a raw unique violation reported as
--     "Something went wrong";
--   * the same supplier's invoice entered twice was only caught if somebody
--     typed the reference both times, and the field is optional.
--
-- A reference identifies a document *within a supplier*. These columns say so.

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "vendor_reference" text;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "reference_key" text;

-- Backfill. A number matching our own generated shape is ours; anything else
-- was typed by somebody, and what they typed was the supplier's reference —
-- that is what the field asked them for.
--
-- `number` itself is left exactly as it is. It appears in journal memos, in
-- payment references and in the audit trail, and rewriting a document's number
-- after the fact would make those point at nothing.
UPDATE "bills"
SET "vendor_reference" = "number"
WHERE "number" !~ '^BILL-[0-9]+$';

UPDATE "bills"
SET "reference_key" = nullif(upper(regexp_replace("vendor_reference", '[^a-zA-Z0-9]', '', 'g')), '')
WHERE "vendor_reference" IS NOT NULL;

-- The constraint that was missing. Partial, because most bills carry no
-- reference at all and null is not "the same as" another null — a supplier who
-- numbers nothing must not block the next unnumbered bill from anybody.
CREATE UNIQUE INDEX IF NOT EXISTS "bills_vendor_reference_unique"
  ON "bills" ("company_id", "vendor_id", "reference_key")
  WHERE "reference_key" IS NOT NULL;

-- Finding the resemblances: same supplier, same amount, near date.
CREATE INDEX IF NOT EXISTS "bills_duplicate_scan_idx"
  ON "bills" ("company_id", "vendor_id", "total_cents", "issue_date");
