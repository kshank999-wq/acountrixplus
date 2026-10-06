-- Phase 174: a question from the client.
--
-- ADR 0173's bullet-level pass found §7 asking for *"comments/questions"* on the
-- client-facing proposal link with nothing behind it: the link tracks views and
-- takes an acceptance, and a client cannot ask a question through it.
--
-- ## Not a new table, and that is the decision
--
-- The obvious shape is `proposal_comments`. Measured against what the thing
-- *is*, that would be wrong twice over.
--
-- A question from a client is **one exchange with somebody outside the
-- company**, which is what `communications` already holds — and that table's own
-- docstring argues the case this migration needs:
--
--   A communication cannot [be polymorphic]. It is always with a *party* -- an
--   organization, one of its people, and optionally the deal being discussed --
--   and those are three foreign keys the database can actually enforce.
--
-- Putting a client's question anywhere else costs two things that matter:
--
--  1. **The client timeline.** `organizationTimeline` merges communications,
--     tasks and opportunity activity. A question in its own table would be
--     invisible there, so "what has happened with these people" would omit the
--     one thing the client actually said.
--  2. **The attention list.** Phase 167's `lastContactedAt` drives
--     `gone-quiet`, and it reads non-internal communications. A client who
--     asked a question nine days ago and got no answer is *exactly* a neglected
--     account — and with a separate table the account would read as quiet while
--     a question sat unanswered on it, which is the worst possible direction
--     for that list to be wrong in.
--
-- So this is two columns on `communications`, not a table.

ALTER TABLE communications
  -- The document being discussed. `set null` rather than cascade: deleting a
  -- proposal must not delete the record of what a client asked about it, for
  -- the same reason `customer_id` is `set null` on this table.
  ADD COLUMN proposal_id uuid,

  -- The question this answers. A thread two deep is what §7 asks for --
  -- "comments/questions" and an answer -- and nothing here needs arbitrary
  -- nesting, so `parent_id` is a reply pointer rather than a tree.
  --
  -- `set null` again: deleting a question should not delete the answer, which
  -- would leave the client having been answered and no record of it.
  ADD COLUMN parent_id uuid;

--------------------------------------------------------------------------------
-- Both references carry the tenant from the start.
--
-- Phase 172's rule, applied forward rather than retrofitted: a reference between
-- tenant-scoped tables is created composite, because converting 271 of them
-- afterwards is the programme this codebase is now carrying. `communications`
-- has `company_id NOT NULL`, which is the precondition Phase 172 established --
-- under `MATCH SIMPLE` a composite key on a nullable `company_id` is not checked
-- at all.
--
-- Writing it this way makes the reference count go up by two with the composite
-- count going up by two, which is the only shape of growth that does not add to
-- the backlog.

ALTER TABLE proposals
  ADD CONSTRAINT proposals_company_id_key UNIQUE (company_id, id);

ALTER TABLE communications
  ADD CONSTRAINT communications_company_id_key UNIQUE (company_id, id);

ALTER TABLE communications
  ADD CONSTRAINT communications_proposal_tenant_fk
  FOREIGN KEY (company_id, proposal_id) REFERENCES proposals (company_id, id)
  ON DELETE SET NULL (proposal_id);

ALTER TABLE communications
  ADD CONSTRAINT communications_parent_tenant_fk
  FOREIGN KEY (company_id, parent_id) REFERENCES communications (company_id, id)
  ON DELETE SET NULL (parent_id);

-- The thread, read per proposal and per parent. One index covers both, because
-- a reply is always read with the question it answers.
CREATE INDEX communications_proposal_idx
  ON communications (company_id, proposal_id, occurred_at);
