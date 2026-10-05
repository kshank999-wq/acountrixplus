import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { db } from '@/db'
import { currentTenantScope, runInTenantScope } from '@/db/tenant-scope'
import { APP_ROLE, RLS_GUC, RLS_ROLLOUT } from '@/modules/tenancy/rls'
import { withTenant } from '@/modules/tenancy/with-tenant'
import { trialBalance, accountBalances } from '@/modules/ledger/balances'
import { arAging } from '@/modules/ledger/reports'
import { listAccounts } from '@/modules/coa/service'
import { postManualEntry } from '@/modules/ledger/journal'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * A real report, through the policies (Phase 161).
 *
 * Phase 160 installed row level security and `withTenant`. Then nothing called
 * it, and measuring why found that nothing *could*:
 *
 * | measured | count |
 * | --- | --- |
 * | sites reaching the module-level `db` directly | 903 |
 * | service entry points taking an `ActorContext` | 802 |
 * | functions accepting an `Executor` | 149 |
 *
 * `withTenant(ctx, (tx) => trialBalance(ctx, range))` did nothing useful,
 * because `trialBalance` ignores an executor it was never given a parameter for
 * and reads `db`. So the tenant is now carried by the connection `db` resolves
 * to rather than by a parameter — one constraint instead of 903 checks — and
 * this file is the proof that a service function which has never heard of row
 * level security runs correctly behind it.
 *
 * Everything here runs on a connection as `accountrix_app`: not a superuser,
 * owning nothing, subject to the policies.
 */

const TEST_PASSWORD = 'report-through-policies'

/** The restricted driver and a drizzle handle over it. */
let restricted: ReturnType<typeof postgres>
let restrictedDb: ReturnType<typeof drizzle<typeof schema>>

let alpha: Fixture
let beta: Fixture

/** $4,000 of joinery for Alpha; $11 for Beta, so the two cannot be confused. */
const ALPHA_SALE = 400_000
const BETA_SALE = 1_100

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
  alpha = await createCompanyFixture({ name: 'Alpha Joinery' })
  beta = await createCompanyFixture({ name: 'Beta Builders' })

  for (const [fixture, amount] of [
    [alpha, ALPHA_SALE],
    [beta, BETA_SALE],
  ] as const) {
    const cash = await fixture.account('1000')
    const sales = await fixture.account('4000')
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-01',
      memo: 'A sale',
      lines: [
        { chartAccountId: cash.id, debitCents: amount },
        { chartAccountId: sales.id, creditCents: amount },
      ],
    })
  }
})

/**
 * Runs `fn` on the restricted connection with the tenant set, exactly as
 * `withTenant` does on the owner connection.
 *
 * Written out rather than reusing `withTenant` because that one opens its
 * transaction on the application's own pool, and the whole point here is to be
 * on a connection the policies apply to. The two do the same three things in the
 * same order, and `withTenant` is asserted against this behaviour below.
 */
