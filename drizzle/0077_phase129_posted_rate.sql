-- Phase 129: the rate a bank transaction posted at.
--
-- `bank_transactions` was the only money reaching the ledger with no rate
-- beside it. Phase 128 had `buildLines` derive one to post and `cashTieOut`
-- derive one to check, independently, from a table that grows — and `rateFor`
-- walks backwards to the most recent rate on or before a date, so entering a
-- rate for a day that did not have one changes what an older question
-- resolves to. The check then disagreed with a correct ledger, and
-- re-categorising silently re-posted the transaction at the new answer.

ALTER TABLE bank_transactions
  ADD COLUMN rate_millionths bigint,
  ADD COLUMN functional_amount_cents bigint;

-- Both or neither. A functional amount with no rate cannot be checked against
-- anything, and a rate with no functional amount was never used for a posting.
-- A stored rate is always positive: zero would post a real bank movement as
-- nothing at all, and only a corrupted write could produce it.
ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_rate_pair_sane
  CHECK (
    (rate_millionths IS NULL AND functional_amount_cents IS NULL)
    OR (rate_millionths > 0 AND functional_amount_cents IS NOT NULL)
  );

--------------------------------------------------------------------------------
-- Backfill: what the ledger contains, not what it should have contained.
--
-- Phase 127's rule for a backfill, and the only honest source here. Asking the
-- rate table what it would say today gives the answer this phase exists to stop
-- using — and it would overwrite the evidence of Phase 128's defect, which is
-- the thing worth being able to see.
--
-- So the functional amount is read off the journal entry the transaction
-- actually produced: the line on the bank account's own ledger account, whose
-- magnitude is what the books took for that movement. The rate is then implied
-- by dividing it by the face amount. For a domestic row the two are equal and
-- the rate is exactly 1,000,000 — which is why this defect survived unnoticed.
-- For a foreign row posted before Phase 128 they are *also* equal, and that is
-- the damage, now written down where `banking.posted_at_face` can find it.
--------------------------------------------------------------------------------

WITH posted AS (
  SELECT
    e.source_id AS transaction_id,
    -- The bank's own GL line. A split transaction carries several category
    -- lines but exactly one bank line, so this is the whole movement either
    -- way, which is what the face amount is too.
    SUM(l.debit_cents + l.credit_cents) AS functional_magnitude
  FROM journal_entries e
  JOIN journal_lines l
    ON l.journal_entry_id = e.id
   AND l.company_id = e.company_id
  JOIN bank_transactions t
    ON t.id = e.source_id
   AND t.company_id = e.company_id
  JOIN financial_accounts fa
    ON fa.id = t.financial_account_id
   AND l.chart_account_id = fa.chart_account_id
  WHERE e.source_type = 'bank_transaction'
    AND e.voided_at IS NULL
    AND e.status = 'posted'
  GROUP BY e.source_id
)
UPDATE bank_transactions t
SET
  -- Signed back the way the statement reads it, so face and functional agree
  -- on direction and the implied rate comes out positive.
  functional_amount_cents = CASE
    WHEN t.amount_cents < 0 THEN -posted.functional_magnitude
    ELSE posted.functional_magnitude
  END,
  rate_millionths = GREATEST(
    1,
    ROUND((posted.functional_magnitude * 1000000.0) / ABS(t.amount_cents))
  )
FROM posted
WHERE posted.transaction_id = t.id
  AND t.amount_cents <> 0
  AND posted.functional_magnitude > 0;

--------------------------------------------------------------------------------
-- The other leg of a transfer.
--
-- `syncLedgerForTransferPair` writes one entry, sourced on the outgoing
-- transaction, so the incoming one has no entry of its own to read. Phase 128
-- refuses a transfer between accounts in different currencies, so both legs are
-- the same money at the same rate by construction — the pair may be copied.
--------------------------------------------------------------------------------

UPDATE bank_transactions t
SET
  rate_millionths = pair.rate_millionths,
  functional_amount_cents = CASE
    WHEN t.amount_cents < 0 THEN -ABS(pair.functional_amount_cents)
    ELSE ABS(pair.functional_amount_cents)
  END
FROM bank_transactions pair
WHERE t.transfer_pair_id = pair.id
  AND t.company_id = pair.company_id
  AND t.rate_millionths IS NULL
  AND pair.rate_millionths IS NOT NULL
  AND t.amount_cents <> 0;
