import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { companyScopedSqlTablesIn } from '@/modules/tenancy/isolation'
import {
  APP_ROLE,
  RLS_BYPASSES,
  RLS_GUC,
  RLS_EXEMPT,
  RLS_ROLLOUT,
  bypassFor,
  exemptionFor,
  policedTables,
  policyStatementsFor,
  rlsStands,
  rolloutSummary,
  tenantPredicate,
  type RlsObservation,
} from '@/modules/tenancy/rls'
import { currentTenant, observeRls, withTenant } from '@/modules/tenancy/with-tenant'
import { createCompanyFixture, type Fixture } from './helpers'
import { RegistryError } from '@/modules/errors/registry'

/**
 * Row level security, proved rather than declared (Phase 160).
 *
 * Spec §19 asks for tenant isolation in the database as well as the
 * application, and ADRs 0157, 0158 and 0159 each nominated it. The reason it
 * needs this file rather than a migration and a paragraph:
 *
 * **The application connects as `postgres`, which is a superuser and owns all
 * 181 tables.** RLS is never applied to a superuser and is not applied to a
 * table's owner without FORCE, so a migration of ENABLE plus CREATE POLICY
 * would have produced 167 policies, 167 tables reporting `relrowsecurity`, and
 * no isolation at all — while looking, to anybody auditing the database by
 * listing its policies, exactly like success.
 *
 * So this file opens its own connection as a role the policies *do* apply to,
 * and makes them bite. Everything else here is about keeping that honest.
 */

/** A throwaway password, created and dropped by this file. */
const TEST_PASSWORD = 'rls-bites-fixture'

/** The restricted connection. Not a superuser, owns nothing. */
let restricted: ReturnType<typeof postgres>

/** Two companies, so "sees only its own" has something to be only. */
let alpha: Fixture
let beta: Fixture

/** The tenant-scoped tables, from the schema source rather than the catalogue. */
function tenantTables(): string[] {
  const dir = 'src/db/schema'
  const source = readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .map((file) => readFileSync(`${dir}/${file}`, 'utf8'))
    .join('\n')

  return companyScopedSqlTablesIn(source)
}

/** Those, less the four that are read in order to establish the tenant. */
function policed(): string[] {
  return policedTables(tenantTables())
}

