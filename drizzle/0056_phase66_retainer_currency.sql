-- Phase 66: the retainer you could not draw.
--
-- `refuseForeign` has stopped four operations since Phase 35. Phase 63 lifted
-- three of them, having found their question was already answered by the
-- document engine, and kept the fourth on purpose:
--
--   Applying a retainer is a settlement, not a reversal: it decides at what
--   rate money already held discharges a new demand, which has a
--   profit-and-loss effect and is an accounting decision, not arithmetic the
--   document engine already made.
--
-- ADR 0065 left it standing for the same reason. The decision is now made, and
-- it is one this codebase had already taken once: a retainer is cash received
-- and held, so drawing it against an invoice is a receipt that arrived early,
-- and the rule is `recordPayment`'s.
--
-- For that to be possible the retainer has to know what currency it was
-- received in and what the books have been carrying it at — the same three
-- columns Phase 62 and 65 gave payments and Phase 63 gave credit notes.

ALTER TABLE "retainers"
  ADD COLUMN IF NOT EXISTS "currency" text NOT NULL DEFAULT 'USD',
  -- Millionths, retainer currency -> functional. Fixed on the day the money
  -- arrived and never recomputed: this is what the liability has been carried
  -- at ever since, and restating it would rewrite cash the business banked.
  ADD COLUMN IF NOT EXISTS "exchange_rate_millionths" bigint NOT NULL DEFAULT 1000000,
  -- What is left to draw, in the company's own money. Moves with
  -- `remaining_cents` on every draw, never derived from it afterwards.
  ADD COLUMN IF NOT EXISTS "functional_remaining_cents" bigint NOT NULL DEFAULT 0;

-- Trivially correct, and for the same unusual reason Phase 63's was: nothing
-- exists to get wrong. `recordRetainer` has never accepted a currency, so every
-- retainer on file was received in the company's own money at a rate of one.
--
-- The currency is still read from the company rather than left at the column
-- default, because a company whose books are not in USD had retainers in *its*
-- currency and the default would have mislabelled every one.
UPDATE "retainers" r
SET "currency" = c."currency",
    "functional_remaining_cents" = r."remaining_cents"
FROM "companies" c
WHERE c.id = r."company_id";

-- The two halves of what is left have to reach zero together, the way the
-- invoice's and the credit note's do. Stated as a constraint rather than left
-- to the code, because a retainer that still shows functional money after its
-- face amount is spent is credit the business does not have.
ALTER TABLE "retainers"
  DROP CONSTRAINT IF EXISTS "retainers_functional_remaining_sane";

ALTER TABLE "retainers"
  ADD CONSTRAINT "retainers_functional_remaining_sane"
  CHECK (
    ("remaining_cents" = 0) = ("functional_remaining_cents" = 0)
    AND "functional_remaining_cents" >= 0
  );
