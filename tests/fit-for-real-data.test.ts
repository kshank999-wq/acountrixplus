import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RegistryError } from '@/modules/errors/registry'
import {
  DEPLOY_CHECKS,
  type Environment,
  assessDeployment,
  deployCheckFor,
  formatReadiness,
  readinessStands,
} from '@/modules/deploy/readiness'

/**
 * Whether a deployment is fit for real data (Phase 175).
 *
 * No database, no clock, no `process.env` — the module takes the environment as
 * an argument, which is what makes this testable without mutating globals and
 * what lets the same function answer for a *remote* deployment through
 * `/api/health`.
 *
 * ## What this is for
 *
 * Every adapter in this codebase falls back to a mock when its variable is
 * unset, and that default is right — it is what lets 4,200 tests run with no
 * credentials. It is also the shape Phase 160 called the dangerous one: a
 * deployment with no mail provider does not refuse to send a password reset. It
 * logs the link, returns `{ ok: true }`, and the person waiting concludes their
 * account is broken.
 */

/** The six variables that make a deployment fit. */
const CONFIGURED: Environment = {
  DATABASE_URL: 'postgres://user:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres',
  SESSION_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: 'b'.repeat(44),
  CRON_SECRET: 'c'.repeat(43),
  PUBLIC_BASE_URL: 'https://books.example.test',
  TRANSACTIONAL_EMAIL_PROVIDER: 'postmark',
  TRANSACTIONAL_FROM_EMAIL: 'books@example.test',
}

describe('the register itself', () => {
  it('argues every check, because the argument is the entry', () => {
    /**
     * Phase 101's device, and the floor is high here for a specific reason: the
     * question is never "is this variable set" but "what happens if it is not".
     * An entry that only names a variable tells the reader nothing they could
     * not get from `grep process.env`.
     */
    const problems = DEPLOY_CHECKS.flatMap((check) => readinessStands(check))
    expect(problems).toEqual([])
  })

  it('declares ten checks, counted rather than bounded', () => {
    // Phase 126.
    expect(DEPLOY_CHECKS).toHaveLength(10)
    expect(new Set(DEPLOY_CHECKS.map((check) => check.key)).size).toBe(10)
  })

  it('throws on a check nobody declared, naming the ones that exist', () => {
    expect(() => deployCheckFor('smtp-host')).toThrow(RegistryError)

    try {
      deployCheckFor('smtp-host')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('DEPLOY_CHECKS')
      expect((error as RegistryError).message).toContain('transactional-email')
    }
  })
})

describe('what makes a deployment unfit', () => {
  it('passes a fully configured environment', () => {
    const readiness = assessDeployment(CONFIGURED)

    expect(readiness.broken).toEqual([])
    expect(readiness.silent).toEqual([])
    expect(readiness.fitForRealData).toBe(true)
  })

  it('fails an empty environment on both counts', () => {
    const readiness = assessDeployment({})

    expect(readiness.fitForRealData).toBe(false)
    expect(readiness.broken.map((result) => result.key)).toEqual([
      'database-url',
      'session-secret',
    ])
    expect(readiness.silent.map((result) => result.key)).toEqual([
      'encryption-key',
      'cron-secret',
      'public-base-url',
      'transactional-email',
    ])
  })

  it('treats a blank variable as unset, because every hosting panel allows one', () => {
    // The same reason `getTransactionalProvider` uses `||` rather than `??`: a
    // variable saved as an empty string in a web form is not configuration.
    const readiness = assessDeployment({ ...CONFIGURED, SESSION_SECRET: '   ' })

    expect(readiness.broken.map((result) => result.key)).toEqual(['session-secret'])
  })

  it('refuses to call a deployment fit when mail only looks configured', () => {
    /**
     * The headline case. `getTransactionalProvider` throws for a provider that
     * is *named* and misconfigured — the typo — and defaults to the mock for
     * the omission. This is the omission, and it is the one that reaches a
     * person: the reset is "sent" and never arrives.
     */
    const noProvider = assessDeployment({
      ...CONFIGURED,
      TRANSACTIONAL_EMAIL_PROVIDER: undefined,
    })
    expect(noProvider.fitForRealData).toBe(false)
    expect(noProvider.silent.map((result) => result.key)).toContain('transactional-email')

    // Explicitly set to the mock is the same answer, not a different one: a
    // deployment that chose the mock on purpose still cannot mail anybody.
    const explicitMock = assessDeployment({
      ...CONFIGURED,
      TRANSACTIONAL_EMAIL_PROVIDER: 'mock',
    })
    expect(explicitMock.fitForRealData).toBe(false)

    // And a provider with no sender address is caught too, which is the half a
    // presence check on one variable would miss.
    const noSender = assessDeployment({
      ...CONFIGURED,
      TRANSACTIONAL_FROM_EMAIL: undefined,
    })
    expect(noSender.fitForRealData).toBe(false)
    expect(noSender.silent[0].detail).toContain('TRANSACTIONAL_FROM_EMAIL')
  })

  it('calls a missing worker secret a silent failure rather than a degradation', () => {
    /**
     * The severity is the finding. `/api/cron/worker` refuses every request
     * with `CRON_SECRET` unset — the right default — so the queue never drains
     * and *nothing errors*. Recurring invoices do not go out, retention does
     * not sweep, and the only symptom is work that quietly never happens.
     */
    const readiness = assessDeployment({ ...CONFIGURED, CRON_SECRET: undefined })

    expect(readiness.silent.map((result) => result.key)).toEqual(['cron-secret'])
    expect(readiness.fitForRealData).toBe(false)
  })
})

