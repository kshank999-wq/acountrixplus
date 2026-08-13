import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, categorizationRules } from '@/db/schema'
import {
  evaluateCondition,
  firstMatchingRule,
  matchesRule,
  normalizeMerchant,
  vendorMemoryConditions,
} from '@/modules/bookkeeping/matching'
import { createCompanyFixture, insertTransaction } from './helpers'
import { createRule, applyRuleToExisting } from '@/modules/bookkeeping/rules-engine'
import { categorize } from '@/modules/bookkeeping/transactions'
import { connectInstitution, syncConnection } from '@/modules/banking/sync'

const transaction = {
  description: 'SHELL OIL 574839',
  merchantName: 'Shell Oil',
  amountCents: -6_240,
  financialAccountId: 'account-1',
}

/** Pure rule matching (spec §3, §21). */
describe('condition evaluation', () => {
  it('matches a case-insensitive substring', () => {
    expect(
      evaluateCondition({ field: 'description', operator: 'contains', value: 'shell' }, transaction),
    ).toBe(true)
  })

  it('trims whitespace around the comparison value', () => {
    expect(
      evaluateCondition(
        { field: 'merchantName', operator: 'equals', value: '  Shell Oil  ' },
        transaction,
      ),
    ).toBe(true)
  })

  it('compares amounts numerically', () => {
    expect(
      evaluateCondition({ field: 'amountCents', operator: 'lt', value: 0 }, transaction),
    ).toBe(true)
    expect(
      evaluateCondition({ field: 'absAmountCents', operator: 'gt', value: 10_000 }, transaction),
    ).toBe(false)
    expect(
      evaluateCondition({ field: 'absAmountCents', operator: 'gte', value: 6_240 }, transaction),
    ).toBe(true)
  })

  it('derives direction from the amount sign', () => {
    expect(
      evaluateCondition({ field: 'direction', operator: 'equals', value: 'debit' }, transaction),
    ).toBe(true)
    expect(
      evaluateCondition(
        { field: 'direction', operator: 'equals', value: 'credit' },
        { ...transaction, amountCents: 5_000 },
      ),
    ).toBe(true)
  })

  it('is false when the field is absent rather than throwing', () => {
    expect(
      evaluateCondition(
        { field: 'merchantName', operator: 'contains', value: 'shell' },
        { ...transaction, merchantName: null },
      ),
    ).toBe(false)
  })

  it('supports negation operators', () => {
    expect(
      evaluateCondition(
        { field: 'description', operator: 'not_contains', value: 'costco' },
        transaction,
      ),
    ).toBe(true)
  })
})

describe('rule matching', () => {
  it('requires every condition under matchType "all"', () => {
    const rule = {
      id: 'r1',
      matchType: 'all' as const,
      conditions: [
        { field: 'description' as const, operator: 'contains' as const, value: 'SHELL' },
        { field: 'absAmountCents' as const, operator: 'gt' as const, value: 100_000 },
      ],
    }
    expect(matchesRule(rule, transaction)).toBe(false)
  })

  it('requires only one condition under matchType "any"', () => {
    const rule = {
      id: 'r1',
      matchType: 'any' as const,
      conditions: [
        { field: 'description' as const, operator: 'contains' as const, value: 'SHELL' },
        { field: 'absAmountCents' as const, operator: 'gt' as const, value: 100_000 },
      ],
    }
    expect(matchesRule(rule, transaction)).toBe(true)
  })

  it('never matches a rule with no conditions', () => {
    // A vacuous `every()` would otherwise recategorize the whole inbox.
    expect(matchesRule({ id: 'r1', matchType: 'all', conditions: [] }, transaction)).toBe(false)
  })

  it('never matches an inactive rule', () => {
    const rule = {
      id: 'r1',
      matchType: 'all' as const,
      isActive: false,
      conditions: [{ field: 'description' as const, operator: 'contains' as const, value: 'SHELL' }],
    }
    expect(matchesRule(rule, transaction)).toBe(false)
  })

  it('respects an account restriction', () => {
    const rule = {
      id: 'r1',
      matchType: 'all' as const,
      financialAccountId: 'another-account',
      conditions: [{ field: 'description' as const, operator: 'contains' as const, value: 'SHELL' }],
    }
    expect(matchesRule(rule, transaction)).toBe(false)
    expect(matchesRule({ ...rule, financialAccountId: 'account-1' }, transaction)).toBe(true)
  })

  it('picks the lowest priority number when several match', () => {
    const conditions = [
      { field: 'description' as const, operator: 'contains' as const, value: 'SHELL' },
    ]
    const winner = firstMatchingRule(
      [
        { id: 'low', matchType: 'all', priority: 500, conditions },
        { id: 'high', matchType: 'all', priority: 10, conditions },
        { id: 'mid', matchType: 'all', priority: 100, conditions },
      ],
      transaction,
    )
    expect(winner?.id).toBe('high')
  })

  it('breaks priority ties on the supplied order', () => {
    const conditions = [
      { field: 'description' as const, operator: 'contains' as const, value: 'SHELL' },
    ]
    const winner = firstMatchingRule(
      [
        { id: 'first', matchType: 'all', priority: 100, conditions },
        { id: 'second', matchType: 'all', priority: 100, conditions },
      ],
      transaction,
    )
    expect(winner?.id).toBe('first')
  })
})

