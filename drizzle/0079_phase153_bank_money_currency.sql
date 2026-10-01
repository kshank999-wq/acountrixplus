-- Phase 153: the field four paths were waiting for.
--
-- `BANK_POSTINGS` has recorded four paths as `withheld: 'no-field'` since Phase
-- 136, and `PENDING_WIRING` has carried them as its one blocked entry since,
-- with `acceptance: null` because a test written against a column that does not
-- exist would be fiction. These are two of the three columns.
--
-- The refusal they caused was honest and it was total: a business banking in
-- euros could not remit a payroll or sales tax liability, nor hold and return a
-- tenancy deposit, through that account at all. Nothing recorded what currency
-- the money was in, so `mayPostToBank` refused rather than assert a
-- home-currency figure against an account that moves in something else.
--
-- ## Why a rate column and not just a currency
--
-- Phase 129's rule, in Phase 129's words: a posting records the rate it used,
-- so the nightly check and the entry read one stored fact instead of asking a
-- growing table the same question twice and getting two answers. `rateFor`
-- answers from a table the company keeps adding to; a remittance reconciled six
-- months later must be reconciled against the rate it was actually posted at.
--
-- ## Why `contributions` is not here
--
-- `receivePledge` is the fourth path and it stays blocked, with its blocker
-- sharpened rather than cleared. A pledge is received in instalments —
-- `received_cents` accumulates and the function refuses more than is
-- outstanding — so each receipt has its own day and its own rate, and there is
-- no row for a receipt to carry them on. A single `exchange_rate_millionths` on
-- `contributions` would be right for the first instalment and quietly wrong for
-- the second, which is worse than the refusal it replaced.

--------------------------------------------------------------------------------
-- What the bank actually moved, and at what rate.
--
-- ## `amount_cents` does not change meaning
--
-- It is the figure the **ledger balance** moves by, in the company's own money,
-- and it was that before this migration. A remittance clears a liability
-- accrued in home currency; a deposit movement credits or debits a liability
-- carried in home currency. That side was never the problem.
--
-- What was missing is the other side. `bank_face_cents` is what left or entered
-- the account, in `currency`, and `exchange_rate_millionths` is the rate it was
-- posted at — so the two sides of the entry can differ by a realised gain
-- instead of being forced to be one number.
--
-- Three columns rather than two, and the third is why. A single `currency`
-- beside `amount_cents` would have read as "this figure is in euros", which is
-- the opposite of true and is the reading that produces the defect: a face
-- amount compared against a ledger balance in another currency, which is
-- exactly what Phase 152 repaired in `contractorPayments`.

ALTER TABLE tax_remittances
  ADD COLUMN bank_face_cents bigint,
  ADD COLUMN currency text,
  ADD COLUMN exchange_rate_millionths bigint;

-- All three or none. A face amount with no currency does not say what it is,
-- and a currency with no rate cannot be converted for the ledger.
ALTER TABLE tax_remittances
  ADD CONSTRAINT tax_remittances_bank_face_sane
  CHECK (
    (bank_face_cents IS NULL AND currency IS NULL AND exchange_rate_millionths IS NULL)
    OR (bank_face_cents > 0 AND currency IS NOT NULL AND exchange_rate_millionths > 0)
  );

ALTER TABLE deposit_movements
  ADD COLUMN bank_face_cents bigint,
  ADD COLUMN currency text,
  ADD COLUMN exchange_rate_millionths bigint;

ALTER TABLE deposit_movements
  ADD CONSTRAINT deposit_movements_bank_face_sane
  CHECK (
    (bank_face_cents IS NULL AND currency IS NULL AND exchange_rate_millionths IS NULL)
    OR (bank_face_cents > 0 AND currency IS NOT NULL AND exchange_rate_millionths > 0)
  );

--------------------------------------------------------------------------------
-- Backfill: the identity rate, because that is what these rows posted.
--
-- Phase 127's rule — write down what the ledger contains, not what it should
-- have contained — and unlike Phase 134's backfill this one records no damage,
-- because there is none to record. Every row that exists was posted through a
-- gate that refused any account not held in the company's own money, so every
-- one of them *is* home currency at the identity rate. The absence of a defect
-- here is itself a consequence of the refusal this phase lifts.
--
-- The currency is read from the company rather than typed, so a company whose
-- books are kept in euros does not get rows claiming dollars.

UPDATE tax_remittances r
SET bank_face_cents = r.amount_cents,
    currency = c.currency,
    exchange_rate_millionths = 1000000
FROM companies c
WHERE c.id = r.company_id
  AND r.currency IS NULL;

UPDATE deposit_movements m
SET bank_face_cents = m.amount_cents,
    currency = c.currency,
    exchange_rate_millionths = 1000000
FROM companies c
WHERE c.id = m.company_id
  AND m.currency IS NULL;
