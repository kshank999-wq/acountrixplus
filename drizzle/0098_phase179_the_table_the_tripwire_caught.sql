-- Phase 179: the table the tripwire was built to catch.
--
-- `tests/rls-bites.test.ts` holds an assertion with a stated purpose:
--
--   > Coverage is asserted against the **schema source** rather than against the
--   > catalogue the migration looped over, so a table added later fails here
--   > instead of quietly going unprotected.
--
-- Phase 177 added `bank_transaction_revisions`, which carries a `company_id`.
-- It was not policed, and the tripwire built for exactly that has been red ever
-- since — through Phase 177's targeted run, Phase 178's, and both pushes.
--
-- ADR 0178 predicted this in the sentence that nominated Phase 179: *"a scan
-- that counts the whole tree cannot be checked by running the tests near the
-- code that changed."* The prediction came true on the person who wrote it,
-- twice over, in the two phases between writing it and acting on it.
--
-- ## Why it is a real gap and not a count
--
-- The six tables that carry a `company_id` and are deliberately unpoliced are
-- unpoliced for one reason: each is read **in order to decide who the caller
-- is**, strictly before any tenant can be set. `memberships`,
-- `security_policies`, `devices`, `practice_engagements`, and the two queue
-- tables Phase 162 exempted.
--
-- A bank transaction's revision log is none of those. It is read after the
-- tenant is known, it carries one company's figures, and what it holds is the
-- audit trail for amounts in that company's books. It belongs behind the
-- predicate with `bank_transactions` itself.
--
-- The second layer is still inert — `RLS_ROLLOUT` says so, and the application
-- connects as the owner — so this closes no live hole today. It closes the hole
-- that opens the day the application connects as `accountrix_app`, which is
-- the whole argument for installing policies before they are needed rather
-- than after.

ALTER TABLE bank_transaction_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transaction_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bank_transaction_revisions;
CREATE POLICY tenant_isolation ON bank_transaction_revisions
  FOR ALL TO accountrix_app
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- The grants `ALTER DEFAULT PRIVILEGES` would have given a table created by the
-- migration runner. Spelled out because the comment on the tripwire says the
-- quiet part: "granted is automated and protected is not, deliberately — they
-- are opposite defaults and only one of them is safe to let a later migration
-- inherit."
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_transaction_revisions TO accountrix_app;
