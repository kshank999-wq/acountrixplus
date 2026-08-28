-- Phase 48: somewhere to put the difference between the invoice and the goods.
--
-- Receiving stock posts Dr Inventory / Cr Goods Received Not Invoiced (2050).
-- The supplier's invoice is supposed to clear 2050 — and could not be entered,
-- because a bill line may only name an expense, COGS or asset account and 2050
-- is a liability. `attachBillToReceipts`, written in Phase 14 for exactly this,
-- had no caller anywhere.
--
-- So every delivery was billed to inventory or an expense instead, recognising
-- the cost twice, and 2050 grew for ever with nothing able to debit it. The
-- demo carried $28,700 in it.
--
-- 5450 is where the difference goes when the invoice and the receipt disagree.
-- Phase 14's comment said that difference should stay in 2050 "as a visible
-- residue"; it is not visible — a residue there is indistinguishable from a
-- delivery nobody has billed, which is precisely how the balance grew unseen.

INSERT INTO "chart_accounts" ("company_id", "number", "name", "type", "subtype", "description", "is_system")
SELECT
  c."id",
  '5450',
  'Purchase Price Variance',
  'cogs',
  'cost_of_goods_sold',
  'The difference between a supplier''s invoice and what the goods were taken into stock at.',
  true
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "chart_accounts" a
  WHERE a."company_id" = c."id" AND a."number" = '5450'
);
