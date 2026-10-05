/**
 * Carrying the tenant into the database (Phase 160).
 *
 * The policies installed by `0085_phase160_row_level_security.sql` read the
 * tenant from `current_setting('app.company_id')`. This is the only sanctioned
 * way to set it, and the reason it opens a transaction is the whole of its
 * correctness.
 *
 * ## Why a transaction, when nothing here needs atomicity
 *
 * `SET app.company_id = …` lasts for the life of the **connection**, and
 * postgres-js keeps a pool of up to ten. The next request handed that backend
 * inherits whatever the last one set, and the policy faithfully applies it — so
 * one tenant reads another tenant's books through a query that is filtering
 * correctly on the value it was given. Nothing errors. Nothing logs. It works
 * in development, works in tests, and works in production until two requests
 * land on the same backend.
 *
 * `SET LOCAL` is scoped to the transaction and rolled back with it, and a
 * transaction is the only thing that pins a postgres-js query to one connection
 * for more than a single statement. So the transaction is not here for
 * atomicity; it is here because it is the unit Postgres will scope a setting to
 * and the unit the driver will keep on one backend. Those have to be the same
 * unit or the setting and the query can be on different connections.
 *
 * That is `session-scoped-setting` in `RLS_BYPASSES`, and it is the one of the
 * five that does not fail open or closed but *sideways*: it silently applies the
 * wrong tenant.
 *
 * ## Both forms work, which is Phase 161's change
 *
 * ```ts
 * // Both of these run on the same connection, with the tenant set.
 * await withTenant(ctx, (tx) => tx.select().from(invoices))
 * await withTenant(ctx, () => db.select().from(invoices))
 *
 * // And so does this, which is the point: `trialBalance` reads `db` and has
 * // never heard of row level security.
 * await withTenant(ctx, () => trialBalance(ctx, range))
 * ```
 *
 * Phase 160 shipped only the first form, and measuring found it had no caller
 * and could not have one: 903 sites reach the module-level `db` directly and 802
 * service entry points take no executor at all. Threading one through them would
 * have been a check at 903 call sites. Binding the tenant to the connection
 * `db` resolves to is a constraint at one (Phase 116), so the second and third
 * forms work without a single signature changing.
 *
 * The executor is still handed to the callback, because 149 functions already
 * accept one for transaction reasons and should keep being passed it rather than
 * opening a nested savepoint of their own.
 */

import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { currentTenantScope, runInTenantScope } from '@/db/tenant-scope'
import { RLS_GUC, type RlsObservation } from './rls'

/**
 * Runs `fn` with the tenant set for the duration of one transaction.
 *
 * `set_config(name, value, true)` rather than `SET LOCAL app.company_id = …`
 * because `SET` does not take a bind parameter: the value would have to be
 * interpolated into the SQL text. `set_config` is an ordinary function call, so
 * the company id travels as a parameter like every other value in this codebase.
 */
export async function withTenant<T>(
  ctx: { companyId: string },
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  const open = currentTenantScope()

  if (open) {
    /*
      Already inside a scope. Two cases, and they are not the same.

      Same company: re-entrant, and the right answer is to run `fn` on the scope
      that is already open rather than nest a savepoint. A report that calls two
      services which each open a scope should be one transaction, not three.

      Different company: refused, loudly. There is no legitimate reason for one
      request to open a tenant scope inside another tenant's — and the failure it
      would otherwise cause is the worst kind, because the inner `set_config`
      would succeed, the outer scope's queries after it would silently run as the
      inner company, and both would be filtering correctly on the value they were
      given. A nested scope for a different tenant is a cross-tenant bug by
      construction, so it is an error rather than a thing to handle.
    */
    if (open.companyId !== ctx.companyId) {
      throw new Error(
        `Refusing to open a tenant scope for ${ctx.companyId} inside one for ${open.companyId}. ` +
          'Nesting tenants would leave the outer scope running as the inner company with nothing ' +
          'to say so.',
      )
    }
    return fn(open.executor as Executor)
  }

  /*
    No scope is open, so `db` is the pooled handle here — the proxy resolves to
    it precisely because `currentTenantScope()` returned nothing a line ago. The
    re-entrant branch above is what keeps that true: without it this would open a
    savepoint on a transaction it was already inside, which works and is not what
    anybody means.
  */
  return db.transaction(async (tx) => {
    // `true` is the is_local argument, and it is the difference between this
    // function and a cross-tenant read.
    await tx.execute(sql`select set_config(${RLS_GUC}, ${ctx.companyId}, true)`)

    /*
      The scope, which is what makes the 903 unchanged call sites land here. Bound
      *after* the setting, so nothing inside can observe a scope whose connection
      does not yet carry a tenant.
    */
    return runInTenantScope({ executor: tx, companyId: ctx.companyId }, () => fn(tx))
  })
}

