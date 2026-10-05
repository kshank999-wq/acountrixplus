/**
 * The paths that must see every tenant, and how to tell when they cannot (Phase 163).
 *
 * ## Three instances of one shape
 *
 * Phase 162 found that policing `background_jobs` and `domain_events` takes all
 * background processing out — a poller claims across every tenant because that
 * is what a poller is — and that it does so **silently**, because an empty
 * result is a valid result. It quoted `runner.ts`'s own heartbeat comment, which
 * had described the same failure many phases earlier and about a different
 * cause:
 *
 * > "the queue is empty" and "nothing is draining the queue" render
 * > identically, and the second is an outage that looks like calm.
 *
 * Measuring the five `global` job handlers for this phase found four more paths
 * of the same kind, and one worse than the queue. `housekeeping.retention`
 * sweeps every company's expiring rows, sums what it removed, and returns
 * `{ removed, byPolicy }`. Blinded by a tenant policy it returns
 * `{ removed: 0, byPolicy: {} }` — **and the job is recorded as succeeded.**
 * Retention stops working and the first symptom is tables growing that a policy
 * says should not.
 *
 * ## Why counting cannot find it, and what can
 *
 * All three are silent for one reason: **a cross-tenant path cannot tell "I can
 * see this table and it is empty" from "I cannot see this table" by counting.**
 * Both are zero. No amount of care at the call site fixes that, because the
 * information is not in the result.
 *
 * It is in the catalogue. For each table a path must see across tenants, ask
 * whether row level security is enabled and whether *this role* gets through it
 * unconditionally. That has a definite answer, and asking it is the same move
 * `rlsStands` makes: measure the mechanism rather than infer it from results.
 *
 * So `crossTenantSight` is measured from `pg_class` and `pg_policies`, and a
 * declared path that has been blinded **throws** instead of reporting success.
 *
 * ## What this is not
 *
 * It is not a permission. Nothing here grants cross-tenant access — the paths
 * below already have it, because they run on a connection that is not subject to
 * a tenant policy. This register says **which paths rely on that, and what
 * authority they rely on it for**, so that the day the connection changes they
 * fail loudly rather than quietly doing nothing.
 *
 * It is also not the answer to ADR 0162's nomination. That nominated an
 * `accountrix_worker` role, and `runOnce` turns out to have three callers — a
 * standalone process, an HTTP cron route, and a server action — two of which run
 * in the web process on the web connection. A role named after a deployment unit
 * covers one caller in three. What these paths need is a principal per *kind of
 * authority*, which is what the `authority` field below is for and what makes it
 * expressible at all.
 */

import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { RegistryError } from '@/modules/errors/registry'
import { RETENTION_POLICIES } from '@/modules/retention/policy'

/** What gives a path the right to read across tenants, in place of a tenant setting. */
export type CrossTenantAuthority =
  /**
   * A scheduler asked for it. The work belongs to no company — draining a queue,
   * relaying an outbox — and there is no tenant whose setting would be correct.
   */
  | 'the-schedule'
  /**
   * A retention policy asked for it. `RETENTION_POLICIES` says how long each
   * kind of row is kept, for every company, and a sweep that ran per tenant
   * would need a list of tenants — which is itself a cross-tenant read.
   */
  | 'the-retention-policy'
  /**
   * A practice engagement asked for it. A firm may see its clients because
   * somebody signed an engagement, and that is a positive grant rather than an
   * absence of one — the only authority here that a policy could express, keyed
   * on the session's practice rather than on a company.
   */
  | 'a-practice-engagement'

export type CrossTenantPath = {
  /** `module/file:function`, so the register can be checked against the source. */
  path: string
  authority: CrossTenantAuthority
  /** Tables it needs unrestricted sight of. */
  tables: readonly string[]
  /**
   * Whether being blinded looks like success.
   *
   * The field that decides whether a path needs a check in front of it. A path
   * that errors when it cannot see its tables is already honest; one that returns
   * zero and reports success is the failure this module exists for.
   */
  silentWhenBlinded: boolean
  because: string
}

