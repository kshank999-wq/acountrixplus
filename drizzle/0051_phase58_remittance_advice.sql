-- Phase 58: telling a supplier what a payment was for.
--
-- Phase 49 built pay runs: select seven bills, deduct a vendor credit, send one
-- payment. What the SUPPLIER receives is a single bank credit for an amount
-- that matches none of their invoices, with no indication of which it covers.
--
-- Every consequence lands on the payer:
--
--  * The supplier cannot apply the payment, so their aging still shows the
--    invoices open — and their chase run emails a demand for money paid a
--    fortnight ago.
--  * Somebody rings up asking what the payment was for, and somebody here has
--    to reconstruct it from the pay run.
--  * When a vendor credit was deducted the figure matches nothing at all, and
--    the supplier's first assumption is a short payment rather than a credit
--    they issued.
--
-- A remittance advice is the oldest courtesy in accounts payable. The pay run,
-- the email channel (Phase 19), the share-token pattern (Phase 42) and the
-- public document page (Phase 55) were all already here.

-- The supplier's door onto one payment.
--
-- Per payment rather than per supplier: a link that opened "this supplier's
-- payments" would let whoever holds July's advice read December's, which is a
-- different payment they were never given.
--
-- Minted on the first send, not at creation — a live door onto a document
-- nobody asked to share is a door open for no reason (Phase 42's rule).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "share_token" text;

-- Unique across the table, not per company: the token IS the identifier on the
-- public route, and there is no company in that URL to scope it by.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_share_token_idx"
  ON "payments" ("share_token")
  WHERE "share_token" IS NOT NULL;

-- When the advice went, and where. Separate from anything about the payment
-- itself: `paid_at` is when money moved, this is when somebody was told.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "remittance_sent_at" timestamptz;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "remittance_sent_to" text;

-- How many times it went. "We sent that twice" is the fact a payables
-- conversation turns on, and it is not recoverable from one timestamp.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "remittance_send_count" integer NOT NULL DEFAULT 0;
