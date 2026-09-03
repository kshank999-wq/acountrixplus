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
-- ## If this migration fails
--
-- It fails on a row where one side is zero and the other is not. That row is
-- the defect the constraint exists to prevent, and it wants a bookkeeper rather
-- than a backfill: the functional side is money the ledger is carrying against
-- a document that says it is settled, so writing it to zero here would silently
-- unbalance the control account. Find it with the query in each block's comment,
-- correct it with a journal entry that says why, then re-run.

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
