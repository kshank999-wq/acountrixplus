-- Phase 116: the invariant one table had and four did not.
--
-- `retainers_functional_remaining_sane` has existed since Phase 66, added in a
-- raw migration and never declared in the schema file. It says the only exact
-- thing there is to say about a money amount carried in two currencies: the two
-- sides reach zero together.
--
-- `relieveFunctional` guarantees it — the last settlement takes the whole
-- remaining functional balance rather than a computed one — and a row breaking
-- it is money sitting on a control account that no document can ever clear.
--
-- The other four tables carrying the same pair had nothing. This gives them the
-- same constraint, in the same shape, so there is one answer to the question
-- rather than five.
--
-- ## The backfill in front of it (added in Phase 117)
--
-- As first written, this migration would have failed on any database that had
-- used the migration wizard. `insertOpeningInvoice` and `insertOpeningBill`
-- never set the functional columns, so every document the wizard created had a
-- face balance and a functional balance of **zero** — which is precisely what
-- the constraint below refuses. It did not fail here because neither local
-- database happened to hold an imported document at the time.
--
-- Those rows are repairable arithmetic rather than a bookkeeper's decision, and
-- exactly so: an opening balance carries no currency of its own — it is what
-- the old system said was owed, in the money these books are kept in — so the
-- rate is one and the functional figure is the face figure. The four statements
-- below say only that, and touch nothing whose rate is not one.
--
-- ## If it still fails
--
-- It fails on a row where one side is zero and the other is not, and the
-- backfill did not reach it — a foreign document, so the two figures are not
-- each other. That one wants a bookkeeper rather than a backfill: the
-- functional side is money the ledger carries against a document that says it
-- is settled, and writing it to zero would silently unbalance the control
-- account. Find it with the query in each block's comment, correct it with a
-- journal entry that says why, then re-run.

--> statement-breakpoint
UPDATE "invoices" SET "functional_total_cents" = "total_cents",
                      "functional_balance_cents" = "balance_cents"
 WHERE "exchange_rate_millionths" = 1000000
   AND "functional_balance_cents" = 0 AND "balance_cents" <> 0;
--> statement-breakpoint
UPDATE "bills" SET "functional_total_cents" = "total_cents",
                   "functional_balance_cents" = "balance_cents"
 WHERE "exchange_rate_millionths" = 1000000
   AND "functional_balance_cents" = 0 AND "balance_cents" <> 0;
--> statement-breakpoint
UPDATE "credit_notes" SET "functional_total_cents" = "total_cents",
                          "functional_remaining_cents" = "remaining_cents"
 WHERE "exchange_rate_millionths" = 1000000
   AND "functional_remaining_cents" = 0 AND "remaining_cents" <> 0;
--> statement-breakpoint
UPDATE "payments" SET "functional_unapplied_cents" = "unapplied_cents"
 WHERE "exchange_rate_millionths" = 1000000
   AND "functional_unapplied_cents" = 0 AND "unapplied_cents" <> 0;

--> statement-breakpoint
-- SELECT id, number, balance_cents, functional_balance_cents FROM invoices
--  WHERE (balance_cents = 0) <> (functional_balance_cents = 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_functional_balance_sane"
  CHECK (("balance_cents" = 0) = ("functional_balance_cents" = 0)
         AND "functional_balance_cents" >= 0);
--> statement-breakpoint
-- SELECT id, number, balance_cents, functional_balance_cents FROM bills
--  WHERE (balance_cents = 0) <> (functional_balance_cents = 0);
ALTER TABLE "bills" ADD CONSTRAINT "bills_functional_balance_sane"
  CHECK (("balance_cents" = 0) = ("functional_balance_cents" = 0)
         AND "functional_balance_cents" >= 0);
--> statement-breakpoint
-- SELECT id, number, remaining_cents, functional_remaining_cents FROM credit_notes
--  WHERE (remaining_cents = 0) <> (functional_remaining_cents = 0);
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_functional_remaining_sane"
  CHECK (("remaining_cents" = 0) = ("functional_remaining_cents" = 0)
         AND "functional_remaining_cents" >= 0);
--> statement-breakpoint
-- SELECT id, reference, unapplied_cents, functional_unapplied_cents FROM payments
--  WHERE (unapplied_cents = 0) <> (functional_unapplied_cents = 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_functional_unapplied_sane"
  CHECK (("unapplied_cents" = 0) = ("functional_unapplied_cents" = 0)
         AND "functional_unapplied_cents" >= 0);
