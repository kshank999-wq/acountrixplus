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
 * ## Use the executor it hands you
 *
 * ```ts
 * // Right.
 * await withTenant(ctx, (tx) => tx.select().from(invoices))
 *
 * // Wrong, and it will return nothing once the app connects as a restricted
 * // role: the setting is on the transaction's connection and this query is on
 * // whichever one the pool hands out next.
 * await withTenant(ctx, () => db.select().from(invoices))
 * ```
 *
 * The second form fails closed rather than leaking, which is the one mercy in
 * the design: a query that misses the setting sees no rows rather than all of
 * them. It is still a bug, and it is why `set_config` is called inside the
 * transaction rather than before it.
 */

import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
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
  return db.transaction(async (tx) => {
    // `true` is the is_local argument, and it is the difference between this
    // function and a cross-tenant read.
    await tx.execute(sql`select set_config(${RLS_GUC}, ${ctx.companyId}, true)`)
    return fn(tx)
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
