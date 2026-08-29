-- Phase 63: the euro invoice you could not credit.
--
-- `refuseForeign` has stopped four operations dead since Phase 35 — crediting
-- an invoice, crediting a bill, applying a credit, and drawing a retainer — on
-- the grounds that nobody had decided how to convert a multi-line document:
--
--   for a multi-line document — a credit note, a vendor credit — that amount is
--   the sum of the converted lines, not the conversion of the sum. The two
--   differ by a cent often enough to matter, and picking either without
--   deciding which is right is how a set of books acquires a drift nobody can
--   explain.
--
-- Nobody had to decide. `createInvoice` decided it when it raised the document:
-- each line converts on its own and the total is their sum. A credit note
-- reverses a document, and reversing it by different arithmetic than raised it
-- IS the drift. So a credit note becomes a document like any other, in the
-- shape Phase 35 gave invoices and bills.

ALTER TABLE "credit_notes"
  ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'USD',
  -- Millionths, foreign → functional. Fixed at issue and never recomputed, for
  -- the reason a document's rate is: restating it from a later rate silently
  -- rewrites the revenue this credit reversed, every time a currency moves.
  ADD COLUMN IF NOT EXISTS "exchange_rate_millionths" bigint NOT NULL DEFAULT 1000000,
  ADD COLUMN IF NOT EXISTS "functional_total_cents" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "functional_remaining_cents" bigint NOT NULL DEFAULT 0;

-- The backfill is trivially correct, and for an unusual reason: the refusal
-- this phase lifts guaranteed there are none to get wrong. Every credit note
-- that exists was raised against a domestic document or standalone in the
-- company's own currency, so the rate is one and the functional amounts are
-- the amounts.
--
-- The currency is still read from the company rather than hardcoded, because a
-- company whose own currency is not USD had credit notes in *its* currency and
-- the column default would have mislabelled every one of them.
UPDATE "credit_notes" cn
SET "currency" = c."currency",
    "functional_total_cents" = cn."total_cents",
    "functional_remaining_cents" = cn."remaining_cents"
FROM "companies" c
WHERE c.id = cn."company_id";

-- What the credit-note screens group on, and what the integrity check needs to
-- compare a stored functional amount against its own rate.
CREATE INDEX IF NOT EXISTS "credit_notes_company_currency_idx"
  ON "credit_notes" ("company_id", "currency");
