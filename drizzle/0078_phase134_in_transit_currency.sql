-- Phase 134: the account where three currencies met.
--
-- `1250 Payments in Transit` takes three postings and, measured, they were not
-- in the same money:
--
--   Capture   `recordPayment`  debits  `receivedCents`      — converted
--   Fee       `postFee`        credits `input.feeCents`     — face
--   Payout    `importPayouts`  credits `batch.amountCents`  — face
--
-- A EUR100 charge with a EUR5 fee at 1.10 leaves $10.00 in the account that is
-- not a balance, not a fee and not a gain. `checkouts.currency` is the
-- invoice's currency, so a euro invoice paid by card produces this today.
--
-- Both face postings are declared `domestic` in LEDGER_POSTINGS, and both
-- arguments end with the same hedge — "a fact about the data rather than about
-- the schema". These columns are what turn that hedge into a fact about the
-- schema.

--------------------------------------------------------------------------------
-- What the capture and its fee actually put into the clearing account.
--
-- Stored rather than derived at payout time. The clearing account has to be
-- relieved of exactly what it was charged or it can never reach zero, and
-- reaching zero is the only thing it is for. Recomputing from a rate looked up
-- later gives a different answer whenever the rate table has grown since —
-- which is precisely the defect Phase 129 found in the bank feed.

ALTER TABLE checkouts
  ADD COLUMN functional_gross_cents bigint,
  ADD COLUMN functional_fee_cents bigint;

-- Both or neither, and never negative. A functional gross with no functional
-- fee would relieve the account by a converted debit and a face credit, which
-- is half of the defect this phase exists to close.
ALTER TABLE checkouts
  ADD CONSTRAINT checkouts_carried_pair_sane
  CHECK (
    (functional_gross_cents IS NULL AND functional_fee_cents IS NULL)
    OR (functional_gross_cents > 0 AND functional_fee_cents >= 0)
  );

--------------------------------------------------------------------------------
-- What the bank actually received, and the rate on the day it landed.
--
-- Phase 129's shape and Phase 129's reason: a posting records the rate it used,
-- so the nightly check and the entry read one stored fact instead of asking a
-- growing table the same question twice and getting two answers.

ALTER TABLE payouts
  ADD COLUMN rate_millionths bigint,
  ADD COLUMN functional_amount_cents bigint;

ALTER TABLE payouts
  ADD CONSTRAINT payouts_rate_pair_sane
  CHECK (
    (rate_millionths IS NULL AND functional_amount_cents IS NULL)
    OR (rate_millionths > 0 AND functional_amount_cents IS NOT NULL)
  );

--------------------------------------------------------------------------------
-- Backfill: what the ledger contains, not what it should have contained.
--
-- Phase 127's rule, and Phase 129's reason for keeping it. Asking the rate
-- table what it would say today would overwrite the evidence of the defect,
-- and the evidence is the thing worth being able to see.
--
-- Every row written before this phase posted its face figure to the clearing
-- account, whatever currency it was in. So the functional figures ARE the face
-- figures for existing rows — for a domestic company because they are genuinely
-- equal, and for a foreign checkout because that is exactly the damage. Writing
-- them down makes the damage visible to a check rather than leaving it as an
-- absence.

UPDATE checkouts
SET functional_gross_cents = gross_cents,
    functional_fee_cents = fee_cents
WHERE functional_gross_cents IS NULL
  AND gross_cents > 0;

UPDATE payouts
SET functional_amount_cents = amount_cents,
    rate_millionths = 1000000
WHERE functional_amount_cents IS NULL;
