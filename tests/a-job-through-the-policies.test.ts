import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { backgroundJobs, domainEvents } from '@/db/schema'
import { currentTenantScope } from '@/db/tenant-scope'
import { APP_ROLE, RLS_EXEMPT, RLS_ROLLOUT, exemptionFor } from '@/modules/tenancy/rls'
import { registerHandler, getHandler } from '@/modules/worker/registry'
import { enqueue } from '@/modules/worker/queue'
import { runOnce } from '@/modules/worker/runner'
import { listAccounts } from '@/modules/coa/service'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * A job through the policies (Phase 162).
 *
 * ADR 0161 nominated *"opening the scope on one real surface — the accounting
 * reports page"*. It does not work, and the first test below is the three-line
 * reason: **an AsyncLocalStorage scope does not survive the function that
 * opened it returning.** A page calls `requireActor()` and returns an element
 * tree whose async children React invokes *afterwards*, so a scope opened in the
 * page body covers the construction of the tree and none of the fetching inside
 * it. There are ~397 such boundaries — 97 async server components and 300 server
 * actions — not one page.
 *
 * The worker is different, and it is why this phase went there: `runJob`
 * dispatches **every** background job from one function and already holds the
 * company, so there is one boundary and one edit covers all 24 handlers.
 *
 * Wiring it found that Phase 160 had taken the queue out.
 */

const TEST_PASSWORD = 'job-through-policies'

let alpha: Fixture
let beta: Fixture

/** What the handler saw, keyed by the company it ran for. */
const seen = new Map<string, { scope: string | undefined; accountCount: number }>()

beforeAll(() => {
  // A handler that does what a real one does: call a service that reads the
  // module-level `db` and has never heard of row level security.
  registerHandler({
    kind: 'test.counts_accounts',
    label: 'Counts a company’s accounts (Phase 162 fixture)',
    handler: async ({ actor, companyId }) => {
      const accounts = actor ? await listAccounts(actor) : []
      seen.set(companyId ?? 'none', {
        scope: currentTenantScope()?.companyId,
        accountCount: accounts.length,
      })
      return { counted: accounts.length }
    },
  })

  registerHandler({
    kind: 'test.always_fails',
    label: 'Always fails (Phase 162 fixture)',
    handler: async () => {
      throw new Error('deliberate failure')
    },
  })

  registerHandler({
    kind: 'test.global_thing',
    label: 'A global job (Phase 162 fixture)',
    global: true,
    handler: async ({ companyId }) => {
      seen.set('global', { scope: currentTenantScope()?.companyId, accountCount: -1 })
      expect(companyId).toBeNull()
      return {}
    },
  })
})

beforeEach(async () => {
  seen.clear()
  alpha = await createCompanyFixture({ name: 'Alpha Joinery' })
  beta = await createCompanyFixture({ name: 'Beta Builders' })
})

afterAll(async () => {
  await db.execute(sql.raw(`ALTER ROLE ${APP_ROLE} NOLOGIN PASSWORD NULL`)).catch(() => undefined)
})

describe('why the scope cannot be opened where ADR 0161 said', () => {
  it('does not survive the function that opened it returning', async () => {
    /**
     * The measurement that refuted the nomination, isolated from React so it is
     * about the mechanism rather than about a framework version.
     *
     * A parent runs inside a scope and returns a tree holding child *functions*.
     * The renderer calls them after the parent has returned — which is exactly
     * what an async server component is, and exactly what a page's nine report
     * children are.
     */
    const als = new AsyncLocalStorage<{ tenant: string }>()

    const { insideParent, child } = await als.run({ tenant: 'alpha' }, async () => ({
      insideParent: als.getStore()?.tenant ?? null,
      child: async () => als.getStore()?.tenant ?? null,
    }))

    expect(insideParent).toBe('alpha')

    // The child, invoked after the parent returned. This is the finding.
    expect(await child()).toBeNull()

    // And the control: the same child inside a scope sees one, so the mechanism
    // works and the boundary is the problem.
    await als.run({ tenant: 'beta' }, async () => {
      expect(await child()).toBe('beta')
    })
  })
})

