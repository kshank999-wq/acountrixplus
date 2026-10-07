-- Phase 178: the transaction the bank took back.
--
-- ADR 0177's nomination, and the last of Phase 176's three findings.
-- `/transactions/sync` returns `added`, `modified` **and `removed`**. Phase 177
-- fixed what happens to a modified one; a removed one still had nowhere to go,
-- because `TransactionPage` carried transactions and a cursor and had no way to
-- say "this one was retracted".
--
-- So the adapter read the field and dropped it, and a withdrawn transaction
-- stayed in the inbox. If it had been categorised, the books asserted an expense
-- for money that never moved — which is the one of the three findings that
-- leaves a *wrong row in the books* rather than merely a slow sync.
--
-- ## One table, one log
--
-- `bank_transaction_revisions` already records every change a feed made to a
-- transaction it had sent, applied ones included. A withdrawal is such a change,
-- so it belongs here rather than in a second table — the alternative is two
-- places to look for "what has the bank said about this row", which is the
-- defect this project keeps naming.
--
-- The name stays. A retraction *is* a revision to the record; what it revises is
-- whether the transaction exists.
--
-- ## Why the CHECK
--
-- A withdrawal carries no new figures. Plaid's `removed` gives a transaction id
-- and nothing else, so the new-value columns are copied from the stored row and
-- are equal to the previous ones by construction.
--
-- Stated as a constraint because "by construction" is a property of today's
-- writer. Without it, a future one could smuggle a figure change in under
-- `kind = 'retraction'` and bypass the whole revision path — the holds, the
-- re-post, the closed-period refusal.

CREATE TYPE feed_change_kind AS ENUM ('revision', 'retraction');

COMMENT ON TYPE feed_change_kind IS
  'revision: the bank sent different figures. retraction: the bank withdrew the transaction — a pending authorisation that never captured, or a charge reversed at source.';

-- Defaulted for the backfill, because every row written before this phase is a
-- revision by definition. The default is then **dropped**: a writer that does
-- not say which kind it means is a writer that has not thought about it, and
-- `kind` decides which remedy a person is shown.
ALTER TABLE bank_transaction_revisions
  ADD COLUMN kind feed_change_kind NOT NULL DEFAULT 'revision';

ALTER TABLE bank_transaction_revisions
  ALTER COLUMN kind DROP DEFAULT;

-- The dedup unique has to include the kind, and the reason is a real collision
-- rather than tidiness: a revision applied at -4420 and a *later withdrawal* of
-- that same transaction carry identical figures — the retraction copies them —
-- so without `kind` in the key the withdrawal would conflict with the applied
-- revision and `ON CONFLICT DO NOTHING` would silently drop it. The feed would
-- have said "this never happened" and the log would have said nothing.
ALTER TABLE bank_transaction_revisions
  DROP CONSTRAINT bank_transaction_revisions_unique;

ALTER TABLE bank_transaction_revisions
  ADD CONSTRAINT bank_transaction_revisions_unique
  UNIQUE (company_id, bank_transaction_id, kind, amount_cents, posted_date, pending);

ALTER TABLE bank_transaction_revisions
  ADD CONSTRAINT bank_transaction_revisions_retraction_check CHECK (
    kind <> 'retraction'
    OR (
      amount_cents = previous_amount_cents
      AND posted_date = previous_posted_date
      AND pending = previous_pending
    )
  );

COMMENT ON TABLE bank_transaction_revisions IS
  'Append-only log of every change a bank feed made to a transaction it had already sent — a revision of its figures, or a withdrawal of the transaction itself. Applied when nothing was derived from the stored row; held when something was, with the FEED_CHANGE_HOLDS ground that stopped it.';

COMMENT ON COLUMN bank_transaction_revisions.kind IS
  'What the feed asserted. Decides which of the ground''s two remedies a person is shown, because a revision ends in "apply and re-post" and a retraction in "exclude and void".';