beforeAll(async () => {
  // The migration creates the role NOLOGIN and with no password, because a
  // credential in a migration is a credential in version control. The test
  // gives it one of its own, which is how this file can prove the policies work
  // without anything secret living in the repository.
  await db.execute(sql.raw(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${TEST_PASSWORD}'`))

  const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '')
  url.username = APP_ROLE
  url.password = TEST_PASSWORD

  restricted = postgres(url.toString(), { max: 2, prepare: false })
})

afterAll(async () => {
  await restricted?.end()
  await db.execute(sql.raw(`ALTER ROLE ${APP_ROLE} NOLOGIN PASSWORD NULL`))
})

beforeEach(async () => {
  alpha = await createCompanyFixture({ name: 'Alpha Joinery' })
  beta = await createCompanyFixture({ name: 'Beta Builders' })
})

/**
 * Runs a query on the restricted connection with the tenant set for it.
 *
 * `postgres.begin` unwraps a promise-array return type, which `T` cannot be
 * narrowed to, so the result is cast rather than fought with. The thing under
 * test is the policy, not the driver's generics.
 */
async function asTenant<T>(
  companyId: string | null,
  query: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return restricted.begin(async (tx) => {
    if (companyId !== null) {
      // `set_config(name, value, true)` — the third argument is is_local, and it
      // is the difference between this and a cross-tenant read.
      await tx`select set_config(${RLS_GUC}, ${companyId}, true)`
    }
    return query(tx)
  }) as Promise<T>
}

describe('the policies bite', () => {
  it('shows a tenant its own rows and not the other one’s', async () => {
    // The assertion the whole phase is for. Both companies have a chart of
    // accounts from onboarding, so there is real data on both sides.
    const mine = await asTenant(
      alpha.companyId,
      (tx) => tx`select count(*)::int as n from chart_accounts`,
    )
    const theirs = await asTenant(
      beta.companyId,
      (tx) => tx`select count(*)::int as n from chart_accounts`,
    )

    expect(mine[0].n).toBeGreaterThan(0)
    expect(theirs[0].n).toBeGreaterThan(0)

    // And neither sees the other. Measured by company_id rather than by count,
    // because two equal counts would pass a count assertion while leaking.
    const leaked = await asTenant(
      alpha.companyId,
      (tx) => tx`select count(*)::int as n from chart_accounts where company_id <> ${alpha.companyId}`,
    )
    expect(leaked[0].n).toBe(0)
  })

  it('sees nothing at all when no tenant is set, which is the direction to fail in', async () => {
    /**
     * `current_setting(name, true)` returns NULL for an unset setting, and
     * `company_id = NULL` is NULL rather than true, so every row is filtered
     * out.
     *
     * The inviting way to write the predicate wraps it in a `coalesce` back to
     * `company_id`, and that version returns **every tenant's rows** when the
     * setting is missing — silently, on a path that worked a moment ago. The two
     * differ by one function call and they are opposites.
     */
    const rows = await asTenant(null, (tx) => tx`select count(*)::int as n from chart_accounts`)

    expect(rows[0].n).toBe(0)
    expect(tenantPredicate()).not.toContain('coalesce')
    expect(tenantPredicate()).toContain("nullif")
  })

  it('refuses a write that would land in another tenant', async () => {
    /**
     * `WITH CHECK`, which is why the policy is `FOR ALL` with both clauses. With
     * only `USING`, this insert succeeds: the row goes into Beta's books, then
     * vanishes from Alpha's own view because the policy filters it back out. The
     * write reports success, the data is in somebody else's ledger, and the
     * writer sees nothing wrong.
     */
    const theirAccount = await beta.account('4000')

    await expect(
      asTenant(
        alpha.companyId,
        (tx) => tx`
          insert into journal_entries (company_id, entry_number, entry_date, status)
          values (${beta.companyId}, 999001, '2026-01-01', 'posted')
        `,
      ),
    ).rejects.toThrow(/row-level security/i)

    // And the account it was reaching for is invisible too, which is the USING
    // half of the same policy.
    const seen = await asTenant(
      alpha.companyId,
      (tx) => tx`select count(*)::int as n from chart_accounts where id = ${theirAccount.id}`,
    )
    expect(seen[0].n).toBe(0)
  })

  it('cannot update or delete another tenant’s rows', async () => {
    // Not an error — zero rows affected, because `USING` filtered them out
    // before the statement saw them. Worth asserting separately from the insert:
    // a leak here would be silent rather than loud.
    const theirAccount = await beta.account('4000')

    const updated = await asTenant(
      alpha.companyId,
      (tx) => tx`update chart_accounts set name = 'Hijacked' where id = ${theirAccount.id}`,
    )
    expect(updated.count).toBe(0)

    const deleted = await asTenant(
      alpha.companyId,
      (tx) => tx`delete from chart_accounts where id = ${theirAccount.id}`,
    )
    expect(deleted.count).toBe(0)

    // Still there, read as the owner.
    const [row] = await db.execute(
      sql`select name from chart_accounts where id = ${theirAccount.id}`,
    )
    expect((row as { name: string }).name).not.toBe('Hijacked')
  })

  it('applies to every tenant-scoped table, not a sample', async () => {
    /**
     * The tripwire. Coverage is asserted against the **schema source** — the
     * same `companyScopedTablesIn` Phases 149 and 150 measured isolation with —
     * rather than against the catalogue the migration looped over, so a table
     * added later fails here instead of quietly going unprotected.
     *
     * "Granted" is automated by `ALTER DEFAULT PRIVILEGES` and "protected" is
     * not, deliberately: they are opposite defaults and only one of them is safe
     * to let a later migration inherit.
     */
    const expected = policed()
    expect(tenantTables()).toHaveLength(167)
    expect(expected).toHaveLength(163)

    const rows = (await db.execute(sql`
      select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             exists (
               select 1 from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname
                 and p.policyname = 'tenant_isolation'
             ) as has_policy
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
    `)) as unknown as Array<{
      table_name: string
      enabled: boolean
      forced: boolean
      has_policy: boolean
    }>

    const byName = new Map(rows.map((row) => [row.table_name, row]))
    const faults: string[] = []

    for (const table of expected) {
      const observed = byName.get(table)
      if (!observed) {
        faults.push(`${table}: declared tenant-scoped and not in the database`)
        continue
      }
      if (!observed.enabled) faults.push(`${table}: row level security not enabled`)
      if (!observed.forced) faults.push(`${table}: not forced, so the owner is exempt`)
      if (!observed.has_policy) faults.push(`${table}: no tenant_isolation policy`)
    }

    expect(faults).toEqual([])
  })

  it('leaves alone the four tables that decide who the caller is', async () => {
    /**
     * The finding this phase did not start with. The migration's first draft
     * protected every table carrying a `company_id` and this test failed on
     * `memberships`; chasing that found four, and they are not an oversight in
     * the rule. Each is read in order to decide who the caller is and what they
     * may do, which is strictly before any tenant can be set.
     *
     * Two of the four would have degraded **silently**, and those are the ones
     * worth the register: a revoked device left-joins to NULL and reads as live,
     * and a company's security policy reads as absent so lockout, session
     * lifetime and MFA fall back to defaults. A security control weakening
     * authentication while reporting success is the same shape as the inert
     * policies this phase is about, from the opposite direction.
     */
    expect(RLS_EXEMPT.map((row) => row.table).sort()).toEqual([
      'devices',
      'memberships',
      'practice_engagements',
      'security_policies',
    ])

    // Every one of them is genuinely tenant-scoped, which is why they need
    // exempting rather than simply not matching the rule.
    for (const exemption of RLS_EXEMPT) {
      expect(tenantTables(), exemption.table).toContain(exemption.table)
      expect(exemptionFor(exemption.table)?.ground).toBe('establishes-the-tenant')
    }

    const rows = (await db.execute(sql`
      select relname from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
        and relname in ('users', 'sessions', 'companies', 'document_bytes',
                        'memberships', 'devices', 'security_policies', 'practice_engagements')
    `)) as unknown as Array<{ relname: string }>

    expect(rows).toEqual([])
  })

  it('still lets a restricted connection read the tables that decide access', async () => {
    // The point of the exemption, from the other end: if these were policed,
    // this read would return nothing and nobody could sign in.
    const rows = await asTenant(
      alpha.companyId,
      (tx) => tx`select count(*)::int as n from memberships where company_id = ${alpha.companyId}`,
    )

    expect(rows[0].n).toBeGreaterThan(0)
  })
})

describe('the setting is scoped to the transaction, not the connection', () => {
  it('does not survive the transaction that set it', async () => {
    /**
     * The hazard this phase is most careful about, demonstrated rather than
     * argued. A plain `SET` lasts for the life of the connection, and
     * postgres-js pools up to ten — so the next request handed that backend
     * would inherit the last one's tenant and the policy would faithfully apply
     * it. One tenant reads another's books through a query that is filtering
     * correctly on the value it was given.
     *
     * `max: 2` on this client makes reuse likely rather than theoretical.
     */
    await asTenant(alpha.companyId, async (tx) => {
      const [inside] = await tx`select current_setting(${RLS_GUC}, true) as tenant`
      expect(inside.tenant).toBe(alpha.companyId)
    })

    /**
     * Outside, on a connection from the same small pool.
     *
     * Asserted as "not a company id" rather than "null", because of a fact this
     * test taught the phase: once a custom GUC has been set at all in a session,
     * Postgres remembers it and reverts it to the **empty string** rather than
     * forgetting it. `''` is what comes back here, and `company_id = ''::uuid`
     * raises rather than filtering — which is why the policy carries a `nullif`
     * and `currentTenant` normalises both to null.
     *
     * The security property is the same either way and it is the one asserted:
     * no connection outside the transaction carries Alpha's id.
     */
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [after] = await restricted`select current_setting(${RLS_GUC}, true) as tenant`
      expect(after.tenant, `attempt ${attempt} inherited a tenant`).not.toBe(alpha.companyId)
      expect([null, ''], `attempt ${attempt} carried something`).toContain(after.tenant)
    }
  })

  it('withTenant sets it, and nothing outside sees it', async () => {
    // The application-side helper, over the owner connection. It cannot prove
    // isolation here — `postgres` is a superuser — but it can prove the scoping,
    // which is the half that is a bug rather than a deployment step.
    expect(await currentTenant()).toBeNull()

    const seen = await withTenant(alpha, (tx) => currentTenant(tx))
    expect(seen).toBe(alpha.companyId)

    expect(await currentTenant()).toBeNull()
  })

  it('withTenant hands back a value and rolls its setting back on failure', async () => {
    await expect(
      withTenant(alpha, async () => {
        throw new Error('deliberate')
      }),
    ).rejects.toThrow('deliberate')

    expect(await currentTenant()).toBeNull()
  })
})