describe('what does not make a deployment unfit', () => {
  it('lets a missing bank aggregator through, because CSV import needs none', () => {
    /**
     * `degraded` rather than `silent-failure`, and the distinction is the one
     * that matters for a first real deployment: there is no aggregator adapter
     * in this codebase at all, so a connection attempt fails where somebody can
     * see it. Importing a statement as CSV needs no provider and is the path a
     * real business uses until an adapter exists.
     */
    const readiness = assessDeployment(CONFIGURED)
    const bank = readiness.results.find((result) => result.key === 'bank-provider')

    expect(bank?.ok).toBe(false)
    expect(bank?.severity).toBe('degraded')
    expect(readiness.fitForRealData).toBe(true)
    expect(bank?.detail).toContain('CSV')
  })

  it('lets a missing AI key through, because §23 makes AI additive', () => {
    const readiness = assessDeployment(CONFIGURED)
    const ai = readiness.results.find((result) => result.key === 'ai-module')

    expect(ai?.ok).toBe(false)
    expect(ai?.severity).toBe('note')
    expect(readiness.fitForRealData).toBe(true)
  })

  it('notes the session pooler without failing it', () => {
    /**
     * Wrong only at a scale a first deployment will not reach: port 5432 holds
     * a backend per request, which on a serverless platform exhausts the pool
     * under load. A note, because calling it a fault would stop somebody
     * deploying over a connection string that works.
     */
    const readiness = assessDeployment({
      ...CONFIGURED,
      DATABASE_URL: 'postgres://user:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres',
    })

    const pooler = readiness.results.find(
      (result) => result.key === 'database-url-not-session-pooler',
    )
    expect(pooler?.ok).toBe(false)
    expect(pooler?.detail).toContain('6543')
    expect(readiness.fitForRealData).toBe(true)
  })

  it('says nothing about a local database, which is not Supabase', () => {
    // The pooler check is specific to Supabase's two hosts. A local or
    // self-hosted Postgres on 5432 is simply correct, and a warning there would
    // be the register being wrong in the direction nobody can act on.
    const readiness = assessDeployment({
      ...CONFIGURED,
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/accountrix',
    })

    const pooler = readiness.results.find(
      (result) => result.key === 'database-url-not-session-pooler',
    )
    expect(pooler?.ok).toBe(true)
  })
})

describe('what it prints', () => {
  it('names every check and ends with the verdict', () => {
    const output = formatReadiness(assessDeployment({}))

    for (const check of DEPLOY_CHECKS) {
      expect(output, check.key).toContain(check.key)
    }
    expect(output).toContain('NOT fit for real data')
  })

  it('never prints a secret’s value', () => {
    /**
     * The one thing this output must not do. It reports whether a variable is
     * set, and `/api/health` serves the same structure behind `CRON_SECRET` —
     * so a value leaking into a detail string would leak through an endpoint
     * too.
     */
    const output = formatReadiness(assessDeployment(CONFIGURED))

    expect(output).not.toContain(CONFIGURED.SESSION_SECRET)
    expect(output).not.toContain(CONFIGURED.ENCRYPTION_KEY)
    expect(output).not.toContain(CONFIGURED.CRON_SECRET)
    // The database password, specifically — it is inside a URL the pooler check
    // reads, which is the one entry that parses a secret-bearing value.
    expect(output).not.toContain('pw@')
  })
})

describe('the deploy documentation', () => {
  it('states the migration count the journal actually holds', () => {
    /**
     * `docs/DEPLOY.md` said "all 38 migrations" while the journal held 95 — a
     * number that was true when it was written and had been wrong for 57
     * migrations, in the one document somebody follows while pointing a
     * production database at this repository.
     *
     * Exactly the defect this session kept finding in its own prose: four stale
     * "unauthenticated write path" counts, a stale write-register total, a
     * stale registry total. Fixing it again in a year is not the remedy; the
     * remedy is that the number is in a place something reads.
     */
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: unknown[]
    }
    const deploy = readFileSync('docs/DEPLOY.md', 'utf8')

    const claimed = deploy.match(/wraps all (\d+) migrations/)

    expect(claimed, 'DEPLOY.md no longer states a migration count').toBeTruthy()
    expect(Number(claimed![1])).toBe(journal.entries.length)
  })
})