describe('the queue the policies had taken out', () => {
  it('declares both queue tables exempt, on a ground of their own', () => {
    /**
     * `crosses-tenants-by-design` is a second ground, argued rather than bent
     * onto `establishes-the-tenant` (Phase 130): nothing reads these two to find
     * out who the caller is. A poller reads every company's jobs because that is
     * what a poller is.
     */
    expect(exemptionFor('background_jobs')?.ground).toBe('crosses-tenants-by-design')
    expect(exemptionFor('domain_events')?.ground).toBe('crosses-tenants-by-design')

    const byGround = new Map<string, string[]>()
    for (const exemption of RLS_EXEMPT) {
      byGround.set(exemption.ground, [...(byGround.get(exemption.ground) ?? []), exemption.table])
    }

    expect(byGround.get('establishes-the-tenant')?.sort()).toEqual([
      'devices',
      'memberships',
      'practice_engagements',
      'security_policies',
    ])
    expect(byGround.get('crosses-tenants-by-design')?.sort()).toEqual([
      'background_jobs',
      'domain_events',
    ])
  })

  it('leaves them unpoliced in the database, and the count at 162', async () => {
    const rows = (await db.execute(sql`
      select
        (select count(*)::int from pg_class where relrowsecurity) as policed,
        (select count(*)::int from pg_class
           where relname in ('background_jobs', 'domain_events') and relrowsecurity) as queue
    `)) as unknown as Array<{ policed: number; queue: number }>

    expect(rows[0].queue).toBe(0)
    /*
      163 from Phase 160, less the two this phase exempted, plus
      `bank_transaction_revisions` — which Phase 177 added tenant-scoped and
      unpoliced, and Phase 179 policed.

      **This line is Phase 179's own eleventh finding, and it is the phase's
      subject committed inside the phase.** The audit read this file while
      measuring the policed count, used the 161 here as *evidence* that 161 was
      right, and then moved the count to 162 with a migration without coming
      back to it. The verification run is what caught it — which is the argument
      for running the suite again after fixing it, rather than reasoning that
      the fixes were obviously sufficient.
    */
    expect(rows[0].policed).toBe(162)
  })

  it('names what policing them would have done, because it would have been silent', () => {
    // The consequence is the field that matters on these two. Nothing errors
    // when a poller sees nothing — "the queue is empty" and "nothing can see the
    // queue" render identically, which `runner.ts`'s heartbeat comment already
    // calls an outage that looks like calm.
    expect(exemptionFor('background_jobs')?.consequence).toContain('queue never drains')
    expect(exemptionFor('background_jobs')?.consequence).toContain('retry forever')
    expect(exemptionFor('domain_events')?.consequence).toContain('never fanned out')
  })
})