describe('what the check says about this connection', () => {
  it('refuses to call the application’s own connection isolated', async () => {
    /**
     * The honest state, asserted. `postgres` is a superuser that owns every
     * table, so the policies installed by this phase are skipped before they are
     * consulted — and this is the assertion that stops anybody reading
     * `pg_policies` and concluding otherwise.
     */
    const observed = await observeRls(policed())

    expect(observed.role).toBe('postgres')
    expect(observed.isSuperuser).toBe(true)

    const faults = rlsStands(observed)
    expect(faults.length).toBeGreaterThan(0)
    expect(faults[0]).toContain('is a superuser')
    expect(faults[0]).toContain('skipped before any policy is consulted')
  })

  it('finds nothing wrong with the restricted connection', async () => {
    // The other side of the same check, which is what makes it a check at all
    // (Phase 121): it has been seen to agree and to disagree, on two real
    // connections in the same test file.
    const observed = await withRestrictedObservation(alpha.companyId)

    expect(observed.role).toBe(APP_ROLE)
    expect(observed.isSuperuser).toBe(false)
    expect(observed.canBypassRls).toBe(false)
    expect(observed.ownedTenantTableCount).toBe(0)
    expect(observed.enabledCount).toBe(observed.tenantTableCount)
    expect(observed.forcedCount).toBe(observed.tenantTableCount)
    expect(observed.policyCount).toBe(observed.tenantTableCount)
    expect(observed.settingScope).toBe('transaction-local')

    expect(rlsStands(observed)).toEqual([])
  })

  it('names each way this control can be installed and do nothing', () => {
    expect(RLS_BYPASSES).toHaveLength(5)

    // Four of the five leave the database *reporting* that RLS is on, which is
    // the reason the register exists: a control that lies about itself is worse
    // than one that is absent, because its absence is legible.
    const lookLikeSuccess = RLS_BYPASSES.filter((bypass) =>
      /[Pp]erfect|Isolation works|is full/.test(bypass.appearance),
    )
    expect(lookLikeSuccess).toHaveLength(5)

    for (const bypass of RLS_BYPASSES) {
      expect(bypass.remedy.length, bypass.reason).toBeGreaterThan(30)
    }

    expect(() => bypassFor('vibes')).toThrow(RegistryError)
    expect(bypassFor('superuser').reason).toBe('superuser')
  })

  it('catches every bypass it declares, on a fixture', () => {
    /**
     * Each fault exercised, because a security check whose failing branches have
     * never been seen is the thing this phase exists to avoid repeating.
     */
    const sound: RlsObservation = {
      role: APP_ROLE,
      isSuperuser: false,
      canBypassRls: false,
      ownedTenantTableCount: 0,
      tenantTableCount: 163,
      enabledCount: 163,
      forcedCount: 163,
      policyCount: 163,
      settingScope: 'transaction-local',
    }

    expect(rlsStands(sound)).toEqual([])

    expect(rlsStands({ ...sound, isSuperuser: true })[0]).toContain('is a superuser')
    expect(rlsStands({ ...sound, canBypassRls: true })[0]).toContain('BYPASSRLS')
    expect(
      rlsStands({ ...sound, ownedTenantTableCount: 163, forcedCount: 0 })[0],
    ).toContain('owns 163 of the tables')
    expect(rlsStands({ ...sound, enabledCount: 100 })[0]).toContain(
      '63 tenant-scoped tables do not have row level security enabled',
    )
    expect(rlsStands({ ...sound, policyCount: 156 })[0]).toContain('no tenant_isolation policy')
    expect(rlsStands({ ...sound, settingScope: 'session' })[0]).toContain(
      'set for the session rather than the transaction',
    )
  })
})

