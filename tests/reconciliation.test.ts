import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions } from '@/db/schema'
import { addUserWithRole, createCompanyFixture, insertTransaction } from './helpers'
import {
  completeReconciliation,
  reconcilableTransactions,
  reconciliationHistory,
  reopenReconciliation,
  setCleared,
  startReconciliation,
  summarize,
} from '@/modules/reconciliation/service'
import { categorize, ReconciledTransactionError } from '@/modules/bookkeeping/transactions'
import { PermissionError } from '@/modules/permissions'

/**
 * Reconciliation (spec §4).
 *
 * The account starts empty, so the beginning balance is zero and the statement
 * ending balance is just the sum of whatever gets cleared.
 */
async function fixtureWithTransactions() {
  const fixture = await createCompanyFixture()

  const a = await insertTransaction(fixture, {
    amountCents: -10_000,
    description: 'RENT',
    postedDate: '2026-08-05',
  })
  const b = await insertTransaction(fixture, {
    amountCents: -2_500,
    description: 'SUPPLIES',
    postedDate: '2026-08-10',
  })
  const c = await insertTransaction(fixture, {
    amountCents: 50_000,
    description: 'DEPOSIT',
    postedDate: '2026-08-15',
  })

  return { fixture, a, b, c }
}

describe('reconciliation session', () => {
  it('starts from a zero beginning balance on a first reconciliation', async () => {
    const { fixture } = await fixtureWithTransactions()

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })

    expect(session.beginningBalanceCents).toBe(0)

    const summary = await summarize(fixture.ctx, session.id)
    expect(summary.clearedBalanceCents).toBe(0)
    expect(summary.differenceCents).toBe(37_500)
    expect(summary.isBalanced).toBe(false)
  })

  it('recalculates the difference as transactions are cleared', async () => {
    const { fixture, a, b, c } = await fixtureWithTransactions()

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      // -10,000 - 2,500 + 50,000
      statementEndingBalanceCents: 37_500,
    })

    await setCleared(fixture.ctx, session.id, [a.id], true)
    expect((await summarize(fixture.ctx, session.id)).differenceCents).toBe(47_500)

    await setCleared(fixture.ctx, session.id, [b.id, c.id], true)

    const summary = await summarize(fixture.ctx, session.id)
    expect(summary.clearedBalanceCents).toBe(37_500)
    expect(summary.differenceCents).toBe(0)
    expect(summary.isBalanced).toBe(true)
    expect(summary.clearedCount).toBe(3)
    expect(summary.unclearedCount).toBe(0)
  })

  it('reverses the effect when a transaction is uncleared', async () => {
    const { fixture, a } = await fixtureWithTransactions()

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })

    await setCleared(fixture.ctx, session.id, [a.id], true)
    await setCleared(fixture.ctx, session.id, [a.id], false)

    const summary = await summarize(fixture.ctx, session.id)
    expect(summary.clearedCount).toBe(0)
    expect(summary.differenceCents).toBe(37_500)
  })

  it('refuses to complete while a difference remains', async () => {
    const { fixture, a } = await fixtureWithTransactions()

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })
    await setCleared(fixture.ctx, session.id, [a.id], true)

    await expect(completeReconciliation(fixture.ctx, session.id)).rejects.toThrow(
      /difference is 47500 cents/i,
    )
  })

  it('completes when the difference is exactly zero', async () => {
    const { fixture, a, b, c } = await fixtureWithTransactions()

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })
    await setCleared(fixture.ctx, session.id, [a.id, b.id, c.id], true)

    const result = await completeReconciliation(fixture.ctx, session.id)
    expect(result.isBalanced).toBe(true)

    const rows = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))

    expect(rows.every((row) => row.reviewState === 'reconciled')).toBe(true)
  })

  it('chains the beginning balance from the previous reconciliation', async () => {
    const { fixture, a, b, c } = await fixtureWithTransactions()

    const august = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })
    await setCleared(fixture.ctx, august.id, [a.id, b.id, c.id], true)
    await completeReconciliation(fixture.ctx, august.id)

    const september = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-09-01',
      statementEndDate: '2026-09-30',
      statementEndingBalanceCents: 37_500,
    })

    // Picks up where August left off.
    expect(september.beginningBalanceCents).toBe(37_500)
    expect((await summarize(fixture.ctx, september.id)).differenceCents).toBe(0)
  })

  it('refuses a second session while one is in progress', async () => {
    const { fixture } = await fixtureWithTransactions()

    await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })

    await expect(
      startReconciliation(fixture.ctx, {
        financialAccountId: fixture.financialAccountId,
        statementStartDate: '2026-09-01',
        statementEndDate: '2026-09-30',
        statementEndingBalanceCents: 0,
      }),
    ).rejects.toThrow(/already has a reconciliation in progress/i)
  })

  it('will not clear a transaction dated after the statement end', async () => {
    const { fixture } = await fixtureWithTransactions()

    const later = await insertTransaction(fixture, {
      amountCents: -1_000,
      description: 'SEPTEMBER CHARGE',
      postedDate: '2026-09-05',
    })

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })

    // It had not happened yet, so it cannot be on that statement.
    const result = await setCleared(fixture.ctx, session.id, [later.id], true)
    expect(result.updated).toBe(0)
  })

  it('only offers transactions from the session\'s own account', async () => {
    const { fixture } = await fixtureWithTransactions()
    const savingsGl = await fixture.account('1010')

    const { financialAccounts } = await import('@/db/schema')
    const [savings] = await db
      .insert(financialAccounts)
      .values({
        companyId: fixture.companyId,
        chartAccountId: savingsGl.id,
        name: 'Savings',
        kind: 'savings',
        providerAccountId: 'test-savings-002',
      })
      .returning()

    await db.insert(bankTransactions).values({
      companyId: fixture.companyId,
      financialAccountId: savings.id,
      providerTransactionId: 'savings-001',
      postedDate: '2026-08-10',
      amountCents: -900,
      description: 'SAVINGS FEE',
    })

    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })

    const candidates = await reconcilableTransactions(fixture.ctx, session.id)
    expect(candidates.every((row) => row.description !== 'SAVINGS FEE')).toBe(true)
    expect(candidates).toHaveLength(3)
  })
})