describe('merchant normalization', () => {
  it('strips store and reference numbers', () => {
    expect(normalizeMerchant('SHELL OIL 574839')).toBe('shell oil')
    expect(normalizeMerchant('COSTCO WHSE #1042')).toBe('costco whse')
    expect(normalizeMerchant('AMZN MKTP US*2K4LM')).toBe('amzn mktp us 2k4lm')
  })

  it('gives the same key to the same vendor across months', () => {
    expect(normalizeMerchant('SHELL OIL 574839')).toBe(normalizeMerchant('SHELL OIL 118204'))
  })

  it('strips card-network noise words', () => {
    expect(normalizeMerchant('POS DEBIT VERIZON WIRELESS PMT')).toBe('verizon wireless')
  })

  it('refuses to build a rule from a too-short descriptor', () => {
    expect(vendorMemoryConditions('A1')).toBeNull()
    expect(vendorMemoryConditions('SHELL OIL 574839')).not.toBeNull()
  })
})

/** Rule application against the database (spec §22). */
describe('rule application', () => {
  it('auto-categorizes a repeat transaction according to the rule', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    await createRule(fixture.ctx, {
      name: 'Shell fuel',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL OIL' }],
      chartAccountId: fuel.id,
      action: 'auto',
    })

    const { connectionId } = await connectInstitution(fixture.ctx, { publicToken: 'demo' })
    const summary = await syncConnection(fixture.ctx, connectionId)

    expect(summary.autoCategorized).toBeGreaterThan(0)

    const rows = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))

    const shellRows = rows.filter((r) => r.description.includes('SHELL OIL'))
    expect(shellRows.length).toBeGreaterThan(0)
    expect(shellRows.every((r) => r.reviewState === 'categorized')).toBe(true)
    expect(shellRows.every((r) => r.chartAccountId === fuel.id)).toBe(true)
  })

  it('only suggests when the rule action is "suggest"', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    await createRule(fixture.ctx, {
      name: 'Shell fuel',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL OIL' }],
      chartAccountId: fuel.id,
      action: 'suggest',
    })

    const { connectionId } = await connectInstitution(fixture.ctx, { publicToken: 'demo' })
    const summary = await syncConnection(fixture.ctx, connectionId)

    expect(summary.suggested).toBeGreaterThan(0)
    expect(summary.autoCategorized).toBe(0)

    const rows = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))
    const shellRows = rows.filter((r) => r.description.includes('SHELL OIL'))

    // Suggested, so it still awaits confirmation.
    expect(shellRows.every((r) => r.reviewState === 'suggested')).toBe(true)
  })

  it('creates a vendor-memory rule when asked to remember', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
      merchantName: 'Shell Oil',
    })

    const result = await categorize(fixture.ctx, transactionRow.id, fuel.id, {
      rememberVendor: true,
    })

    expect(result.vendorRule).not.toBeNull()

    const [rule] = await db
      .select()
      .from(categorizationRules)
      .where(eq(categorizationRules.companyId, fixture.companyId))

    expect(rule.isVendorMemory).toBe(true)
    expect(rule.chartAccountId).toBe(fuel.id)
    // Defaults to suggest — the next charge is proposed, not silently posted.
    expect(rule.action).toBe('suggest')
  })

  it('applies a remembered vendor to the next matching transaction', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    const august = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
      merchantName: 'Shell Oil',
    })
    await categorize(fixture.ctx, august.id, fuel.id, { rememberVendor: true })

    // Same vendor, different month and reference number.
    const september = await insertTransaction(fixture, {
      amountCents: -5_880,
      description: 'SHELL OIL 118204',
      merchantName: 'Shell Oil',
      postedDate: '2026-09-02',
    })

    const [rule] = await db
      .select()
      .from(categorizationRules)
      .where(eq(categorizationRules.companyId, fixture.companyId))

    await applyRuleToExisting(fixture.ctx, rule.id)

    const [updated] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, september.id))

    expect(updated.reviewState).toBe('suggested')
    expect(updated.chartAccountId).toBe(fuel.id)
  })

  it('leaves an already-categorized transaction alone when a new rule is added', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const fuel = await fixture.account('6800')

    const transactionRow = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
    })
    // A person decided this one belongs in Office Supplies.
    await categorize(fixture.ctx, transactionRow.id, office.id)

    const { rule } = await createRule(fixture.ctx, {
      name: 'Shell fuel',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL' }],
      chartAccountId: fuel.id,
      action: 'auto',
      applyToExisting: true,
    })
    expect(rule).toBeDefined()

    const [after] = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.id, transactionRow.id))

    // The human decision stands.
    expect(after.chartAccountId).toBe(office.id)
  })

  it('rejects a rule with no conditions', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    await expect(
      createRule(fixture.ctx, { name: 'Empty', conditions: [], chartAccountId: fuel.id }),
    ).rejects.toThrow(/at least one condition/i)
  })

  it('counts how often a rule has matched', async () => {
    const fixture = await createCompanyFixture()
    const fuel = await fixture.account('6800')

    await insertTransaction(fixture, { amountCents: -6_240, description: 'SHELL OIL 1' })
    await insertTransaction(fixture, { amountCents: -5_880, description: 'SHELL OIL 2' })

    const { rule } = await createRule(fixture.ctx, {
      name: 'Shell fuel',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL OIL' }],
      chartAccountId: fuel.id,
      action: 'auto',
      applyToExisting: true,
    })

    const [refreshed] = await db
      .select()
      .from(categorizationRules)
      .where(eq(categorizationRules.id, rule.id))

    expect(refreshed.matchCount).toBe(2)
    expect(refreshed.lastAppliedAt).not.toBeNull()
  })
})
