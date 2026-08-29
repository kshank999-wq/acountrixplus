-- Phase 62: the money that did not know its own currency.
--
-- `recordPayment` has worked this out on every payment since Phase 35:
--
--   const paymentCurrency = await documentCurrency(ctx, input.kind, input.applications)
--   const paymentRateMillionths = (await rateFor(ctx, paymentCurrency, ...)).rateMillionths
--
-- — used it to fetch the rate, and never stored it. The answer was known at the
-- moment the row was written and thrown away: the same defect class as Phase
-- 55's `sent_at` written by nothing, and Phase 59's `paid` list discarded by a
-- `catch`. A fact the code has and does not keep.
--
-- The cost is paid five times over. `unapplied_cents` is money a customer
-- overpaid, and five separate queries sum it across a customer's receipts and
-- read the result as the company's own currency — the customers screen, the
-- chase run, the statement run, the statement itself, and the statement picker.
-- A customer who overpaid a EUR 4,000 invoice by EUR 500 was recorded as
-- holding $500.

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "currency" text;

-- The currency of the documents the payment settled, which is what
-- `documentCurrency` computed at the time and discarded. One payment settles
-- documents of one currency — allocation works in document amounts (Phase 41)
-- and `documentCurrency` has always refused a mixed set — so `min()` picks the
-- only value there is rather than choosing between several.
UPDATE "payments" p
SET "currency" = sub.currency
FROM (
  SELECT pa.payment_id, min(i.currency) AS currency
  FROM "payment_applications" pa
  JOIN "invoices" i ON i.id = pa.invoice_id
  GROUP BY pa.payment_id
) sub
WHERE sub.payment_id = p.id AND p."currency" IS NULL;

UPDATE "payments" p
SET "currency" = sub.currency
FROM (
  SELECT pa.payment_id, min(b.currency) AS currency
  FROM "payment_applications" pa
  JOIN "bills" b ON b.id = pa.bill_id
  GROUP BY pa.payment_id
) sub
WHERE sub.payment_id = p.id AND p."currency" IS NULL;

-- What is left settles nothing: a payment on account, or money received before
-- there was an invoice for it. There is no document to read a currency from,
-- and the company's own is the only answer available — which is also the right
-- one, because a customer paying in advance pays in the currency they are
-- billed in.
UPDATE "payments" p
SET "currency" = c."currency"
FROM "companies" c
WHERE c.id = p."company_id" AND p."currency" IS NULL;

ALTER TABLE "payments"
  ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "payments"
  ALTER COLUMN "currency" SET DEFAULT 'USD';

-- How held credit is summed per currency: "what is this customer holding, and
-- in what?" is asked once per customer on every statement, chase run and
-- statement run.
CREATE INDEX IF NOT EXISTS "payments_held_currency_idx"
  ON "payments" ("company_id", "customer_id", "currency")
  WHERE "unapplied_cents" > 0 AND "status" = 'posted';