async function asRestrictedTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  return restrictedDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${RLS_GUC}, ${companyId}, true)`)
    return runInTenantScope({ executor: tx, companyId }, fn)
  })
}

const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

describe('a service function that has never heard of row level security', () => {
  it('returns the same trial balance behind the policies as in front of them', async () => {
    /**
     * The assertion the phase is for. `trialBalance` takes an `ActorContext` and
     * no executor; it calls `accountBalances`, which reads the module-level
     * `db`. Neither mentions a tenant scope, a transaction or a policy.
     *
     * Run inside a scope on the restricted connection, it works — because `db`
     * resolved to the transaction that has `app.company_id` set, three call
     * levels below anything that knew about it.
     */
    const asOwner = await trialBalance(alpha.ctx, YEAR)
    const behindPolicies = await asRestrictedTenant(alpha.companyId, () =>
      trialBalance(alpha.ctx, YEAR),
    )

    expect(behindPolicies.totalDebitCents).toBe(ALPHA_SALE)
    expect(behindPolicies.totalDebitCents).toBe(asOwner.totalDebitCents)
    expect(behindPolicies.totalCreditCents).toBe(asOwner.totalCreditCents)
    expect(behindPolicies.isBalanced).toBe(true)
    expect(behindPolicies.rows.map((row) => row.number)).toEqual(
      asOwner.rows.map((row) => row.number),
    )
  })

  it('sees Alpha’s figures and not Beta’s, with the same code and a different scope', async () => {
    // The same function, the same arguments shape, two scopes. $4,000 against
    // $11 — deliberately far apart, so a leak could not pass as a rounding
    // difference.
    const asAlpha = await asRestrictedTenant(alpha.companyId, () =>
      trialBalance(alpha.ctx, YEAR),
    )
    const asBeta = await asRestrictedTenant(beta.companyId, () => trialBalance(beta.ctx, YEAR))

    expect(asAlpha.totalDebitCents).toBe(ALPHA_SALE)
    expect(asBeta.totalDebitCents).toBe(BETA_SALE)
  })

  it('works for the reports and the chart of accounts too, not just one query shape', async () => {
    /**
     * Three different modules, three different query shapes — a grouped sum, a
     * document-level aging read with its own joins and currency lookup, and a
     * plain list. None of them was touched by this phase.
     */
    const [balances, aging, accounts] = await asRestrictedTenant(alpha.companyId, async () => {
      return Promise.all([
        accountBalances(alpha.ctx, YEAR),
        arAging(alpha.ctx, { asOfDate: '2026-12-31' }),
        listAccounts(alpha.ctx),
      ])
    })

    expect(balances.length).toBeGreaterThan(0)
    expect(balances.every((row) => row.debitCents >= 0)).toBe(true)
    // An empty aging is the right answer — the sale was a journal entry, not an
    // invoice — and it is an answer rather than an error, which is the point.
    expect(aging.rows).toEqual([])
    expect(accounts.length).toBeGreaterThan(10)
  })

  it('sees nothing outside a scope, on the restricted connection', async () => {
    /**
     * The other half, and the reason the rollout is not finished. With no scope
     * open, `db` is the pooled handle, the policy finds no tenant, and every row
     * is filtered out. Fails closed — the right direction — and an outage rather
     * than a leak.
     *
     * Run through the restricted drizzle handle directly, because the
     * application's `db` is on the owner pool and would see everything.
     */
    const rows = await restrictedDb.execute(sql`select count(*)::int as n from chart_accounts`)

    expect((rows as unknown as Array<{ n: number }>)[0].n).toBe(0)
  })
})

describe('the scope that carries it', () => {
  it('is bound by withTenant and visible to code three levels down', async () => {
    expect(currentTenantScope()).toBeUndefined()

    const seen = await withTenant(alpha, async () => {
      // Not the executor the callback was handed — the ambient scope, which is
      // what the 903 unchanged call sites resolve through.
      return currentTenantScope()?.companyId
    })

    expect(seen).toBe(alpha.companyId)
    expect(currentTenantScope()).toBeUndefined()
  })

  it('hands the executor to callers that want it, and both forms agree', async () => {
    // 149 functions already accept an `Executor` for transaction reasons and
    // should keep being passed it rather than opening a savepoint of their own.
    // The two styles have to produce the same figures or the proxy is lying.
    const [viaExecutor, viaAmbient] = await withTenant(alpha, async (tx) => {
      const explicit = await tx.execute(sql`select count(*)::int as n from chart_accounts`)
      const ambient = await db.execute(sql`select count(*)::int as n from chart_accounts`)
      return [explicit, ambient] as const
    })

    const count = (rows: unknown) => (rows as Array<{ n: number }>)[0].n
    expect(count(viaExecutor)).toBe(count(viaAmbient))
    expect(count(viaAmbient)).toBeGreaterThan(0)
  })

  it('is re-entrant for the same company, rather than nesting', async () => {
    /**
     * A report that calls two services which each open a scope should be one
     * transaction, not three. Asserted by identity: the inner scope is the outer
     * one, so nothing nested.
     */
    await withTenant(alpha, async (outer) => {
      const outerScope = currentTenantScope()

      await withTenant(alpha, async (inner) => {
        expect(currentTenantScope()).toBe(outerScope)
        expect(inner).toBe(outer)
      })
    })
  })

  it('refuses a scope for another company inside one', async () => {
    /**
     * The guard worth having. Without it the inner `set_config` succeeds, every
     * query in the *outer* scope after that point silently runs as the inner
     * company, and both are filtering correctly on the value they were given —
     * a cross-tenant read with nothing to say so.
     *
     * There is no legitimate reason for one request to do this, so it is an
     * error rather than something to handle.
     */
    await expect(
      withTenant(alpha, async () => {
        return withTenant(beta, async () => 'should not get here')
      }),
    ).rejects.toThrow(/Refusing to open a tenant scope/)
  })

  it('unbinds the scope when the body throws', async () => {
    await expect(
      withTenant(alpha, async () => {
        throw new Error('deliberate')
      }),
    ).rejects.toThrow('deliberate')

    expect(currentTenantScope()).toBeUndefined()
  })

  it('leaves db as the pooled handle when nothing has opened a scope', async () => {
    /**
     * Why applying this phase changes nothing until a scope is opened, which is
     * the claim `RLS_ROLLOUT` makes and this asserts. Every one of the 903 call
     * sites behaves exactly as it did before.
     */
    expect(currentTenantScope()).toBeUndefined()

    const accounts = await listAccounts(alpha.ctx)
    expect(accounts.length).toBeGreaterThan(10)

    // And it can still see both companies, because the owner connection
    // bypasses the policies — the honest state Phase 160 recorded.
    const rows = (await db.execute(
      sql`select count(distinct company_id)::int as n from chart_accounts`,
    )) as unknown as Array<{ n: number }>
    expect(rows[0].n).toBeGreaterThanOrEqual(2)
  })
})

describe('how far this got', () => {
  it('says the application still has to open a scope somewhere', () => {
    /**
     * Phase 139's device again. The mechanism now reaches every query without a
     * signature change, and something still has to call `withTenant` once per
     * request — and Next.js's App Router has no single place that wraps a
     * render, so that is a per-surface change rather than a line.
     *
     * Recorded rather than implied, because "row level security works" and "row
     * level security is on" are different sentences and only one of them is
     * true.
     */
    const live = RLS_ROLLOUT.filter((entry) => entry.state === 'live').map(
      (entry) => entry.surface,
    )

    expect(live).toContain('tests/rls-bites.test.ts')
    expect(live).toContain('tests/a-report-through-the-policies.test.ts')

    const bypassed = RLS_ROLLOUT.filter((entry) => entry.state === 'bypassed')
    expect(bypassed).toHaveLength(1)
    expect(bypassed[0].because).toContain('superuser')
  })
})