/**
 * The tables the retention sweep must see, derived rather than listed.
 *
 * `RETENTION_POLICIES` is the authority on what gets swept, so repeating its
 * tables here would be a second answer to one question — and the copy is the one
 * that goes stale when a policy is added, leaving a table swept by a path this
 * register says nothing about.
 */
function sweptTables(): readonly string[] {
  return RETENTION_POLICIES.map((policy) => policy.table)
}

/**
 * Paths that read or write across every tenant on purpose (Phase 163).
 *
 * Six, under three authorities. The queue's two came from Phase 162 as *table*
 * exemptions; this register is about the **paths**, because a table exemption
 * says what is unprotected and a path says who is relying on that and why.
 */
export const CROSS_TENANT_PATHS: readonly CrossTenantPath[] = [
  {
    path: 'worker/queue:claimJobs',
    authority: 'the-schedule',
    tables: ['background_jobs'],
    silentWhenBlinded: true,
    because:
      'Raw SQL with a LIMIT and no company filter, because a poller claims whatever work is oldest ' +
      'across every tenant. Blinded it claims nothing, the tick reports zero jobs run, and that is ' +
      'indistinguishable from an idle queue.',
  },
  {
    path: 'worker/outbox:relayPendingEvents',
    authority: 'the-schedule',
    tables: ['domain_events'],
    silentWhenBlinded: true,
    because:
      'Reads `where relayed_at is null` with no company filter, because an outbox drain is global. ' +
      'Blinded it relays nothing while the events keep accumulating, so the first symptom is a ' +
      'growing table rather than an error.',
  },
  {
    path: 'retention/sweep:sweepAll',
    authority: 'the-retention-policy',
    tables: sweptTables(),
    silentWhenBlinded: true,
    because:
      'The worst of the six. It sweeps every company’s expiring rows, sums what it removed, and ' +
      'returns `{ removed: 0 }` when there was nothing — which is exactly what it returns when it ' +
      'cannot see anything, and the job is then recorded as **succeeded**. Retention stops working ' +
      'and the first symptom is tables growing that a policy says should not. A per-tenant sweep ' +
      'would need a list of tenants, which is itself a cross-tenant read, so this cannot be fixed ' +
      'by scoping it.',
  },
  {
    path: 'worker/handlers/housekeeping:prune_jobs',
    authority: 'the-schedule',
    tables: ['background_jobs'],
    silentWhenBlinded: true,
    because:
      'Deletes succeeded and cancelled jobs older than fourteen days, across every company. Blinded ' +
      'it deletes nothing and the table grows without bound — slowly enough that nobody looks until ' +
      'the poller is slow.',
  },
  {
    path: 'worker/handlers/housekeeping:prune_idempotency_keys',
    authority: 'the-schedule',
    tables: ['idempotency_keys'],
    silentWhenBlinded: true,
    because:
      'Deletes expired keys across every company. The least costly of the six to get wrong, and ' +
      'listed because a register that holds only the frightening ones stops being a measurement.',
  },
  {
    path: 'worker/handlers/practice:morning_brief',
    authority: 'a-practice-engagement',
    tables: ['practice_engagements', 'companies'],
    silentWhenBlinded: false,
    because:
      'The one whose authority is a **positive grant** rather than the absence of a tenant: a firm ' +
      'may see its clients because somebody signed an engagement. That is the only one of the three ' +
      'authorities a policy could express — keyed on the session’s practice rather than on a ' +
      'company — and it is why `a-practice-engagement` is its own value rather than folded into ' +
      '`the-schedule`. Not silent when blinded: it reads a named firm’s engagements and has ' +
      'somewhere to report finding none.',
  },
]

/** The path a key names. Throws on one nobody declared. */
export function crossTenantPathFor(path: string): CrossTenantPath {
  const found = CROSS_TENANT_PATHS.find((row) => row.path === path)
  if (!found) {
    throw new RegistryError({
      registry: 'CROSS_TENANT_PATHS',
      key: path,
      message:
        `No cross-tenant path is declared as "${path}". A path that reads across every tenant is ` +
        'an entry there with the tables it needs unrestricted sight of and the authority it relies ' +
        'on instead of a tenant setting — because when the connection changes, an undeclared one ' +
        'returns zero rows and reports success.',
    })
  }
  return found
}

