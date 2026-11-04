-- Phase 184: the record that was deleted.
--
-- ADR 0183 nominated converting `document_links` away from twelve keyless
-- polymorphic subject references. Two things the measurement found:
--
-- **It is two tables, not one.** `record_notes` has the identical shape —
-- `subject_type` enum plus a bare `subject_id` — so it is twenty-four keyless
-- references, and the one carrying an accountant's own words is the second.
--
-- **The weakness is not theoretical.** `modules/evidence/subjects.ts` argues
-- the shape is acceptable because the check lives in code:
--
--   > It is the whole reason a missing foreign key is acceptable: the check
--   > that a constraint would do is done here, under the tenant filter, before
--   > anything is written.
--
-- True, and it accounts for one of a foreign key's two guarantees. The other
-- is what happens when the referenced row is **deleted**, and nothing did it.
--
-- `discardDraftEntry` deletes a draft journal entry. Its comment reads *"Lines
-- cascade"* — true, through a real foreign key, and incomplete: the working
-- paper's link and the accountant's question survived the entry and pointed at
-- a uuid that no longer existed. `openQuestions` is the company-wide work list
-- and reads `record_notes` with no join to the subject, so an orphaned question
-- sat on an accountant's list forever; typing an answer called `writeNote`,
-- which called `requireSubject`, which threw — inside the transaction that had
-- just marked it resolved. So the item could not be cleared with an answer and
-- could be cleared without one.
--
-- Three more paths are latent in the schema rather than reachable from a
-- screen: `bank_transactions` and `reconciliations` cascade from
-- `financial_accounts`, and `proposal_versions` cascades from `proposals`. The
-- day somebody writes "remove this bank connection" — an ordinary screen to
-- want — every receipt on every transaction in it becomes an orphan. They are
-- fixed here too, because the fix is the same one.
--
-- ## One identity table, not twenty-four columns
--
-- Phase 180's `asset_links` carries one nullable column per subject with a
-- CHECK that exactly one is set, and five composite foreign keys. Scaled
-- directly to here that is twelve columns on each of two tables, twenty-four
-- foreign keys, and the next consumer makes thirty-six.
--
-- So the exclusive arc goes in **one** table. `evidence_subjects` holds the
-- twelve columns and the CHECK; `document_links` and `record_notes` each get a
-- single composite foreign key to it, `ON DELETE CASCADE`. A third consumer
-- costs one foreign key rather than twelve columns, which matters because
-- `subjects.ts` already says attaching, detaching, reading and noting all go
-- through one register.
--
-- ## `subject_type` and `subject_id` are generated
--
-- The obvious version of this table carries the twelve columns *and* a
-- `subject_type`/`subject_id` pair for the link tables to reference, and then
-- there are two answers to one question and a trigger or a CHECK per kind to
-- keep them agreeing. Two of these were written and both were worse than the
-- problem.
--
-- `GENERATED ALWAYS AS … STORED` settles it: the twelve columns are the only
-- place the truth lives, the pair is derived from them by the database, and a
-- stored generated column can carry a primary key and be a foreign key's
-- target. Measured before it was written, because a generation expression must
-- be immutable and `'invoice'::evidence_subject` is a cast of a literal.
--
-- The primary key does one more thing for free: a generated column that
-- resolves to NULL cannot be in it, so a row with **no** kind set is refused by
-- the key rather than needing its own CHECK.
--
-- ## What the database now refuses that it did not
--
-- 1. A link or note whose subject does not exist.
-- 2. A link or note whose subject belongs to another company — which was only
--    ever stopped by a function somebody had to remember to call.
-- 3. A link or note naming the **wrong kind** for a real id: `subject_type =
--    'bill'` with an invoice's uuid was storable and nothing noticed.
-- 4. A subject row claiming to be two kinds at once.
-- 5. Evidence outliving the record it is evidence of.

