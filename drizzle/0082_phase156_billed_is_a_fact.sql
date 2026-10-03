-- Phase 156: what a billed stage was billed for.
--
-- Phase 155 made a contract's stages billable and left both of these, found by
-- measuring its own output rather than by taking its nomination.
--
-- ## A billed stage's amount was still being derived
--
-- `stageStates` computes every stage from the proposal's *current* total:
--
--     const priced = scheduleAmounts(proposal.totalCents, rows.map(…))
--
-- Right for a stage still to be billed, and wrong for one already invoiced,
-- whose amount is a fact. `loadProposal` carries no status guard — the won/lost
-- check lives in `sendProposal` — so `updateProposalItems` can edit a won
-- proposal and move `total_cents`. A $20,000 contract billed 25% and then edited
-- to $40,000 reports its first stage as $10,000 against a $5,000 invoice, and
-- `recogniseDeposit` then debits $10,000 out of unearned revenue against a
-- $5,000 credit — **driving the liability negative**.
--
-- One figure was answering two questions: what shall I bill, and what did I.
--
-- The answer is the one this codebase has given three times — `PAIRED_COLUMNS`,
-- Phase 153's `bank_face_cents`, and Phase 129's "a posting records the rate it
-- used". When a stage is billed, write down what it was billed for.

ALTER TABLE proposal_schedule_stages
  ADD COLUMN billed_cents bigint;

-- Both or neither. A stage with an invoice and no figure is the defect this
-- closes; a figure with no invoice is a stage claiming to have been billed.
ALTER TABLE proposal_schedule_stages
  ADD CONSTRAINT proposal_schedule_stages_billed_pair_sane
  CHECK (
    (invoice_id IS NULL AND billed_cents IS NULL)
    OR (invoice_id IS NOT NULL AND billed_cents > 0)
  );

--------------------------------------------------------------------------------
-- Backfill: what the invoice says, because that is what happened.
--
-- Phase 127's rule. Every stage billed before this migration has an invoice, and
-- the invoice's total **is** what the stage was billed for — one line, raised by
-- `billStage` for that stage alone. So this is not a reconstruction from today's
-- rates; it is reading the fact off the document that recorded it.
--
-- A stage whose invoice has since been deleted keeps a null `invoice_id` from the
-- `ON DELETE SET NULL` and so is skipped here, which is correct: it is unbilled
-- again and its amount is derived once more.

UPDATE proposal_schedule_stages s
SET billed_cents = i.total_cents
FROM invoices i
WHERE i.id = s.invoice_id
  AND s.billed_cents IS NULL;