describe('reconciliation locking', () => {
  async function completedFixture() {
    const { fixture, a, b, c } = await fixtureWithTransactions()
    const session = await startReconciliation(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      statementStartDate: '2026-08-01',
      statementEndDate: '2026-08-31',
      statementEndingBalanceCents: 37_500,
    })
    await setCleared(fixture.ctx, session.id, [a.id, b.id, c.id], true)
    await completeReconciliation(fixture.ctx, session.id)
    return { fixture, session, a }
  }

  it('blocks recategorizing a reconciled transaction', async () => {
    const { fixture, a } = await completedFixture()
    const office = await fixture.account('6350')

    await expect(categorize(fixture.ctx, a.id, office.id)).rejects.toThrow(
      ReconciledTransactionError,
    )
  })

  it('blocks clearing changes on a completed session', async () => {
    const { fixture, session, a } = await completedFixture()

    await expect(setCleared(fixture.ctx, session.id, [a.id], false)).rejects.toThrow(
      /completed. reopen it/i,
    )
  })

  it('allows changes again after a controlled reopen', async () => {
    const { fixture, session, a } = await completedFixture()
    const office = await fixture.account('6350')

    await reopenReconciliation(fixture.ctx, session.id)

    const [reopened] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, a.id))
    expect(reopened.reviewState).toBe('categorized')

    await expect(categorize(fixture.ctx, a.id, office.id)).resolves.toBeDefined()
  })

  it('requires reconciliation:reopen to reopen', async () => {
    const { fixture, session } = await completedFixture()
    // A bookkeeper can reconcile but not reopen a completed period (spec §14).
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(reopenReconciliation(bookkeeper, session.id)).rejects.toThrow(PermissionError)
  })

  it('lets an accountant reopen', async () => {
    const { fixture, session } = await completedFixture()
    const accountant = await addUserWithRole(fixture, 'accountant')

    await expect(reopenReconciliation(accountant, session.id)).resolves.toBeUndefined()
  })

  it('keeps completed sessions in the history', async () => {
    const { fixture } = await completedFixture()

    const history = await reconciliationHistory(fixture.ctx, fixture.financialAccountId)
    expect(history).toHaveLength(1)
    expect(history[0].status).toBe('completed')
    expect(history[0].clearedBalanceCents).toBe(37_500)
    expect(history[0].clearedCount).toBe(3)
  })

  it('scopes reconciliations to the acting company', async () => {
    const { fixture } = await completedFixture()
    const other = await createCompanyFixture({ name: 'Other' })

    expect(await reconciliationHistory(other.ctx)).toHaveLength(0)
  })
})