describe('how far this got, stated rather than implied', () => {
  it('says the application is not behind the policies yet', () => {
    /**
     * Phase 139's device: a staged core gets a register and an acceptance test.
     * This file is the acceptance test; `RLS_ROLLOUT` is the register.
     *
     * The alternative to shipping it this way was shipping inert policies and
     * calling them isolation, or not shipping until somebody changes a
     * DATABASE_URL this session cannot change. The register is what makes the
     * third option honest.
     */
    // Three since Phase 161 added a second live surface: real service functions,
    // which `withTenant` could not reach when this test was written because 903
    // call sites read the module-level `db` and 802 entry points had no executor
    // parameter to pass one through.
    expect(RLS_ROLLOUT).toHaveLength(3)

    const live = RLS_ROLLOUT.filter((entry) => entry.state === 'live')
    expect(live.map((entry) => entry.surface)).toEqual([
      'tests/rls-bites.test.ts',
      'tests/a-report-through-the-policies.test.ts',
    ])

    const bypassed = RLS_ROLLOUT.filter((entry) => entry.state === 'bypassed')
    expect(bypassed[0].because).toContain('superuser')
    expect(bypassed[0].because).toContain('deployment change')

    expect(rolloutSummary()).toContain('does not yet apply to the application’s own connection')
  })

  it('generates the statements the migration ran', () => {
    // The pure core and the migration say the same thing, so a reader can check
    // one against the other — and the FORCE is second rather than absent, which
    // is the statement the whole phase turns on.
    const statements = policyStatementsFor('invoices')

    expect(statements[0]).toBe('ALTER TABLE invoices ENABLE ROW LEVEL SECURITY')
    expect(statements[1]).toBe('ALTER TABLE invoices FORCE ROW LEVEL SECURITY')
    expect(statements[3]).toContain(`FOR ALL TO ${APP_ROLE}`)
    expect(statements[3]).toContain('WITH CHECK')
    // With the `nullif` the acceptance test put there, which is the difference
    // between filtering and raising on a reused connection.
    expect(statements[3]).toContain(
      "nullif(current_setting('app.company_id', true), '')::uuid",
    )
  })
})

