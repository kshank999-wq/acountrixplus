import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { db } from '@/db'
import { APP_ROLE } from '@/modules/tenancy/rls'
import {
  CROSS_TENANT_PATHS,
  CrossTenantBlindError,
  assertCrossTenantSight,
  crossTenantPathFor,
  crossTenantSight,
  crossTenantTables,
} from '@/modules/tenancy/cross-tenant'
import { RETENTION_POLICIES } from '@/modules/retention/policy'
import { RegistryError } from '@/modules/errors/registry'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * A blinded sweep (Phase 163).
 *
 * ## Three instances of one shape
 *
 * Phase 162 found that policing the queue takes all background processing out,
 * silently, because an empty result is a valid result. Measuring the five
 * `global` job handlers for this phase found four more cross-tenant paths, and
 * one worse than the queue: `housekeeping.retention` sweeps every company's
 * expiring rows and returns `{ removed: 0, byPolicy: {} }` when blinded — the
 * same thing it returns when there was nothing to remove — and the job is
 * recorded as **succeeded**.
 *
 * ## What this file is about
 *
 * **A count cannot tell an empty table from an invisible one.** Both are zero,
 * and no care at the call site fixes that because the information is not in the
 * result. It is in the catalogue, and these tests are mostly about proving that
 * the catalogue answer is right on two real connections — one that can see
 * across tenants and one that cannot.
 */

const TEST_PASSWORD = 'blinded-sweep'

let restricted: ReturnType<typeof postgres>
let restrictedDb: ReturnType<typeof drizzle<typeof schema>>
let fixture: Fixture

beforeAll(async () => {
  await db.execute(sql.raw(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${TEST_PASSWORD}'`))

  const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '')
  url.username = APP_ROLE
  url.password = TEST_PASSWORD

  restricted = postgres(url.toString(), { max: 2, prepare: false })
  restrictedDb = drizzle(restricted, { schema })
})

afterAll(async () => {
  await restricted?.end()
  await db.execute(sql.raw(`ALTER ROLE ${APP_ROLE} NOLOGIN PASSWORD NULL`))
})

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Sweepable Ltd' })
})

describe('the register of paths that must see every tenant', () => {
  it('names six, under three authorities', () => {
    expect(CROSS_TENANT_PATHS).toHaveLength(6)

    const byAuthority = new Map<string, string[]>()
    for (const path of CROSS_TENANT_PATHS) {
      byAuthority.set(path.authority, [...(byAuthority.get(path.authority) ?? []), path.path])
    }

    expect([...byAuthority.keys()].sort()).toEqual([
      'a-practice-engagement',
      'the-retention-policy',
      'the-schedule',
    ])
  })

  it('tells the one positive grant apart from the two absences', () => {
    /**
     * `a-practice-engagement` is its own authority rather than folded into
     * `the-schedule`, because it is the only one of the three a policy could
     * express: a firm may see its clients because somebody signed an
     * engagement. The other two are the *absence* of a tenant — there is no
     * company whose setting would be correct for draining a queue.
     */
    const practice = crossTenantPathFor('worker/handlers/practice:morning_brief')
    expect(practice.authority).toBe('a-practice-engagement')
    expect(practice.because).toContain('positive grant')

    // And it is the only one of the six that is honest when blinded, which is
    // why it is not guarded.
    const silent = CROSS_TENANT_PATHS.filter((path) => path.silentWhenBlinded)
    expect(silent).toHaveLength(5)
    expect(practice.silentWhenBlinded).toBe(false)
  })

  it('derives the swept tables rather than listing them again', () => {
    /**
     * `RETENTION_POLICIES` is the authority on what gets swept. A second copy
     * here would be the one that goes stale when a policy is added, leaving a
     * table swept by a path this register says nothing about — which is the
     * exact failure the register exists to prevent, one level up.
     */
    const sweep = crossTenantPathFor('retention/sweep:sweepAll')

    expect([...sweep.tables].sort()).toEqual(RETENTION_POLICIES.map((p) => p.table).sort())
    expect(sweep.tables.length).toBeGreaterThan(8)
  })

  it('names functions that exist', () => {
    // Phase 141's rule against this registry's own claims: declare the
    // knowledge, measure the fact.
    const faults: string[] = []

    for (const entry of CROSS_TENANT_PATHS) {
      const [modulePath, fn] = entry.path.split(':')
      const file = `src/modules/${modulePath}.ts`
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        faults.push(`${entry.path}: no file ${file}`)
        continue
      }
      // A handler is registered by kind rather than exported, so either shape
      // counts as the function existing.
      const asFunction = new RegExp(`^export (?:async )?function ${fn}\\b`, 'm')
      const asHandler = new RegExp(`kind: '[\\w.]*${fn}'`)
      if (!asFunction.test(source) && !asHandler.test(source)) {
        faults.push(`${entry.path}: ${file} has no ${fn}`)
      }
    }

    expect(faults).toEqual([])
  })

  it('refuses a path nobody declared', () => {
    expect(() => crossTenantPathFor('worker/queue:somethingElse')).toThrow(RegistryError)
    expect(() => crossTenantPathFor('nope')).toThrow(/returns zero rows and reports success/)
  })
})

