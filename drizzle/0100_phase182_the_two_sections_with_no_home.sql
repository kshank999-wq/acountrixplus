-- Phase 182: the two sections with no home, and the four with no reader.
--
-- §7 names twelve proposal components: *"cover, executive summary, scope,
-- deliverables, schedule, exclusions, assumptions, fee table, optional items,
-- terms, legal clauses, signature/acceptance."*
--
-- ADR 0173 measured ten of the twelve as having a dedicated block or column,
-- with `deliverables` and `assumptions` having neither. That measurement is
-- correct and it was generous, because measuring the *other* ten found
-- something worse.
--
-- ## The four narrative columns nothing renders
--
-- `proposals` carries `executive_summary`, `scope`, `exclusions` and `terms`.
-- They are written by `createProposal`, written by the AI draft, and
-- snapshotted into `proposal_versions.snapshot` so a sent proposal's wording is
-- frozen with its figures.
--
-- **Nothing renders them.** Not `document-render.tsx`, not `pdf/layout.ts`, not
-- `render-email.ts`, and there is no merge field for any of the four — the
-- `Proposal` merge-field group holds number, title, total, subtotal, date and
-- expiry, all figures and metadata.
--
-- The proposal templates make it look handled. They place a `heading` and a
-- `text` or `list` block with the ids `scope` and `exclusions`, filled with
-- placeholder prose — *"Describe what is included, in the order the work will
-- happen."* So an author types their scope into the proposal form, opens the
-- designer, finds a block telling them to describe their scope, and types it
-- again. The column keeps the first copy and the client reads the second.
--
-- That is Phase 49's rule at scale: a column with no reader is a field that
-- does not exist. Four of them, in the section of the specification with the
-- most components.
--
-- ## So two columns, and six merge fields
--
-- Adding `deliverables` and `assumptions` as two more columns of the same kind
-- would have been adding two more fields nothing renders — the nominated work,
-- done in the shape that made the nomination necessary.
--
-- The columns go in, matching the four exactly, and all **six** narrative
-- sections become merge fields: `{{proposal.scope}}`,
-- `{{proposal.deliverables}}` and the rest. The templates use them instead of
-- placeholder prose, so what the author typed is what the client reads, and the
-- mechanism is the one this engine already has for exactly this.
--
-- `text` not `jsonb`, nullable, no default — the same four decisions the
-- existing four made, because a fifth and sixth narrative section that behaved
-- differently from the first four would be a difference with no reason behind
-- it.

ALTER TABLE proposals
  ADD COLUMN deliverables text,
  ADD COLUMN assumptions text;

COMMENT ON COLUMN proposals.deliverables IS
  'What the client receives, as prose (§7). Reaches the document through {{proposal.deliverables}}.';

COMMENT ON COLUMN proposals.assumptions IS
  'What the price assumes to be true (§7). Reaches the document through {{proposal.assumptions}}.';
