-- Phase 177: what the bank did after we wrote it down.
--
-- `/transactions/sync` returns `added`, `modified` and `removed`. Phase 176's
-- adapter hands the first two over; `importTransactions` then does
-- `ON CONFLICT DO NOTHING`, so a **modified** transaction is dropped. The
-- universal case is the one every bank does: a pending transaction posts and its
-- amount changes by the tip. The inbox keeps the pending figure, the
-- reconciliation does not close, and the difference is the tip.
--
-- `ON CONFLICT DO UPDATE` is the one-line fix and the wrong one — it would
-- silently rewrite a transaction already posted to the ledger, possibly in a
-- closed period, under a certified reconciliation. `ledger/restate.ts` settled
-- that question: *"A second entry, not a re-post. The original stays where it
-- is."*
--
-- ## Why a table and not two columns
--
-- The first shape tried was `provider_revision_amount_cents` and friends on
-- `bank_transactions` — "the feed says this is now different". It is wrong twice:
--
--   * A transaction is revised **more than once**. Pending at $40, pending at
--     $42, posted at $44.20. Columns hold the last one and lose the path, and
--     the path is what somebody reconciling actually wants to see.
--   * "Applied" and "held" is a fact about a *revision*, not about the
--     transaction. A row that had one applied in March and one held in April has
--     no single answer to put in a column.
--
-- So this is an append-only log of every change a feed made to a transaction it
-- had already sent, including the ones that were applied — which makes it the
-- audit trail for the feed, not just a queue of exceptions. §19's correction
-- philosophy is append-only everywhere else and there is no reason for this to
-- be the exception.

CREATE TYPE revision_disposition AS ENUM ('applied', 'held', 'dismissed');

COMMENT ON TYPE revision_disposition IS
  'applied: written onto the transaction. held: not written, waiting on a person. dismissed: a person decided the stored figure stands.';

-- The target half of the composite tenant key below. Phase 170's device: a
-- single-column reference to `bank_transactions (id)` would let a revision row
-- point at another company''s transaction and the database would not care.
ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_company_id_key UNIQUE (company_id, id);

CREATE TABLE bank_transaction_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL,

  -- What the feed now says. Every revisable field, not only the changed ones, so
  -- a row is readable on its own without replaying the ones before it.
  amount_cents bigint NOT NULL,
  posted_date date NOT NULL,
  description text NOT NULL,
  merchant_name text,
  provider_category text,
  pending boolean NOT NULL,

  -- What we held at the moment the revision arrived. Stored rather than derived
  -- because the transaction moves on: by the time somebody reads a held revision
  -- from last Tuesday, `bank_transactions.amount_cents` may have been changed by
  -- a later revision that *was* applied, and then "from" would be a lie.
  previous_amount_cents bigint NOT NULL,
  previous_posted_date date NOT NULL,
  previous_pending boolean NOT NULL,

  disposition revision_disposition NOT NULL,

  -- Which `REVISION_HOLDS` entry stopped it. Null when applied. Not a foreign
  -- key because the register is code, and `revisionHoldFor` throws a
  -- `RegistryError` for a key nobody declared — which is the check a text column
  -- would otherwise be missing.
  hold_ground text,

  -- Whether the revision moved a figure the books are built from, decided by
  -- `BOOK_AFFECTING_FIELDS`. Stored because it is what makes a revision
  -- interesting, and a query filtering on it should not have to re-derive the
  -- rule.
  touches_books boolean NOT NULL,

  /*
    The untouched provider payload for *this* revision.
    `bank_transactions.raw` carries the latest; applying a revision overwrites
    it, so without this the payload that justified an earlier figure is gone —
    and the payload is the only thing that can settle an argument about what the
    bank actually sent.
  */
  raw jsonb,

  seen_at timestamptz NOT NULL DEFAULT now(),
  -- Who closed it out, and when. Null while held. A dismissal says why; an
  -- application does not need to, because the bank is the reason.
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  resolution_note text,

  CONSTRAINT bank_transaction_revisions_transaction_fkey
    FOREIGN KEY (company_id, bank_transaction_id)
    REFERENCES bank_transactions (company_id, id) ON DELETE CASCADE,

  -- A held revision that the provider keeps re-sending must not create a row
  -- every five minutes. The three fields that can hold a revision open are the
  -- three that identify it; a descriptive-only re-send of a held revision does
  -- not make a second row, which is the right trade because a descriptive change
  -- never holds.
  CONSTRAINT bank_transaction_revisions_unique
    UNIQUE (company_id, bank_transaction_id, amount_cents, posted_date, pending),

  -- A hold has a ground and nothing else does. Without this the table could say
  -- "held" with no reason, which is a held revision with no remedy — exactly
  -- what `revisionStands` refuses to let the register do.
  CONSTRAINT bank_transaction_revisions_ground_check CHECK (
    (disposition = 'held' AND hold_ground IS NOT NULL)
    OR (disposition <> 'held' AND hold_ground IS NULL)
  ),

  -- Resolved means resolved. A row cannot be applied or dismissed without a
  -- timestamp, and cannot carry one while still held.
  CONSTRAINT bank_transaction_revisions_resolved_check CHECK (
    (disposition = 'held' AND resolved_at IS NULL)
    OR (disposition <> 'held' AND resolved_at IS NOT NULL)
  )
);

COMMENT ON TABLE bank_transaction_revisions IS
  'Append-only log of every change a bank feed made to a transaction it had already sent. Applied when nothing was derived from the stored row; held when something was, with the REVISION_HOLDS ground that stopped it.';

CREATE INDEX bank_transaction_revisions_transaction_idx
  ON bank_transaction_revisions (company_id, bank_transaction_id);

-- The query the inbox runs. Partial, because `held` is the small minority of a
-- table that logs every applied revision too, and a full index would be mostly
-- rows nobody is looking for.
CREATE INDEX bank_transaction_revisions_held_idx
  ON bank_transaction_revisions (company_id, seen_at DESC)
  WHERE disposition = 'held';
