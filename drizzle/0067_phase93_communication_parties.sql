-- Phase 93: a letter can be filed against a customer or a supplier.
--
-- `recordOutboundMail` resolved an address through `contacts` alone, which was
-- right for Phase 22's invitations and password resets. It is wrong for the
-- letters this application mostly sends: an invoice goes to the address on the
-- `customers` row, and a business that bills people it never courted has no CRM
-- contact for any of them. On this repository's own seed data none of the five
-- customers with an email address matches a contact.
--
-- `ON DELETE SET NULL` on both, matching `contact_id`: deleting a customer must
-- not delete the record of what we sent them. The entry keeps its summary, its
-- letter and its date, and simply stops naming a party.

ALTER TABLE "communications"
  ADD COLUMN IF NOT EXISTS "customer_id" uuid
  REFERENCES "customers"("id") ON DELETE SET NULL;

ALTER TABLE "communications"
  ADD COLUMN IF NOT EXISTS "vendor_id" uuid
  REFERENCES "vendors"("id") ON DELETE SET NULL;

-- "What have we sent this customer?" is the question the screen asks, and it
-- asks it newest first.
CREATE INDEX IF NOT EXISTS "communications_customer_idx"
  ON "communications" ("customer_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "communications_vendor_idx"
  ON "communications" ("vendor_id", "occurred_at");

-- Phase 22's rule, widened rather than dropped.
--
-- It exists because "a row naming no party at all belongs to no timeline and
-- would be visible on no screen — which is a silent way to lose what somebody
-- wrote down". That reasoning is untouched; there are simply two more ways to
-- name a party now. A customer with no CRM organization — the ordinary case for
-- somebody you bill but never courted — could not satisfy the old check at all,
-- so widening it is what makes this phase possible rather than a loosening.
ALTER TABLE "communications"
  DROP CONSTRAINT IF EXISTS "communications_has_party";

ALTER TABLE "communications"
  ADD CONSTRAINT "communications_has_party"
  CHECK (
    "organization_id" IS NOT NULL
    OR "contact_id" IS NOT NULL
    OR "opportunity_id" IS NOT NULL
    OR "customer_id" IS NOT NULL
    OR "vendor_id" IS NOT NULL
  );

-- A letter is about one trading party, never two. `filingFor` decides which
-- from what the letter is; this is the database refusing to hold the shape that
-- decision exists to prevent.
ALTER TABLE "communications"
  DROP CONSTRAINT IF EXISTS "communications_one_trading_party";

ALTER TABLE "communications"
  ADD CONSTRAINT "communications_one_trading_party"
  CHECK ("customer_id" IS NULL OR "vendor_id" IS NULL);
