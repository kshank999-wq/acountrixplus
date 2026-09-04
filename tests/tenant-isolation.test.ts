import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { bankTransactions, chartAccounts } from '@/db/schema'
import { createCompanyFixture, insertTransaction } from './helpers'
import { listInbox, categorize, bulkCategorize, transactionHistory } from '@/modules/bookkeeping/transactions'
import { listAccounts, accountsByIds } from '@/modules/coa/service'
import { createRule, listRules } from '@/modules/bookkeeping/rules-engine'
import { recentActivity } from '@/modules/audit'
import { eq } from 'drizzle-orm'

/**
 * Tenant isolation (spec §14, §19, §21).
 *
 * Two companies exist side by side in one database throughout. Every test
 * asserts that company A cannot read or write anything belonging to company B.
 */
describe('tenant isolation', () => {
  it('scopes the transaction inbox to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    await insertTransaction(alpha, { amountCents: -5_000, description: 'ALPHA COFFEE' })
    await insertTransaction(beta, { amountCents: -9_900, description: 'BETA HARDWARE' })

    const alphaInbox = await listInbox(alpha.ctx)
    const betaInbox = await listInbox(beta.ctx)

    expect(alphaInbox.rows).toHaveLength(1)
    expect(alphaInbox.rows[0].description).toBe('ALPHA COFFEE')
    expect(betaInbox.rows).toHaveLength(1)
    expect(betaInbox.rows[0].description).toBe('BETA HARDWARE')
  })

  it('refuses to categorize another company\'s transaction', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const betaTransaction = await insertTransaction(beta, {
      amountCents: -1_000,
      description: 'BETA ONLY',
    })
    const alphaExpense = await alpha.account('6350')

    // Phase 120: the refusal is the tenancy boundary speaking. It says the
    // record is not on these books and nothing about whether it exists
    // elsewhere — a message that distinguished the cases would turn any id
    // into an oracle.
    await expect(
      categorize(alpha.ctx, betaTransaction.id, alphaExpense.id),
    ).rejects.toThrow(/not on these books/i)
    await expect(
      categorize(alpha.ctx, betaTransaction.id, alphaExpense.id),
    ).rejects.not.toThrow(/belongs to|another company|permission/i)

    // Beta's row is untouched.
    const [unchanged] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, betaTransaction.id))
    expect(unchanged.reviewState).toBe('new')
    expect(unchanged.chartAccountId).toBeNull()
  })

  it('refuses to categorize into another company\'s chart account', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaTransaction = await insertTransaction(alpha, {
      amountCents: -2_500,
      description: 'ALPHA SUPPLIES',
    })
    // Beta's Office Supplies account — same number, different company.
    const betaExpense = await beta.account('6350')

    await expect(
      categorize(alpha.ctx, alphaTransaction.id, betaExpense.id),
    ).rejects.toThrow(/not on these books/i)
    await expect(
      categorize(alpha.ctx, alphaTransaction.id, betaExpense.id),
    ).rejects.not.toThrow(/belongs to|another company|permission/i)
  })

  it('silently drops foreign ids from bulk operations', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaTransaction = await insertTransaction(alpha, {
      amountCents: -1_100,
      description: 'ALPHA ONE',
    })
    const betaTransaction = await insertTransaction(beta, {
      amountCents: -2_200,
      description: 'BETA ONE',
    })
    const alphaExpense = await alpha.account('6350')

    const result = await bulkCategorize(
      alpha.ctx,
      [alphaTransaction.id, betaTransaction.id],
      alphaExpense.id,
    )

    // Only Alpha's transaction was in scope.
    expect(result.updated).toBe(1)

    const [beta1] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, betaTransaction.id))
    expect(beta1.reviewState).toBe('new')
  })

  it('scopes the chart of accounts per company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha', industry: 'construction' })
    const beta = await createCompanyFixture({ name: 'Beta', industry: 'restaurant' })

    const alphaAccounts = await listAccounts(alpha.ctx)
    const betaAccounts = await listAccounts(beta.ctx)

    // Each got its own industry pack.
    expect(alphaAccounts.some((a) => a.name === 'Retainage Receivable')).toBe(true)
    expect(betaAccounts.some((a) => a.name === 'Retainage Receivable')).toBe(false)
    expect(betaAccounts.some((a) => a.name === 'Food Cost')).toBe(true)

    // No account id overlaps between tenants.
    const alphaIds = new Set(alphaAccounts.map((a) => a.id))
    expect(betaAccounts.every((a) => !alphaIds.has(a.id))).toBe(true)
  })

  it('drops foreign account ids from a scoped id lookup', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaExpense = await alpha.account('6350')
    const betaExpense = await beta.account('6350')

    const found = await accountsByIds(alpha.ctx, [alphaExpense.id, betaExpense.id])

    expect(found).toHaveLength(1)
    expect(found[0].id).toBe(alphaExpense.id)
  })

  it('scopes rules to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const alphaExpense = await alpha.account('6800')
    await createRule(alpha.ctx, {
      name: 'Alpha fuel rule',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL' }],
      chartAccountId: alphaExpense.id,
    })

    expect(await listRules(alpha.ctx)).toHaveLength(1)
    expect(await listRules(beta.ctx)).toHaveLength(0)
  })

  it('scopes the audit trail to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    const transaction = await insertTransaction(alpha, {
      amountCents: -3_300,
      description: 'ALPHA AUDITED',
    })
    await categorize(alpha.ctx, transaction.id, (await alpha.account('6350')).id)

    const alphaEvents = await recentActivity(alpha.ctx)
    const betaEvents = await recentActivity(beta.ctx)

    expect(alphaEvents.some((e) => e.action === 'transaction.categorize')).toBe(true)
    expect(betaEvents.some((e) => e.action === 'transaction.categorize')).toBe(false)

    // Beta cannot read history for Alpha's transaction either.
    expect(await transactionHistory(beta.ctx, transaction.id)).toHaveLength(0)
  })

  it('keeps every chart account row bound to its company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })

    const rows = await db
      .select()
      .from(chartAccounts)
      .where(eq(chartAccounts.companyId, alpha.companyId))

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.companyId === alpha.companyId)).toBe(true)
  })
})
