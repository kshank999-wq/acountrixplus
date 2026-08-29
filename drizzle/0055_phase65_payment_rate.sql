-- Phase 65: the credit netted against a converted balance.
--
-- ADR 0062 named three sums that add currencies and ADR 0063 and 0064 left them
-- open. The defect is sharper than "they add currencies". The customers screen
-- builds a party's standing out of two sums:
--
--   balanceCents:    coalesce(sum(invoices.functional_balance_cents), 0)
--   heldCreditCents: coalesce(max(held_credit.held_cents), 0)
--
-- The first is converted. The second is the face amount. Phase 54 then nets one
-- against the other to decide what the customer should pay. So a customer with
-- a EUR 4,000 invoice and a EUR 500 overpayment had a balance of $4,334.00
-- reduced by 500 — neither dollars nor euro, arrived at by subtracting one
-- currency from another, and printed with a dollar sign.
--
-- `recordPayment` already has what closes it, and has since Phase 35:
--
--   const paymentRateMillionths = (await rateFor(ctx, paymentCurrency, ...)).rateMillionths
--   ...
--   const heldFunctionalCents = receivedCents - appliedFunctionalCents
--
-- The rate is fetched, used once, discarded. The functional value of the held
-- amount is *computed outright* and discarded. Phase 62 kept the currency from
-- the line above and left both of these behind. Fourth instance of the same
-- shape: Phase 55's `sent_at` written by nothing, Phase 59's `paid` list
-- discarded by a `catch`, Phase 62's `paymentCurrency`, and now this.

ALTER TABLE "payments"
  -- Millionths, payment currency -> functional. Fixed when the money arrived
  -- and never recomputed, for the reason a document's rate is: restating it
  -- from a later rate rewrites what the business actually banked.
  ADD COLUMN IF NOT EXISTS "exchange_rate_millionths" bigint NOT NULL DEFAULT 1000000,
  -- What is still held, in the company's own money. Moves with
  -- `unapplied_cents`, never derived from it after the fact.
  ADD COLUMN IF NOT EXISTS "functional_unapplied_cents" bigint NOT NULL DEFAULT 0;

-- The rate each payment was actually taken at.
--
-- This walks backwards to the most recent rate on or before the payment date,
-- which is `rateFor`'s rule written a second time, in SQL. That is a real cost
-- and worth naming: two copies of one rule can drift. It is accepted here
-- because a backfill has to be SQL and runs exactly once — and because the
-- alternative, leaving the column at parity, would say every euro receipt ever
-- taken was worth its face value in dollars.
--
-- Every row it needs to match, it can: `recordPayment` calls `rateFor` and
-- throws when there is no rate, so no payment exists that was recorded without
-- one. A domestic payment keeps the default of one, which is not a lookup but
-- the definition — a receipt in the company's own money is not a conversion.
-- A correlated subquery rather than a lateral join: Postgres will not let the
-- table an UPDATE targets be referenced from a LATERAL in its own FROM list.
UPDATE "payments" p
SET "exchange_rate_millionths" = coalesce(
  (
    SELECT er.rate_millionths
    FROM "exchange_rates" er
    JOIN "companies" c ON c.id = p.company_id
    WHERE er.company_id = p.company_id
      AND er.base_currency = p."currency"
      AND er.quote_currency = c."currency"
      AND er.rate_date <= p.payment_date
    ORDER BY er.rate_date DESC
    LIMIT 1
  ),
  p."exchange_rate_millionths"
)
WHERE EXISTS (
  SELECT 1 FROM "companies" c
  WHERE c.id = p.company_id AND c."currency" <> p."currency"
);

-- What is still held, in the company's own money.
--
-- From `unapplied_cents` as it stands, and not from `amount - applied`. The
-- first draft of this migration used the latter, on the reasoning that it is
-- what `recordPayment` computes — `convert(received) - convert(applied)`, so
-- that the two halves add back to the money that actually hit the bank.
--
-- The data said otherwise. A receipt of $8,000.00 with $7,800.00 of
-- applications had $200.00 **refunded** (Phase 53), which reduces
-- `unapplied_cents` without leaving an application behind. Reconstructing from
-- applications alone claimed $200.00 was still held when the customer had it
-- back. `amount - applied` is what was *originally* left over; this column is
-- what is left *now*, and only `unapplied_cents` knows that.
--
-- The trade-off, stated: on a foreign receipt that has since been partly drawn
-- down, this can differ by a cent from the running total the going-forward code
-- keeps, because each draw-down relieves its own converted share. A cent on
-- historic rows is the price of not being $200.00 wrong on one of them.
--
-- Rounding is half away from zero at the cent — `convert`'s rule, and
-- Postgres's `round(numeric)`.
UPDATE "payments" p
SET "functional_unapplied_cents" =
  round(p.unapplied_cents::numeric * p."exchange_rate_millionths" / 1000000);

-- What the three sums group on. They filter to posted receipts with something
-- left over and group by party, so the party is the leading column.
CREATE INDEX IF NOT EXISTS "payments_company_customer_held_idx"
  ON "payments" ("company_id", "customer_id")
  WHERE "unapplied_cents" > 0;