/**
 * What the tenant setting currently is, on this executor.
 *
 * Exists so a test can prove the setting is *not* there outside a
 * `withTenant` — which is the assertion that distinguishes a transaction-local
 * setting from a session one, and the only way to see the hazard rather than
 * reason about it.
 */
export async function currentTenant(exec: Executor = db): Promise<string | null> {
  const rows = (await exec.execute(
    sql`select current_setting(${RLS_GUC}, true) as company_id`,
  )) as unknown as Array<{ company_id: string | null }>

  /*
    `''` and `null` both mean "no tenant", and which one comes back depends on
    whether this connection has ever had the setting set — Postgres remembers a
    custom GUC once it has been seen and reverts it to the empty string rather
    than forgetting it. Normalised here so no caller has to know that, and it is
    the same fact the policy's `nullif` exists for.
  */
  const value = rows[0]?.company_id
  return value === undefined || value === null || value === '' ? null : value
}

/**
 * Reads the facts `rlsStands` judges, from the live database.
 *
 * Measured rather than configured, which is the point: every field here is read
 * from `pg_roles`, `pg_class` or `pg_policies`, so a deployment that *thinks* it
 * switched roles and did not gets told. Phase 141's rule — declare the
 * knowledge, measure the fact.
 *
 * The table list is **passed in** rather than counted here, because the
 * authority on which tables should be policed is the schema source plus
 * `RLS_EXEMPT`, and `policedTables(companyScopedSqlTablesIn(source))` is that
 * answer. Counting `company_id` columns in `information_schema` instead would be
 * a second answer — and it would be the wrong one by exactly four, because it
 * cannot know that `memberships` and `devices` are read in order to decide who
 * the caller is.
 */
export async function observeRls(
  policed: readonly string[],
  exec: Executor = db,
): Promise<RlsObservation> {
  const [role] = (await exec.execute(sql`
    select
      current_user::text as role,
      (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
      (select rolbypassrls from pg_roles where rolname = current_user) as can_bypass
  `)) as unknown as Array<{ role: string; is_superuser: boolean; can_bypass: boolean }>

  const names = sql.raw(policed.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ') || "''")

  const [counts] = (await exec.execute(sql`
    select
      count(*) filter (where c.relrowsecurity) as enabled,
      count(*) filter (where c.relforcerowsecurity) as forced,
      count(*) filter (where pg_get_userbyid(c.relowner) = current_user) as owned
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relname in (${names})
  `)) as unknown as Array<{ enabled: string; forced: string; owned: string }>

  const [policies] = (await exec.execute(sql`
    select count(*) as n from pg_policies
    where schemaname = 'public' and policyname = 'tenant_isolation'
      and tablename in (${names})
  `)) as unknown as Array<{ n: string }>

  const tenant = await currentTenant(exec)

  return {
    role: role.role,
    isSuperuser: Boolean(role.is_superuser),
    canBypassRls: Boolean(role.can_bypass),
    ownedTenantTableCount: Number(counts?.owned ?? 0),
    tenantTableCount: policed.length,
    enabledCount: Number(counts?.enabled ?? 0),
    forcedCount: Number(counts?.forced ?? 0),
    policyCount: Number(policies?.n ?? 0),
    /*
      `transaction-local` when a tenant is set and we are inside a transaction,
      which is the only way `withTenant` sets it. A setting present outside a
      transaction is the session-scoped hazard, and `exec` being the bare `db`
      handle is how that shows up — a query on the pool with a setting that
      outlived whoever set it.
    */
    settingScope: tenant === null ? 'unset' : exec === db ? 'session' : 'transaction-local',
  }
}
