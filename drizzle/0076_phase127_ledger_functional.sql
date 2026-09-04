-- Phase 127 — the two writes that posted a face amount into the ledger.
--
-- `recoverWriteOff` posted the invoice's own amount against a bad-debt expense
-- that `writeOffInvoice` had raised in functional money, so a fully recovered
-- €2,500 write-off left $250 of loss on the books permanently. `createDeposit`
-- credited Undeposited Funds the receipts' face sum against a balance
-- `recordPayment` had debited in functional money, stranding the difference in
-- a clearing account nothing could clear.
--
-- Neither could be fixed locally, because neither table kept a functional
-- figure to post. That is what these columns are for; ADR 0126 nominated them
-- as the last two thirds of ADR 0125's `unrecorded` gap, and measuring found
-- why they mattered.
--
-- ## The backfill records what the ledger actually contains
--
-- Not what it should have contained. The two are different for exactly the
-- rows this phase is about, and rewriting them here would erase the evidence
-- while leaving the journal entries untouched — a second disagreement on top of
-- the first.
--
--   * `invoice_write_offs.functional_amount_cents` takes the invoice's rate,
--     because that is what `writeOffInvoice` posted and has always posted.
--   * `invoice_write_offs.functional_recovered_cents` takes the *face* recovered
--     amount, because that is what the recovery posted. For a domestic write-off
--     the two are the same number; for a foreign one this is the defect, written
--     down where a person can see it rather than quietly corrected.
--   * `deposits` takes face = functional throughout, for the same reason: every
--     deposit written before this migration posted its face sum, so that is what
--     the bank and Undeposited Funds balances carry.
--
-- Repairing historical postings is a correction somebody has to decide on, with
-- a reason and a date, through the vocabulary Phase 70 built. It is not
-- something a migration may do behind their back.

ALTER TABLE invoice_write_offs
  ADD COLUMN currency text,
  ADD COLUMN functional_amount_cents bigint,
  ADD COLUMN functional_recovered_cents bigint;

UPDATE invoice_write_offs w
   SET currency = i.currency,
       functional_amount_cents =
         round(w.amount_cents * i.exchange_rate_millionths / 1000000.0),
       functional_recovered_cents = coalesce(w.recovered_cents, 0)
  FROM invoices i
 WHERE i.id = w.invoice_id
   AND w.currency IS NULL;

ALTER TABLE invoice_write_offs
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN functional_amount_cents SET NOT NULL,
  ALTER COLUMN functional_recovered_cents SET NOT NULL,
  ALTER COLUMN functional_recovered_cents SET DEFAULT 0;

-- Phase 116's pair constraint: a write-off with nothing left in face money must
-- have nothing left in functional money either, or the residue is exactly the
-- stranded expense this phase exists to stop.
ALTER TABLE invoice_write_offs
  ADD CONSTRAINT invoice_write_offs_functional_sane
  CHECK (functional_amount_cents > 0 AND functional_recovered_cents >= 0);

ALTER TABLE deposits
  ADD COLUMN currency text,
  ADD COLUMN functional_total_cents bigint,
  ADD COLUMN functional_receipts_cents bigint;

UPDATE deposits
   SET currency = 'USD',
       functional_total_cents = total_cents,
       functional_receipts_cents = receipts_cents
 WHERE currency IS NULL;

-- The company's own, not a blind 'USD': every deposit written before this
-- migration banked receipts in one currency (Phase 123 made that a refusal) and
-- posted their face sum, so the currency of the figure the ledger carries is
-- the company's functional one.
UPDATE deposits d
   SET currency = c.currency
  FROM companies c
 WHERE c.id = d.company_id;

ALTER TABLE deposits
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN functional_total_cents SET NOT NULL,
  ALTER COLUMN functional_total_cents SET DEFAULT 0,
  ALTER COLUMN functional_receipts_cents SET NOT NULL,
  ALTER COLUMN functional_receipts_cents SET DEFAULT 0;

ALTER TABLE deposits
  ADD CONSTRAINT deposits_functional_total_positive
  CHECK (functional_total_cents > 0);
