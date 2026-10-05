-- Phase 160: the second layer, and the reason it would have been decoration.
--
-- Spec §19 asks for tenant isolation in the database as well as in the
-- application. Phases 149 and 150 measured the application half -- 110 writes
-- and 883 reads, every one guarded -- and both said row level security is a
-- *second* layer and a migration nobody had written. ADRs 0157, 0158 and 0159
-- each re-nominated it.
--
-- ## What measuring found first
--
-- The application connects as `postgres`. That role is a **superuser** and it
-- **owns all 181 tables**.
--
-- Row level security is never applied to a superuser, and is not applied to a
-- table's owner unless FORCE ROW LEVEL SECURITY is also set. So the obvious
-- version of this migration -- ENABLE plus CREATE POLICY, 167 times -- would
-- have produced 167 rows in `pg_policies`, 167 tables reporting
-- `relrowsecurity`, and exactly no isolation. Every policy inert. Every query
-- unaffected. And the next person to audit this database by listing its
-- policies would have concluded the tenants were separated at the storage
-- layer.
--
-- A security control that looks present and does nothing is worse than its
-- absence, because its absence is at least legible.
--
-- ## So this migration installs the mechanism and does not claim the outcome
--
-- It creates a role the mechanism applies to, grants that role what the
-- application needs, forces RLS on every tenant-scoped table, and writes a
-- policy that fails closed.
--
-- It does **not** switch the application to that role. That is a deployment
-- change -- a new DATABASE_URL -- and every query would then have to carry the
-- tenant through `withTenant`, which 883 reads do not yet. `RLS_ROLLOUT` in
-- `modules/tenancy/rls.ts` says so in the code, `rlsStands` refuses to report
-- isolation on a connection that bypasses it, and `tests/rls-bites.test.ts`
-- proves the mechanism works by connecting as the restricted role.
--
-- Applying this migration therefore changes nothing for the running
-- application, by design. That is the honest state and it is stated rather than
-- left for somebody to infer from a green deploy.

--------------------------------------------------------------------------------
-- The role.
--
-- NOLOGIN, with no password. A migration that shipped a credential would be a
-- credential in version control, and §12's rule about not storing outside-system
-- credentials in plaintext is the same rule read from the inside.
--
-- The deployment gives it a password and LOGIN. The test suite does the same for
-- itself, with its own throwaway password, which is why the test can prove the
-- policies bite without this file knowing anything secret.
--
-- NOSUPERUSER and NOBYPASSRLS are written out rather than left to the default,
-- because they are two of the five ways this control silently does nothing and
-- a reader of this file should see them refused on purpose.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accountrix_app') THEN
    CREATE ROLE accountrix_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    -- Idempotent, and re-asserted: a role that picked up BYPASSRLS somewhere
    -- else would make every policy below decoration.
    ALTER ROLE accountrix_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO accountrix_app;

-- DML only. No DDL, no TRUNCATE: the application does not change the schema and
-- a role that cannot drop a table cannot be made to.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO accountrix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO accountrix_app;

-- So a table added by a later migration is reachable without remembering this
-- file. It does *not* make a later table protected -- that is the tripwire in
-- `tests/rls-bites.test.ts`, because "granted" and "protected" are opposite
-- defaults and only one of them is safe to automate.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO accountrix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO accountrix_app;

--------------------------------------------------------------------------------
-- The policy, on every table that carries a company_id.
--
-- Driven from `information_schema` rather than written out 167 times, because a
-- hand-written list would be wrong the day it was written and wrong differently
-- every month after. The cost is that it covers the tables that exist *now*,
-- which is why the test asserts coverage against the schema source instead of
-- trusting this loop to have been re-run.
--
-- The predicate:
--
--   company_id = current_setting('app.company_id', true)::uuid
--
-- `current_setting(name, true)` returns NULL for an unset setting rather than
-- raising, and `company_id = NULL` is NULL, which is not true, so the row is
-- filtered out. **A query with no tenant set sees nothing.** Written the
-- inviting way --
--
--   company_id = coalesce(current_setting('app.company_id', true)::uuid, company_id)
--
-- -- a forgotten SET LOCAL returns every tenant's rows, silently, on a path that
-- worked a moment ago. The two differ by one coalesce and they are opposites.
--
-- FOR ALL with both USING and WITH CHECK, because the two do different jobs.
-- USING decides which existing rows a statement sees; WITH CHECK decides which
-- rows it may write. A policy with only USING lets a tenant insert a row
-- carrying somebody else's company_id -- the row then vanishes from their own
-- view, the write succeeded, and the data is in another tenant's books.
--
-- TO accountrix_app, so any other non-superuser role gets no applicable policy
-- on an RLS-enabled table and is therefore denied every row. Fail closed.

