-- Phase 157: the row a pledge receipt needed.
--
-- `PENDING_WIRING` has carried `mayPostToBank` since Phase 136 and is down to one
-- target. Phase 153 cleared three of its four by adding columns, and said in
-- those words why this one could not go with them:
--
--   A pledge is received in instalments -- `received_cents` accumulates and the
--   function refuses more than is outstanding -- so each receipt has its own day
--   and its own rate, and there is no row for a receipt to carry them on. Phase
--   129's rule is that a posting records the rate it used; a single
--   `exchange_rate_millionths` on `contributions` would be right for the first
--   instalment and quietly wrong for the second.
--
-- That is why `a row` was argued as a blocker distinct from `a field` rather
-- than bending the nearest one (Phase 130). This is the row.
--
-- ## The live defect it closes
--
-- `receivePledge` refuses a foreign bank account outright, so a fund keeping a
-- euro account has to record a donor's receipt against a home-currency account
-- the money did not go into, or not record it at all. Measured: `contributions`
-- carries no currency and no rate, and the gate declines anything but the
-- company's own money.

CREATE TABLE contribution_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,

  -- When this instalment arrived. Its own date, which is the whole reason this
  -- is a row: two instalments of one pledge are two days and two rates.
  received_on date NOT NULL,

  -- What the donor actually sent, in `currency`, and the rate it was posted at.
  -- Phase 129: a posting records the rate it used, so a receipt reconciled six
  -- months later is reconciled against the rate it was actually posted at and
  -- not against whatever the rate table says by then.
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  exchange_rate_millionths bigint NOT NULL,

  -- What it was worth in the books -- `convert(amount_cents, rate)`, stored
  -- rather than recomputed. Phase 156's lesson, one phase old: a figure that
  -- describes a recorded event must not be derived from an input that can move.
  functional_cents bigint NOT NULL,

  -- Where it was banked, and the entry that posted it.
  financial_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,

  memo text,
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- A receipt is money arriving; nothing arrives as nothing or as a negative.
  -- A refund of a pledge receipt is its own act and not a negative instalment.
  CONSTRAINT contribution_receipts_positive CHECK (amount_cents > 0 AND functional_cents > 0),
  CONSTRAINT contribution_receipts_rate_positive CHECK (exchange_rate_millionths > 0)
);

-- Read per contribution, in date order, every time a pledge is shown or its
-- outstanding balance is worked out.
CREATE INDEX contribution_receipts_contribution_idx
  ON contribution_receipts (company_id, contribution_id, received_on);

--------------------------------------------------------------------------------
-- No backfill, and that is a statement.
--
-- `contributions.received_cents` holds what has arrived on pledges recorded
-- before this migration, and it is a sum with no instalments behind it: nobody
-- wrote down which days or which amounts made it up. Inventing one receipt for
-- the whole of it would assert a date and a rate that nothing recorded, which is
-- the Phase 127 rule -- write down what the ledger contains, not what it should
-- have contained.
--
-- So `received_cents` stays as the running total it has always been, and the
-- receipts explain it from here on. `receiptsExplainReceived` is the check that
-- says which pledges have receipts behind them and which are carrying history,
-- rather than a claim that all of them do.