-- ---------------------------------------------------------------------------
-- 0. The enum, rebuilt — and why this section exists.
--
-- The generated column below casts twelve literals to `evidence_subject`, and
-- on a **fresh** deployment that failed:
--
--   ERROR:  unsafe use of new value "proposal_version" of enum type evidence_subject
--   HINT:   New enum values must be committed before they can be used.
--
-- `db:migrate` wraps every migration in one transaction, deliberately, so a
-- failure anywhere rolls the whole deployment back (`docs/DEPLOY.md`).
-- PostgreSQL refuses to *use* an enum label added by `ALTER TYPE … ADD VALUE`
-- in an uncommitted transaction — and migration 0021 added `proposal_version`
-- that way. The rule is per **label**, not per type: a label from the original
-- `CREATE TYPE` is safe in the same transaction, one from a later ADD VALUE is
-- not, and measuring that distinction is what found the fix.
--
-- It applied cleanly to a database where the enum was already committed, which
-- is every database that exists. It would have failed on the first fresh
-- deployment and nowhere before it. Caught by rebuilding the development
-- database from the migrations rather than by running the tests — Phase 179's
-- lesson arriving through a different door.
--
-- So the type is rebuilt here, once, with all twelve labels from one
-- `CREATE TYPE`. That is not a workaround kept at arm's length: it removes the
-- ADD VALUE from the chain's effective history, so the next phase that needs an
-- enum label in an expression does not meet this at all.
-- ---------------------------------------------------------------------------

CREATE TYPE evidence_subject_rebuilt AS ENUM (
  'bank_transaction',
  'journal_entry',
  'invoice',
  'bill',
  'payment',
  'fixed_asset',
  'reconciliation',
  'payroll_run',
  'expense',
  'customer',
  'vendor',
  'proposal_version'
);

/*
  The two columns that use it. `::text::` and not a direct cast, because there
  is no assignment cast between two enum types — and the text in between is the
  label, which is the same in both by construction. Indexes and the unique
  constraint on these columns are rebuilt by PostgreSQL.
*/
ALTER TABLE document_links
  ALTER COLUMN subject_type TYPE evidence_subject_rebuilt
  USING subject_type::text::evidence_subject_rebuilt;

ALTER TABLE record_notes
  ALTER COLUMN subject_type TYPE evidence_subject_rebuilt
  USING subject_type::text::evidence_subject_rebuilt;

DROP TYPE evidence_subject;
ALTER TYPE evidence_subject_rebuilt RENAME TO evidence_subject;

-- ---------------------------------------------------------------------------
-- 1. The target half: ten of the twelve subject tables had no tenant key.
--
-- `bank_transactions` (Phase 177) and `customers` (Phase 170) already carry
-- one. The other ten are added here rather than in ten migrations, because a
-- composite foreign key cannot be written without its target and the twelve
-- are one piece of work.
-- ---------------------------------------------------------------------------

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_company_id_key UNIQUE (company_id, id);
ALTER TABLE invoices
  ADD CONSTRAINT invoices_company_id_key UNIQUE (company_id, id);
ALTER TABLE bills
  ADD CONSTRAINT bills_company_id_key UNIQUE (company_id, id);
ALTER TABLE payments
  ADD CONSTRAINT payments_company_id_key UNIQUE (company_id, id);
ALTER TABLE fixed_assets
  ADD CONSTRAINT fixed_assets_company_id_key UNIQUE (company_id, id);
ALTER TABLE reconciliations
  ADD CONSTRAINT reconciliations_company_id_key UNIQUE (company_id, id);
ALTER TABLE payroll_runs
  ADD CONSTRAINT payroll_runs_company_id_key UNIQUE (company_id, id);
ALTER TABLE billable_expenses
  ADD CONSTRAINT billable_expenses_company_id_key UNIQUE (company_id, id);
ALTER TABLE vendors
  ADD CONSTRAINT vendors_company_id_key UNIQUE (company_id, id);
