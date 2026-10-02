-- Phase 155: billing a contract in stages, and recognising the deposit.
--
-- Phase 154 gave a proposal a billing schedule and made conversion raise the
-- deposit. It left two things that this closes:
--
--  1. **Nothing could bill a stage.** The milestones were written onto the job's
--     schedule of values, which is the construction path and needs the
--     `job_costing` module. A company without it had stages on a contract and no
--     way to invoice any of them — the capability described and not reachable,
--     which is Phase 49's rule.
--
--  2. **The deposit was never recognised.** It is credited to unearned revenue,
--     correctly, and nothing turned it into revenue when the work was done. Bill
--     every other stage and the revenue account holds 75% of a finished contract
--     with 25% in a liability for ever. ADR 0154 said so rather than leaving it
--     to look finished.

-- Which invoice billed this stage. Null until it is billed, which is what
-- `nextBillable` reads and what makes billing a stage twice refusable.
--
-- `set null` rather than `cascade`: voiding an invoice must not silently delete
-- the stage from the contract. The stage goes back to unbilled and somebody can
-- bill it again, which is the honest outcome — the contract did not change
-- because an invoice was voided.
ALTER TABLE proposal_schedule_stages
  ADD COLUMN invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;

-- One invoice per stage, and one stage per invoice. The second half is the one
-- worth enforcing: two stages pointing at one invoice would read as two stages
-- billed while the client was charged once.
CREATE UNIQUE INDEX proposal_schedule_stages_one_invoice
  ON proposal_schedule_stages (invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX proposal_schedule_stages_unbilled_idx
  ON proposal_schedule_stages (company_id, proposal_id, sort_order)
  WHERE invoice_id IS NULL;

--------------------------------------------------------------------------------
-- The entry that turned the deposit into revenue.
--
-- Recorded on the proposal rather than on a stage, because it is a fact about
-- the deposit and the deposit is one stage however many milestones there are.
-- Null until the last stage is billed; set once, which is what stops a second
-- recognition double-counting the revenue.

ALTER TABLE proposals
  ADD COLUMN deposit_recognised_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL;