/** An observation taken on the restricted connection, inside a tenant transaction. */
async function withRestrictedObservation(companyId: string): Promise<RlsObservation> {
  return restricted.begin(async (tx) => {
    await tx`select set_config(${RLS_GUC}, ${companyId}, true)`

    const [role] = await tx`
      select current_user::text as role,
             (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
             (select rolbypassrls from pg_roles where rolname = current_user) as can_bypass
    `
    const [counts] = await tx`
      select
        count(*) filter (where c.relrowsecurity) as enabled,
        count(*) filter (where c.relforcerowsecurity) as forced,
        count(*) filter (where pg_get_userbyid(c.relowner) = current_user) as owned
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
        and c.relname = any(${policed()})
    `
    const [policies] = await tx`
      select count(*) as n from pg_policies
      where schemaname = 'public' and policyname = 'tenant_isolation'
        and tablename = any(${policed()})
    `
    const [tenant] = await tx`select current_setting(${RLS_GUC}, true) as company_id`

    return {
      role: role.role,
      isSuperuser: Boolean(role.is_superuser),
      canBypassRls: Boolean(role.can_bypass),
      ownedTenantTableCount: Number(counts.owned),
      tenantTableCount: policed().length,
      enabledCount: Number(counts.enabled),
      forcedCount: Number(counts.forced),
      policyCount: Number(policies.n),
      settingScope: tenant.company_id === null ? 'unset' : 'transaction-local',
    }
  })
}