/** Every table some declared path needs unrestricted sight of. */
export function crossTenantTables(): string[] {
  return [...new Set(CROSS_TENANT_PATHS.flatMap((row) => [...row.tables]))].sort()
}

/**
 * Which of these tables this connection **cannot** see across tenants.
 *
 * Measured from the catalogue, never from a row count, because a count cannot
 * tell an empty table from an invisible one.
 *
 * A table is visible across tenants when any of these holds:
 *
 *  - row level security is not enabled on it;
 *  - the role is a superuser, or carries `BYPASSRLS`;
 *  - the role owns it and it is not forced;
 *  - a permissive policy applies to the role with an unconditional `USING`.
 *
 * The last is the one that matters for a named principal: `USING (true)` reads
 * as `qual` of `true` in `pg_policies`, and a tenant policy reads as the
 * `company_id = …` expression, so the two are distinguishable without parsing
 * anything.
 */
export async function crossTenantSight(
  tables: readonly string[],
  exec: Executor = db,
): Promise<string[]> {
  if (tables.length === 0) return []

  const names = sql.raw(tables.map((name) => `'${name.replace(/'/g, "''")}'`).join(', '))

  const rows = (await exec.execute(sql`
    select
      c.relname as table_name,
      c.relrowsecurity as enabled,
      c.relforcerowsecurity as forced,
      pg_get_userbyid(c.relowner) = current_user as owned,
      (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
      (select rolbypassrls from pg_roles where rolname = current_user) as can_bypass,
      exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.relname
          and p.permissive = 'PERMISSIVE'
          and (p.qual is null or btrim(p.qual) = 'true')
          and (p.roles = '{0}' or current_user = any (p.roles))
      ) as unconditional
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relname in (${names})
  `)) as unknown as Array<{
    table_name: string
    enabled: boolean
    forced: boolean
    owned: boolean
    is_superuser: boolean
    can_bypass: boolean
    unconditional: boolean
  }>

  const blind: string[] = []

  for (const row of rows) {
    if (!row.enabled) continue
    if (row.is_superuser || row.can_bypass) continue
    if (row.owned && !row.forced) continue
    if (row.unconditional) continue
    blind.push(row.table_name)
  }

  // A table the register names and the database does not have is also a thing
  // this should report, rather than pass by saying nothing was blind.
  const found = new Set(rows.map((row) => row.table_name))
  for (const table of tables) if (!found.has(table)) blind.push(`${table} (no such table)`)

  return blind.sort()
}

/** Raised by a declared cross-tenant path that has been blinded. */
export class CrossTenantBlindError extends Error {
  readonly blinded: readonly string[]

  constructor(path: CrossTenantPath, blinded: readonly string[]) {
    super(
      `${path.path} must see every tenant and cannot see ${blinded.join(', ')}. ` +
        `Its authority is ${path.authority}, not a tenant setting, so running it as it stands ` +
        'would do nothing and report success. ' +
        (path.silentWhenBlinded
          ? 'That is why this is an error rather than an empty result.'
          : 'This path reports an empty result honestly, and is checked for consistency.'),
    )
    this.name = 'CrossTenantBlindError'
    this.blinded = blinded
  }
}

/**
 * Refuses to run a declared cross-tenant path that cannot see its tables.
 *
 * Called at the top of the paths whose silence is most expensive. Deliberately
 * **not** called in front of all six: the catalogue query costs a round trip,
 * and a per-statement check would be a check where this phase's whole argument
 * is that the information belongs at the start of the work. The register says
 * which paths are silent when blinded; the two that run on a schedule and sweep
 * or drain are the ones guarded.
 */
export async function assertCrossTenantSight(
  pathKey: string,
  exec: Executor = db,
): Promise<void> {
  const path = crossTenantPathFor(pathKey)
  const blinded = await crossTenantSight(path.tables, exec)
  if (blinded.length > 0) throw new CrossTenantBlindError(path, blinded)
}