DO $$
DECLARE
  t text;
  n int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns ic
        WHERE ic.table_schema = 'public'
          AND ic.table_name = c.relname
          AND ic.column_name = 'company_id'
      )
      -- The four exceptions, and they are not an oversight in the rule above.
      -- Each is read in order to decide who the caller is and what they may do,
      -- which is strictly before any tenant can be set, so a policy keyed on the
      -- tenant setting cannot protect the table the setting is derived from.
      --
      -- `RLS_EXEMPT` in `modules/tenancy/rls.ts` carries the consequence of
      -- policing each one, and two of the four are silent:
      --
      --   memberships          sign-in stops working -- the read that resolves
      --                        the role *is* the row the policy would filter by.
      --   devices              **a revoked device reads as live.** Left-joined
      --                        for `deviceRevokedAt`; an invisible row yields
      --                        NULL, which this code reads as "not revoked". So
      --                        adding RLS would undo device revocation.
      --   security_policies    **the company's security policy reads as absent**,
      --                        so lockout, session lifetime and MFA fall back to
      --                        defaults on the path meant to enforce them.
      --   practice_engagements a practice user loses the `viaPractice` label, so
      --                        the audit log stops recording that the person
      --                        acting works for the client's accountants.
      --
      -- The first draft of this migration protected all 167 and
      -- `tests/rls-bites.test.ts` failed on `memberships`. Chasing that found
      -- the other three.
      AND c.relname NOT IN ('memberships', 'devices', 'security_policies', 'practice_engagements')
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- `nullif(…, '')` is not decoration. Once a custom GUC has been set at all
    -- in a session -- including by a SET LOCAL that has since rolled back --
    -- `current_setting(name, true)` returns the empty string rather than NULL,
    -- and `company_id = ''::uuid` raises `invalid input syntax for type uuid`
    -- instead of filtering. Fail-closed either way, but a 500 on a pooled
    -- connection whose previous occupant set a tenant, which appears under load
    -- and not in development. The acceptance test found this.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO accountrix_app '
      'USING (company_id = nullif(current_setting(''app.company_id'', true), '''')::uuid) '
      'WITH CHECK (company_id = nullif(current_setting(''app.company_id'', true), '''')::uuid)',
      t
    );
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'tenant_isolation installed on % tables', n;

  -- 163 when this was written: 167 tenant-scoped tables less the four above.
  -- The test is where a moved count gets decided, against the schema source --
  -- but a migration that silently protected nothing, because the column name
  -- changed or the loop was wrong, is worth refusing here.
  IF n = 0 THEN
    RAISE EXCEPTION 'tenant_isolation installed on no tables -- the loop found nothing to protect';
  END IF;
END
$$;

--------------------------------------------------------------------------------
-- Also not done here.
--
-- `companies` has no company_id -- its own `id` is the tenant -- and the 13
-- other tables without one are global (`users`, `sessions`, `login_attempts`)
-- or content-addressed (`document_bytes`). None is tenant-scoped by the
-- measurement this codebase has used since Phase 149, so none is in scope.
--
-- What the four exemptions above need is not a later ordering but a different
-- mechanism: a policy on an access-granting table has to be keyed on the
-- *session*, not on the tenant the session is about. That is a phase of its own
-- and it is nominated in ADR 0160 rather than guessed at here.