describe('the catalogue answer, on two real connections', () => {
  it('finds nothing blind on the owner connection', async () => {
    // `postgres` is a superuser, so row level security is skipped before any
    // policy is consulted — the honest state Phase 160 recorded.
    expect(await crossTenantSight(crossTenantTables())).toEqual([])
  })

  it('finds the swept tables blind on the restricted one', async () => {
    /**
     * The assertion the phase turns on. `accountrix_app` is subject to the
     * tenant policy, so the tables the retention sweep must see across tenants
     * are invisible to it without a scope — and *that is not discoverable from a
     * row count*, because the counts would be zero either way.
     */
    const sweep = crossTenantPathFor('retention/sweep:sweepAll')
    const blind = await crossTenantSight(sweep.tables, restrictedDb)

    expect(blind.length).toBeGreaterThan(0)
    // The policed ones are blind; the ones Phase 160 never policed are not.
    expect(blind).toContain('proposal_views')
    expect(blind).not.toContain('login_attempts')
  })

  it('does not call the queue blind, because Phase 162 exempted it', async () => {
    // The two queue tables are unpoliced, so a restricted connection sees them
    // across tenants — which is what makes the worker tick work at all today.
    expect(await crossTenantSight(['background_jobs'], restrictedDb)).toEqual([])
    expect(await crossTenantSight(['domain_events'], restrictedDb)).toEqual([])
  })

  it('tells an empty table apart from an invisible one', async () => {
    /**
     * The distinction a count cannot make, demonstrated rather than argued.
     *
     * `proposal_views` is empty for this fresh company **and** policed. A count
     * on either connection returns 0. The catalogue says the owner can see it
     * and the restricted role cannot, which is the whole difference between
     * "nothing to sweep" and "cannot sweep".
     */
    const ownerCount = (await db.execute(
      sql`select count(*)::int as n from proposal_views`,
    )) as unknown as Array<{ n: number }>
    const restrictedCount = (await restrictedDb.execute(
      sql`select count(*)::int as n from proposal_views`,
    )) as unknown as Array<{ n: number }>

    // Identical, and meaningless.
    expect(ownerCount[0].n).toBe(0)
    expect(restrictedCount[0].n).toBe(0)

    // Not identical, and decisive.
    expect(await crossTenantSight(['proposal_views'])).toEqual([])
    expect(await crossTenantSight(['proposal_views'], restrictedDb)).toEqual(['proposal_views'])
  })

  it('reports a table the register names and the database does not have', async () => {
    // A stale register entry is also something to report, rather than pass by
    // saying nothing was blind.
    expect(await crossTenantSight(['no_such_table_here'])).toEqual([
      'no_such_table_here (no such table)',
    ])
  })
})

describe('a blinded path refuses to run', () => {
  it('throws rather than sweeping nothing and reporting success', async () => {
    /**
     * What the retention handler now does before calling `sweepAll`. Run on the
     * restricted connection it raises; before this phase it would have returned
     * `{ removed: 0, byPolicy: {} }` and the job would have been recorded as
     * succeeded.
     */
    await expect(
      assertCrossTenantSight('retention/sweep:sweepAll', restrictedDb),
    ).rejects.toThrow(CrossTenantBlindError)

    await expect(
      assertCrossTenantSight('retention/sweep:sweepAll', restrictedDb),
    ).rejects.toThrow(/must see every tenant and cannot see/)
  })

  it('says what authority it was relying on, so the refusal is actionable', async () => {
    const error = await assertCrossTenantSight(
      'retention/sweep:sweepAll',
      restrictedDb,
    ).then(
      () => null,
      (caught: unknown) => caught as CrossTenantBlindError,
    )

    expect(error?.name).toBe('CrossTenantBlindError')
    expect(error?.message).toContain('the-retention-policy')
    expect(error?.message).toContain('would do nothing and report success')
    expect(error?.blinded.length).toBeGreaterThan(0)
  })

  it('passes on the owner connection, which is why the worker still ticks', async () => {
    // Seen to agree as well as to disagree (Phase 121), on two real connections
    // in one file.
    await expect(assertCrossTenantSight('retention/sweep:sweepAll')).resolves.toBeUndefined()
    await expect(assertCrossTenantSight('worker/queue:claimJobs')).resolves.toBeUndefined()
    await expect(
      assertCrossTenantSight('worker/outbox:relayPendingEvents'),
    ).resolves.toBeUndefined()
  })

  it('is wired in front of the two paths whose silence costs most', () => {
    /**
     * Measured from the source rather than trusted. Not in front of all six: the
     * catalogue query costs a round trip, and this phase's argument is that the
     * information belongs at the start of the work rather than at every
     * statement. The register's `silentWhenBlinded` says which paths need it;
     * the sweep and the tick are the ones guarded.
     */
    const runner = readFileSync('src/modules/worker/runner.ts', 'utf8')
    expect(runner).toContain("assertCrossTenantSight('worker/queue:claimJobs')")
    expect(runner).toContain("assertCrossTenantSight('worker/outbox:relayPendingEvents')")

    const retention = readFileSync('src/modules/worker/handlers/retention.ts', 'utf8')
    expect(retention).toContain("assertCrossTenantSight('retention/sweep:sweepAll')")

    // And before the work, not after — the whole point.
    expect(retention.indexOf('assertCrossTenantSight')).toBeLessThan(
      retention.indexOf('await sweepAll(asOf)'),
    )
  })

  it('leaves the worker tick working on the connection it actually uses', async () => {
    // The guard must not be the thing that breaks the queue. The owner
    // connection sees everything, so a tick runs as it did before.
    const { runOnce } = await import('@/modules/worker/runner')
    const tick = await runOnce({ batchSize: 1, workerId: `test-${fixture.companyId.slice(0, 8)}` })

    expect(tick.jobsRun).toBeGreaterThanOrEqual(0)
    expect(tick.eventsRelayed).toBeGreaterThanOrEqual(0)
  })
})