describe('a job runs inside a tenant scope', () => {
  it('gives withTenant its first production caller', async () => {
    /**
     * Phase 160 shipped `withTenant` and nothing could call it. Phase 161 made
     * the tenant travel on the connection rather than in a parameter. This is
     * the line that uses both: one edit in `runJob`, covering all 24 registered
     * handlers, none of which changed.
     */
    await enqueue({ kind: 'test.counts_accounts', companyId: alpha.companyId, payload: {} })

    const result = await runOnce({ batchSize: 5 })
    expect(result.jobsSucceeded).toBeGreaterThan(0)

    const observed = seen.get(alpha.companyId)
    expect(observed?.scope).toBe(alpha.companyId)
    // And the service it called worked — reading the module-level `db` from
    // inside the scope, three levels down from the line that opened it.
    expect(observed?.accountCount).toBeGreaterThan(10)
  })

  it('scopes each job to its own company, one tick at a time', async () => {
    // Two companies' jobs in one tick. Each handler must see its own scope, not
    // the previous job's — which is what `withTenant`'s per-job transaction
    // gives and a session-scoped setting would not.
    await enqueue({ kind: 'test.counts_accounts', companyId: alpha.companyId, payload: {} })
    await enqueue({ kind: 'test.counts_accounts', companyId: beta.companyId, payload: {} })

    await runOnce({ batchSize: 5 })

    expect(seen.get(alpha.companyId)?.scope).toBe(alpha.companyId)
    expect(seen.get(beta.companyId)?.scope).toBe(beta.companyId)
  })

  it('unbinds the scope between jobs, so nothing inherits one', async () => {
    await enqueue({ kind: 'test.counts_accounts', companyId: alpha.companyId, payload: {} })
    await runOnce({ batchSize: 5 })

    expect(currentTenantScope()).toBeUndefined()
  })

  it('runs a global handler with no scope, and says so rather than inventing one', async () => {
    /**
     * The honest half of this surface. A global handler has no company, so there
     * is nothing to set — it runs on the pooled handle and would see nothing
     * once the application connects as a restricted role.
     *
     * Recorded in `RLS_ROLLOUT` rather than papered over: five of the 24
     * handlers are global, and they are the part of the worker this phase does
     * not finish.
     */
    await enqueue({ kind: 'test.global_thing', payload: {} })
    await runOnce({ batchSize: 5 })

    expect(seen.get('global')?.scope).toBeUndefined()
    expect(getHandler('test.global_thing')?.global).toBe(true)
  })

  it('still records a failure, because the bookkeeping is outside the scope', async () => {
    /**
     * `completeJob` and `failJob` write to `background_jobs` and run *outside*
     * the tenant scope on purpose. Inside it, the bookkeeping would depend on a
     * scope the global jobs do not have; and before this phase exempted the
     * table, a policed `failJob` would have affected zero rows and the job would
     * have retried until it died — with nothing in the log to say why.
     */
    const { id, enqueued } = await enqueue({
      kind: 'test.always_fails',
      companyId: alpha.companyId,
      payload: {},
    })
    expect(enqueued).toBe(true)
    expect(id).not.toBeNull()

    await runOnce({ batchSize: 5 })

    const [row] = await db
      .select({ attempts: backgroundJobs.attempts, lastError: backgroundJobs.lastError })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, id!))

    expect(row.attempts).toBeGreaterThan(0)
    expect(row.lastError).toContain('deliberate failure')
  })

  it('still claims across tenants, which is what a poller is', async () => {
    // The reason the exemption exists, asserted from the behaviour rather than
    // from the policy: one tick drains both companies' work.
    await enqueue({ kind: 'test.counts_accounts', companyId: alpha.companyId, payload: {} })
    await enqueue({ kind: 'test.counts_accounts', companyId: beta.companyId, payload: {} })

    const result = await runOnce({ batchSize: 5 })

    expect(result.jobsRun).toBe(2)
    expect(seen.size).toBe(2)
  })

  it('does not stop the outbox reading every company’s events', async () => {
    // `relayPendingEvents` has no company filter either. Proven by writing an
    // unrelayed event for each company and counting what a global read sees.
    for (const fixture of [alpha, beta]) {
      await db.insert(domainEvents).values({
        companyId: fixture.companyId,
        type: 'proposal.accepted',
        entityType: 'proposal',
        entityId: fixture.companyId,
        payload: {},
      })
    }

    const rows = (await db.execute(sql`
      select count(distinct company_id)::int as companies
      from domain_events where relayed_at is null
    `)) as unknown as Array<{ companies: number }>

    expect(rows[0].companies).toBeGreaterThanOrEqual(2)
  })
})

describe('how far this got', () => {
  it('counts the worker live and the web boundaries not', () => {
    const live = RLS_ROLLOUT.filter((entry) => entry.state === 'live').map((e) => e.surface)
    expect(live).toContain('the background worker (modules/worker/runner.ts)')

    const bypassed = RLS_ROLLOUT.filter((entry) => entry.state === 'bypassed')
    expect(bypassed).toHaveLength(1)
    expect(bypassed[0].surface).toBe('the application’s own connection')
  })

  it('still has every tenant job handler going through the one boundary', async () => {
    /**
     * The tripwire. There is exactly one place a job handler is invoked, and a
     * second one added later would bypass the scope silently — the handler would
     * work on the owner connection and return nothing on a restricted one.
     *
     * Measured from the source rather than trusted, the same way this codebase
     * has counted reads and writes since Phase 149.
     */
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/modules/worker/runner.ts', 'utf8')

    const invocations = [...source.matchAll(/definition\.handler\(/g)]
    expect(invocations).toHaveLength(2)

    // Both in the one ternary: the global branch without a scope, the tenant
    // branch inside `withTenant`. If a third appears, decide which it is.
    expect(source).toContain('withTenant({ companyId: job.companyId }, () => definition.handler(context))')
  })
})
