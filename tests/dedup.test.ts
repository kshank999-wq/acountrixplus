import { describe, expect, it } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { connectInstitution, syncConnection } from '@/modules/banking/sync'
import { MockBankProvider } from '@/modules/banking/mock-provider'

/**
 * Bank-feed deduplication (spec §3, §19, §21).
 *
 * The dedup guarantee is a database unique constraint over
 * (companyId, financialAccountId, providerTransactionId), so these tests
 * exercise the real import path rather than a mocked-out check.
 */
describe('bank import deduplication', () => {
  it('imports the mock feed on first sync', async () => {
    const fixture = await createCompanyFixture()

    const { connectionId, accountsCreated } = await connectInstitution(fixture.ctx, {
      publicToken: 'demo',
    })
    expect(accountsCreated).toBeGreaterThan(0)

    const summary = await syncConnection(fixture.ctx, connectionId)

    expect(summary.imported).toBeGreaterThan(0)
    expect(summary.duplicates).toBe(0)
  })

  it('imports nothing new when the same window is synced twice', async () => {
    const fixture = await createCompanyFixture()
    const { connectionId } = await connectInstitution(fixture.ctx, { publicToken: 'demo' })

    const first = await syncConnection(fixture.ctx, connectionId)
    const second = await syncConnection(fixture.ctx, connectionId)

    expect(first.imported).toBeGreaterThan(0)
    // Every row on the second pass is recognised as already present.
    expect(second.imported).toBe(0)
    expect(second.duplicates).toBe(first.imported)

    const [{ total }] = await db
      .select({ total: count() })
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))

    expect(Number(total)).toBe(first.imported)
  })

  it('stays stable across many repeated syncs', async () => {
    const fixture = await createCompanyFixture()
    const { connectionId } = await connectInstitution(fixture.ctx, { publicToken: 'demo' })

    const first = await syncConnection(fixture.ctx, connectionId)
    for (let i = 0; i < 4; i++) {
      const repeat = await syncConnection(fixture.ctx, connectionId)
      expect(repeat.imported).toBe(0)
    }

    const [{ total }] = await db
      .select({ total: count() })
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))

    expect(Number(total)).toBe(first.imported)
  })

  it('keeps two companies\' identical provider ids apart', async () => {
    // The same sandbox feed imported by two tenants must produce two
    // independent sets of rows, not a collision.
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaConnection = await connectInstitution(alpha.ctx, { publicToken: 'same-token' })
    const betaConnection = await connectInstitution(beta.ctx, { publicToken: 'same-token' })

    const alphaSummary = await syncConnection(alpha.ctx, alphaConnection.connectionId)
    const betaSummary = await syncConnection(beta.ctx, betaConnection.connectionId)

    expect(alphaSummary.imported).toBeGreaterThan(0)
    // Beta is not blocked by Alpha having already imported the same ids.
    expect(betaSummary.imported).toBe(alphaSummary.imported)
    expect(betaSummary.duplicates).toBe(0)
  })

  it('generates stable ids for the same connection', async () => {
    const provider = new MockBankProvider({
      months: 2,
      referenceDate: new Date('2026-06-15T00:00:00Z'),
    })

    const first = await provider.fetchTransactions('mock-item-demo')
    const second = await provider.fetchTransactions('mock-item-demo')

    expect(first.transactions.length).toBeGreaterThan(0)
    expect(first.transactions.map((t) => t.providerTransactionId)).toEqual(
      second.transactions.map((t) => t.providerTransactionId),
    )
  })

  it('never emits a duplicate id within one fetch', async () => {
    const provider = new MockBankProvider({
      months: 3,
      referenceDate: new Date('2026-06-15T00:00:00Z'),
    })

    const page = await provider.fetchTransactions('mock-item-demo')
    const ids = page.transactions.map((t) => t.providerTransactionId)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rejects a duplicate provider id at the database level', async () => {
    const fixture = await createCompanyFixture()

    const values = {
      companyId: fixture.companyId,
      financialAccountId: fixture.financialAccountId,
      providerTransactionId: 'fixed-id-001',
      postedDate: '2026-08-01',
      amountCents: -1_000,
      description: 'ONE',
    }

    await db.insert(bankTransactions).values(values)

    // The constraint is the real guarantee — not an application-level check.
    await expect(
      db.insert(bankTransactions).values({ ...values, description: 'TWO' }),
    ).rejects.toThrow()
  })
})
