-- Phase 162: the queue that could not see itself.
--
-- Phase 160 installed a tenant policy on every table carrying a `company_id`,
-- less four that are read in order to decide who the caller is. Phase 162 went
-- to wire the worker into a tenant scope and found that two of the 163 policed
-- tables are read **across** tenants on purpose, and that policing them takes
-- all background processing out.
--
-- ## What it does
--
--   claimJobs            raw SQL, LIMIT n, **no company filter** -- a poller
--                        claims whatever work is oldest across every tenant,
--                        because that is what a poller is. Policed, it claims
--                        nothing: the queue never drains.
--
--   relayPendingEvents   `where relayed_at is null`, **no company filter** --
--                        an outbox drain is global for the same reason.
--                        Policed, it relays nothing, so every notification and
--                        every downstream job stops being queued while the
--                        events themselves accumulate.
--
--   failJob/completeJob  affect zero rows, so a job that did somehow get
--                        claimed retries until it dies.
--
-- The worst part is that none of it errors. "The queue is empty" and "nothing
-- can see the queue" render identically -- which is the failure `runner.ts`'s
-- own heartbeat comment already warns about, in those words: an outage that
-- looks like calm.
--
-- ## Why un-policing rather than widening the policy
--
-- Because the obvious widening is a fail-open control dressed as a fail-closed
-- one:
--
--   -- Never this.
--   USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid
--          OR current_setting('app.company_id', true) IS NULL)
--
-- Every forgotten scope anywhere in the application would then see every
-- tenant's rows. That is the `coalesce` trap Phase 160 named, with extra steps.
--
-- The right answer is a **second principal**: an `accountrix_worker` role with
-- its own `FOR ALL TO accountrix_worker USING (true)` on these two tables,
-- keeping the tenant policy for the web role -- because the worker genuinely is
-- a different principal from a web request. That is a second role and a second
-- DATABASE_URL, compounding the deployment change already outstanding from
-- Phase 160, so it is nominated in ADR 0162 rather than slipped in here.
--
-- Un-policing is safe in the meantime because the first layer is untouched.
-- Phases 149 and 150 measured every read as guarded; the per-company readers of
-- `domain_events` -- `listEvents(companyId)`, `eventsFor(companyId)` -- are
-- `explicit-company`, and the two drain paths are deliberately global and were
-- deliberately global before row level security existed.
--
-- `RLS_EXEMPT` in `modules/tenancy/rls.ts` carries both entries with their
-- consequences, under a second ground -- `crosses-tenants-by-design` -- argued
-- as its own value rather than bent onto `establishes-the-tenant`, because
-- nothing reads these two to find out who the caller is.

ALTER TABLE background_jobs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE background_jobs DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON background_jobs;

ALTER TABLE domain_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_events DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON domain_events;

--------------------------------------------------------------------------------
-- 161 policed tables, down from 163.
--
-- Asserted here as well as in `tests/rls-bites.test.ts`, because this migration
-- is the one that moves the number and a silent miscount is how a table ends up
-- unprotected without anybody deciding.

DO $$
DECLARE
  policed int;
BEGIN
  SELECT count(*) INTO policed
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;

  IF policed <> 161 THEN
    RAISE EXCEPTION
      'expected 161 policed tables after exempting the queue, found %. Phase 160 installed 163; '
      'if a migration has added or removed a tenant-scoped table since, decide what it needs '
      'rather than letting this number drift.', policed;
  END IF;
END
$$;