ALTER TABLE proposal_versions
  ADD CONSTRAINT proposal_versions_company_id_key UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 2. The identity table.
-- ---------------------------------------------------------------------------

CREATE TABLE evidence_subjects (
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,

  /*
    One column per kind, and the order is `EVIDENCE_SUBJECTS`' order so the
    register and the table can be read side by side. Every one is
    `ON DELETE CASCADE` to the record: that single word is the defect's fix,
    and it is written twelve times here instead of once in a function that
    every future delete path would have to remember to call.
  */
  bank_transaction_id uuid,
  journal_entry_id uuid,
  invoice_id uuid,
  bill_id uuid,
  payment_id uuid,
  fixed_asset_id uuid,
  reconciliation_id uuid,
  payroll_run_id uuid,
  expense_id uuid,
  customer_id uuid,
  vendor_id uuid,
  proposal_version_id uuid,

  /*
    Derived, not stored twice. The twelve columns above are the only place a
    subject's identity lives; these two are the database's own reading of them,
    so a row cannot say `invoice` while holding a bill's id.
  */
  subject_type evidence_subject GENERATED ALWAYS AS (
    CASE
      WHEN bank_transaction_id IS NOT NULL THEN 'bank_transaction'::evidence_subject
      WHEN journal_entry_id    IS NOT NULL THEN 'journal_entry'::evidence_subject
      WHEN invoice_id          IS NOT NULL THEN 'invoice'::evidence_subject
      WHEN bill_id             IS NOT NULL THEN 'bill'::evidence_subject
      WHEN payment_id          IS NOT NULL THEN 'payment'::evidence_subject
      WHEN fixed_asset_id      IS NOT NULL THEN 'fixed_asset'::evidence_subject
      WHEN reconciliation_id   IS NOT NULL THEN 'reconciliation'::evidence_subject
      WHEN payroll_run_id      IS NOT NULL THEN 'payroll_run'::evidence_subject
      WHEN expense_id          IS NOT NULL THEN 'expense'::evidence_subject
      WHEN customer_id         IS NOT NULL THEN 'customer'::evidence_subject
      WHEN vendor_id           IS NOT NULL THEN 'vendor'::evidence_subject
      WHEN proposal_version_id IS NOT NULL THEN 'proposal_version'::evidence_subject
    END
  ) STORED,

  subject_id uuid GENERATED ALWAYS AS (
    coalesce(
      bank_transaction_id, journal_entry_id, invoice_id, bill_id, payment_id,
      fixed_asset_id, reconciliation_id, payroll_run_id, expense_id,
      customer_id, vendor_id, proposal_version_id
    )
  ) STORED,

  /*
    The key the two link tables reference, on generated columns.

    `company_id` leads it, so a reference into this table carries the tenant by
    construction — Phase 170's device, reached once for twelve kinds instead of
    twelve times for two consumers. And because a primary key cannot hold a
    NULL, a row with no kind set is refused by the key itself.
  */
  CONSTRAINT evidence_subjects_pkey PRIMARY KEY (company_id, subject_type, subject_id),

  -- Exactly one, counted rather than described: a row that is two kinds is a
  -- row whose `subject_type` would be a coin toss.
  CONSTRAINT evidence_subjects_one_kind_check CHECK (
    (bank_transaction_id IS NOT NULL)::int
      + (journal_entry_id    IS NOT NULL)::int
      + (invoice_id          IS NOT NULL)::int
      + (bill_id             IS NOT NULL)::int
      + (payment_id          IS NOT NULL)::int
      + (fixed_asset_id      IS NOT NULL)::int
      + (reconciliation_id   IS NOT NULL)::int
      + (payroll_run_id      IS NOT NULL)::int
      + (expense_id          IS NOT NULL)::int
      + (customer_id         IS NOT NULL)::int
      + (vendor_id           IS NOT NULL)::int
      + (proposal_version_id IS NOT NULL)::int
      = 1
  ),

  CONSTRAINT evidence_subjects_bank_transaction_fkey
    FOREIGN KEY (company_id, bank_transaction_id)
    REFERENCES bank_transactions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_journal_entry_fkey
    FOREIGN KEY (company_id, journal_entry_id)
    REFERENCES journal_entries (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_invoice_fkey
    FOREIGN KEY (company_id, invoice_id)
    REFERENCES invoices (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_bill_fkey
    FOREIGN KEY (company_id, bill_id)
    REFERENCES bills (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_payment_fkey
    FOREIGN KEY (company_id, payment_id)
    REFERENCES payments (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_fixed_asset_fkey
    FOREIGN KEY (company_id, fixed_asset_id)
    REFERENCES fixed_assets (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_reconciliation_fkey
    FOREIGN KEY (company_id, reconciliation_id)
    REFERENCES reconciliations (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_payroll_run_fkey
    FOREIGN KEY (company_id, payroll_run_id)
    REFERENCES payroll_runs (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_expense_fkey
    FOREIGN KEY (company_id, expense_id)
    REFERENCES billable_expenses (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_customer_fkey
    FOREIGN KEY (company_id, customer_id)
    REFERENCES customers (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_vendor_fkey
    FOREIGN KEY (company_id, vendor_id)
    REFERENCES vendors (company_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subjects_proposal_version_fkey
    FOREIGN KEY (company_id, proposal_version_id)
    REFERENCES proposal_versions (company_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE evidence_subjects IS
  'The exclusive arc for what may carry evidence (§13). One row per record that has a document or a note on it; `document_links` and `record_notes` reference its generated (company_id, subject_type, subject_id) key, so evidence cannot outlive, or cross companies from, the record it is evidence of.';

ALTER TABLE evidence_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_subjects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON evidence_subjects;
CREATE POLICY tenant_isolation ON evidence_subjects
  FOR ALL TO accountrix_app
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_subjects TO accountrix_app;

-- ---------------------------------------------------------------------------
-- 3. Backfill, and the orphans.
--
-- One row per distinct subject that carries a link or a note today. A single
-- INSERT with twelve CASE arms rather than twelve INSERTs: the arms are the
-- same twelve names in the same order as the columns above and the register in
-- `subjects.ts`, so the three lists can be read against each other.
--
-- Rows whose subject no longer exists cannot be backfilled — the foreign key
-- that is the point of this migration refuses them — so they are deleted
-- first, and the counts are raised as a notice rather than swallowed. Every one
-- is a document link nothing could reach or a question nobody could answer;
-- that is the data the new constraint declares impossible. The notice is there
-- because a migration that silently dropped evidence would be a worse defect
-- than the one it is fixing, and on a database with no orphans it prints two
-- zeroes, which is the answer worth having in writing.
-- ---------------------------------------------------------------------------

CREATE TEMPORARY VIEW live_subjects AS
            SELECT company_id, 'bank_transaction'::evidence_subject AS subject_type, id AS subject_id FROM bank_transactions
  UNION ALL SELECT company_id, 'journal_entry',    id FROM journal_entries
  UNION ALL SELECT company_id, 'invoice',          id FROM invoices
  UNION ALL SELECT company_id, 'bill',             id FROM bills
  UNION ALL SELECT company_id, 'payment',          id FROM payments
  UNION ALL SELECT company_id, 'fixed_asset',      id FROM fixed_assets
  UNION ALL SELECT company_id, 'reconciliation',   id FROM reconciliations
  UNION ALL SELECT company_id, 'payroll_run',      id FROM payroll_runs
  UNION ALL SELECT company_id, 'expense',          id FROM billable_expenses
  UNION ALL SELECT company_id, 'customer',         id FROM customers
  UNION ALL SELECT company_id, 'vendor',           id FROM vendors
  UNION ALL SELECT company_id, 'proposal_version', id FROM proposal_versions;

DO $$
DECLARE
  orphan_links integer;
  orphan_notes integer;
BEGIN
  DELETE FROM document_links l
  WHERE NOT EXISTS (
    SELECT 1 FROM live_subjects v
    WHERE v.company_id = l.company_id
      AND v.subject_type = l.subject_type
      AND v.subject_id = l.subject_id
  );
  GET DIAGNOSTICS orphan_links = ROW_COUNT;

  DELETE FROM record_notes n
  WHERE NOT EXISTS (
    SELECT 1 FROM live_subjects v
    WHERE v.company_id = n.company_id
      AND v.subject_type = n.subject_type
      AND v.subject_id = n.subject_id
  );
  GET DIAGNOSTICS orphan_notes = ROW_COUNT;

  RAISE NOTICE 'Phase 184: deleted % orphaned document link(s) and % orphaned note(s), whose subject no longer existed.',
    orphan_links, orphan_notes;
END $$;

INSERT INTO evidence_subjects (
  company_id,
  bank_transaction_id, journal_entry_id, invoice_id, bill_id, payment_id,
  fixed_asset_id, reconciliation_id, payroll_run_id, expense_id,
  customer_id, vendor_id, proposal_version_id
)
SELECT DISTINCT
  s.company_id,
  CASE WHEN s.subject_type = 'bank_transaction' THEN s.subject_id END,
  CASE WHEN s.subject_type = 'journal_entry'    THEN s.subject_id END,
  CASE WHEN s.subject_type = 'invoice'          THEN s.subject_id END,
  CASE WHEN s.subject_type = 'bill'             THEN s.subject_id END,
  CASE WHEN s.subject_type = 'payment'          THEN s.subject_id END,
  CASE WHEN s.subject_type = 'fixed_asset'      THEN s.subject_id END,
  CASE WHEN s.subject_type = 'reconciliation'   THEN s.subject_id END,
  CASE WHEN s.subject_type = 'payroll_run'      THEN s.subject_id END,
  CASE WHEN s.subject_type = 'expense'          THEN s.subject_id END,
  CASE WHEN s.subject_type = 'customer'         THEN s.subject_id END,
  CASE WHEN s.subject_type = 'vendor'           THEN s.subject_id END,
  CASE WHEN s.subject_type = 'proposal_version' THEN s.subject_id END
FROM (
  SELECT company_id, subject_type, subject_id FROM document_links
  UNION
  SELECT company_id, subject_type, subject_id FROM record_notes
) s;

DROP VIEW live_subjects;

-- ---------------------------------------------------------------------------
-- 4. The key that makes it true.
--
-- `ON DELETE CASCADE` is the fix for the orphan. `ON UPDATE CASCADE` is for the
-- merge, and it was not in the first draft.
--
-- Registering `evidence_subjects.customer_id` with `PARTY_REFERENCES` made the
-- party-merge tripwire ask what a merge does to evidence, and the answer the
-- conversion makes possible is: repoint one identity row and the database moves
-- every document link and every note with it. Without `ON UPDATE CASCADE` that
-- update is refused while children reference the old key, and the merge would
-- have to walk both link tables by hand for the ordinary case as well as the
-- colliding one.
--
-- Before this phase the question could not even be asked. `subject_id` held the
-- customer's uuid with no key, so it was invisible to the catalogue tripwire —
-- which is why **every customer merge this application has ever performed left
-- the receipts and the notes on the losing record** — as long as the merge has
-- existed, which is since Phase 96.
-- ---------------------------------------------------------------------------

ALTER TABLE document_links
  ADD CONSTRAINT document_links_subject_fkey
  FOREIGN KEY (company_id, subject_type, subject_id)
  REFERENCES evidence_subjects (company_id, subject_type, subject_id)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE record_notes
  ADD CONSTRAINT record_notes_subject_fkey
  FOREIGN KEY (company_id, subject_type, subject_id)
  REFERENCES evidence_subjects (company_id, subject_type, subject_id)
  ON DELETE CASCADE ON UPDATE CASCADE;
