-- Phase 112: keeping the functional figure a retainer draw threw away.
--
-- A draw works out what actually left the liability, in the company's own
-- money, and posts it:
--
--   const release = relieveFunctional({...}, amountCents)
--   ...
--   { chartAccountId: heldAccount.id, debitCents: settlement.releasedCents }
--
-- and then wrote only `amount_cents` — the client's currency — onto the
-- application row. So the money a firm holds for its clients could be stated
-- for today and for no other day, because reconstructing yesterday's balance
-- needs the functional amount of every draw since.
--
-- It is not derivable from what was kept. `relieveFunctional` has a rule that
-- the final relief takes the **whole** remaining functional balance, so no
-- invoice or retainer is left holding a stranded cent — which means a draw's
-- functional amount depends on the functional balance at that moment, which is
-- the very history being reconstructed. Circular.
--
-- `refunds.carried_cents` is the same fact about the other way a retainer goes
-- down, and has been kept since Phase 68 with the same name and the same words:
-- "functional, off the balance being cleared, at its carried rate". One of the
-- two settlements of this liability kept its figure and the other did not.
-- This is Phase 65's defect again -- a functional amount computed and dropped,
-- leaving every later reader to re-derive it or join back.

ALTER TABLE "retainer_applications"
  ADD COLUMN "carried_cents" bigint;

-- Backfilled from the entry that actually debited the liability, which is the
-- truth rather than a reconstruction: the draw posted exactly `releasedCents`
-- to the retainer-held account, so the debit on that line *is* the figure the
-- column should have held all along.
--
-- The join goes through the account the entry itself touched rather than
-- through the chart by number, because a company on a pack without 2550 holds
-- retainers on 2500 and both are legitimate (see `resolveRetainerAccount`).
-- Taking the debit line of a retainer_application entry needs no opinion about
-- which account that was.
UPDATE "retainer_applications" ra
SET "carried_cents" = sub.debit
FROM (
  SELECT je."id" AS entry_id, SUM(jl."debit_cents") AS debit
  FROM "journal_entries" je
  JOIN "journal_lines" jl ON jl."journal_entry_id" = je."id"
  JOIN "chart_accounts" ca ON ca."id" = jl."chart_account_id"
  WHERE je."source_type" = 'retainer_application'
    AND ca."subtype" = 'deferred_revenue'
    AND jl."debit_cents" > 0
  GROUP BY je."id"
) sub
WHERE ra."journal_entry_id" = sub.entry_id;

-- Rows whose entry was voided or never linked — `journal_entry_id` is ON DELETE
-- SET NULL — fall back to the retainer's own carried rate. Exact for a retainer
-- in the company's own money, which is every retainer this application has
-- taken outside a test, and the best available answer otherwise. It is a
-- fallback rather than the rule precisely because it cannot see the
-- stranded-cent adjustment.
UPDATE "retainer_applications" ra
SET "carried_cents" = ROUND(ra."amount_cents"::numeric * r."exchange_rate_millionths"::numeric / 1000000)
FROM "retainers" r
WHERE ra."retainer_id" = r."id" AND ra."carried_cents" IS NULL;

ALTER TABLE "retainer_applications"
  ALTER COLUMN "carried_cents" SET NOT NULL;

-- The same shape `refunds` has carried since Phase 68: a settlement amount is
-- worth something or it is not a settlement.
ALTER TABLE "retainer_applications"
  ADD CONSTRAINT "retainer_applications_carried_positive" CHECK ("carried_cents" > 0);

-- The query this column exists for: one company's draws up to a date.
CREATE INDEX "retainer_applications_dated_idx"
  ON "retainer_applications" ("company_id", "applied_on");
