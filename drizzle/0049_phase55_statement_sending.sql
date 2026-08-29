-- Phase 55: a statement you can actually send.
--
-- `customer_statements.sent_at` has existed since Phase 11 and NOTHING has
-- ever written to it. `sent_to` was worse than absent: `saveStatement` filled
-- it in at *save* time with the customer's address, so the screen showed a
-- statement, a date, and an email address it had never been sent to.
--
-- A business reading that column would believe the customer had been told.
-- That is the most expensive kind of wrong an accounting system can be — the
-- same class as Phase 46's stranded payments and Phase 48's clearing account
-- nothing could clear.
--
-- The module header on `statements.ts` has said since Phase 11 that "what did
-- we send them, and when" is the first question in any collections
-- conversation. It was the one question the data could not answer.

-- The customer's door onto one statement.
--
-- Per statement rather than per customer, deliberately: a link that opened
-- "this customer's statements" would let anybody holding June's letter read
-- December's, which is a different document about a different moment and not
-- what they were given.
--
-- Nullable because it is minted on the first send, not at creation — a live
-- door onto a document nobody asked to share is a door open for no reason
-- (Phase 42 decided this for invoices and it decides it here).
ALTER TABLE "customer_statements" ADD COLUMN IF NOT EXISTS "share_token" text;

-- Unique across the whole table, not per company: the token IS the identifier
-- on the public route, and there is no company in that URL to scope it by.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_statements_share_token_idx"
  ON "customer_statements" ("share_token")
  WHERE "share_token" IS NOT NULL;

-- How many times it went. Phase 42's counter on invoices, for the same reason:
-- "we have sent this three times" is the fact a collections conversation turns
-- on, and it is not recoverable from a single timestamp.
ALTER TABLE "customer_statements"
  ADD COLUMN IF NOT EXISTS "send_count" integer NOT NULL DEFAULT 0;

-- Undo the claim the old code made.
--
-- Every existing row with an address and no `sent_at` was never sent, so the
-- address is a record of nothing. Clearing it is not losing data: the customer
-- it would have gone to is still on the customer record, which is where
-- `saveStatement` read it from in the first place.
UPDATE "customer_statements" SET "sent_to" = NULL WHERE "sent_at" IS NULL;
