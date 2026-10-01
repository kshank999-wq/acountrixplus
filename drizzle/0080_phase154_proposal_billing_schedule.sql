-- Phase 154: the invoice schedule spec §6 asks for.
--
-- "Won proposal can create a client, job/project, contract, **invoice
-- schedule**, and accounting dimensions without re-entry." `crm/conversion.ts`
-- quotes that sentence in its own doc comment. What it had was one invoice for
-- the whole proposal, dated the day of conversion — so a $500,000 contract
-- invoiced the client the entire contract value on signing day, before any work
-- was done.
--
-- And no screen could reach it: `pipeline-board.tsx` calls
-- `convertAction(id, false)` with the flag hardcoded, so the only
-- `createInvoice: true` in the repository was one test, which asserted the
-- whole-contract invoice as correct.
--
-- ## A row per stage, not columns on the proposal
--
-- A schedule is several stages and each has its own label, share and kind, so
-- columns cannot hold it — the same argument that keeps `receivePledge` blocked
-- on `PENDING_WIRING` since Phase 136, where a single rate column would be right
-- for the first instalment and wrong for the second.
--
-- ## Why `kind` and not just an order
--
-- Because a deposit is not a milestone, and the difference is whether the money
-- has been earned. A milestone bills work: revenue when billed, and a line on
-- the job's schedule of values. A deposit is money taken *before* any work, held
-- as a liability until it is earned — `2500 Unearned Revenue`, whose entry in
-- the chart of accounts already says exactly that. Phase 153 drew the same
-- distinction one module over: does this act create the balance it posts
-- against, or relieve one?

CREATE TABLE proposal_schedule_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,

  -- What the client sees on the proposal and on the invoice it raises.
  label text NOT NULL,

  -- deposit | milestone | on-completion. Text rather than an enum: the three are
  -- declared in `StageKind` with an argument apiece, and a fourth should be
  -- argued there rather than added by a migration nobody reads.
  kind text NOT NULL,

  -- Basis points of the contract. 5000 is half. The stages of one proposal must
  -- come to 10000, which `scheduleStands` refuses rather than the database,
  -- because the refusal is a sentence somebody editing a proposal has to read
  -- and a CHECK across rows cannot be one.
  percent_bp integer NOT NULL,

  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- A share is a whole number of basis points and never negative. A credit
  -- belongs on a credit note, not in a billing schedule.
  CONSTRAINT proposal_schedule_stages_share_sane CHECK (percent_bp >= 0 AND percent_bp <= 10000),
  CONSTRAINT proposal_schedule_stages_kind_known
    CHECK (kind IN ('deposit', 'milestone', 'on-completion')),
  CONSTRAINT proposal_schedule_stages_labelled CHECK (btrim(label) <> '')
);

-- Read per proposal, in order, every time one is shown or converted.
CREATE INDEX proposal_schedule_stages_proposal_idx
  ON proposal_schedule_stages (company_id, proposal_id, sort_order);

-- At most one deposit and one final stage per proposal, enforced here as well as
-- in `scheduleStands`.
--
-- Not redundant: the core refuses the schedule a person is editing, and this
-- refuses the row whatever wrote it. Two deposits is two liabilities to relieve
-- with nothing saying which a later invoice draws down first, and two stages
-- both billed on completion is a job billed twice for its last payment — neither
-- is the kind of thing to leave to one layer.
CREATE UNIQUE INDEX proposal_schedule_stages_one_deposit
  ON proposal_schedule_stages (proposal_id)
  WHERE kind = 'deposit';

CREATE UNIQUE INDEX proposal_schedule_stages_one_completion
  ON proposal_schedule_stages (proposal_id)
  WHERE kind = 'on-completion';

--------------------------------------------------------------------------------
-- No backfill, and that is a statement rather than an omission.
--
-- Every proposal written before this phase has no schedule, and giving them one
-- would be inventing payment terms nobody agreed to. A proposal with no stages
-- is a proposal billed the way it always was: in full, when somebody raises the
-- invoice by hand. `convertWonOpportunity` says so rather than guessing.
