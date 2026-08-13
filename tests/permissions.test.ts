import { describe, expect, it } from 'vitest'
import {
  effectivePermissions,
  hasPermission,
  parseOverrides,
  PermissionError,
  ROLE_PERMISSIONS,
} from '@/modules/permissions'
import { createCompanyFixture, addUserWithRole, insertTransaction } from './helpers'
import { categorize, listInbox } from '@/modules/bookkeeping/transactions'
import { createRule } from '@/modules/bookkeeping/rules-engine'
import { listAccounts } from '@/modules/coa/service'

/** Permissions and role boundaries (spec §14, §21, §22). */
describe('role permissions', () => {
  it('gives the owner every permission', () => {
    const owner = effectivePermissions('owner')
    expect(owner.has('accounting:close')).toBe(true)
    expect(owner.has('company:billing')).toBe(true)
    expect(owner.size).toBe(ROLE_PERMISSIONS.owner.length)
  })

  it('keeps sales and marketing out of the books', () => {
    for (const role of ['sales', 'marketing'] as const) {
      expect(hasPermission(role, 'bookkeeping:view')).toBe(false)
      expect(hasPermission(role, 'bookkeeping:categorize')).toBe(false)
      expect(hasPermission(role, 'accounting:view')).toBe(false)
      expect(hasPermission(role, 'reports:financial')).toBe(false)
    }
  })

  it('lets a bookkeeper categorize but not close periods', () => {
    expect(hasPermission('bookkeeper', 'bookkeeping:categorize')).toBe(true)
    expect(hasPermission('bookkeeper', 'reconciliation:perform')).toBe(true)
    expect(hasPermission('bookkeeper', 'accounting:close')).toBe(false)
    expect(hasPermission('bookkeeper', 'accounting:journal')).toBe(false)
  })

  it('lets an accountant close and reopen periods', () => {
    expect(hasPermission('accountant', 'accounting:close')).toBe(true)
    expect(hasPermission('accountant', 'reconciliation:reopen')).toBe(true)
    expect(hasPermission('accountant', 'audit:view')).toBe(true)
  })

  it('gives read-only users no write permissions', () => {
    const permissions = effectivePermissions('readonly')
    for (const permission of permissions) {
      expect(permission.endsWith(':view')).toBe(true)
    }
  })

  it('applies granular grants on top of the role', () => {
    expect(hasPermission('sales', 'bookkeeping:view')).toBe(false)
    expect(hasPermission('sales', 'bookkeeping:view', { grant: ['bookkeeping:view'] })).toBe(true)
  })

  it('lets a revoke override a grant of the same permission', () => {
    const permissions = effectivePermissions('bookkeeper', {
      grant: ['accounting:close'],
      revoke: ['accounting:close'],
    })
    // The safer direction wins when the two conflict.
    expect(permissions.has('accounting:close')).toBe(false)
  })

  it('revokes a permission the role would otherwise grant', () => {
    expect(
      hasPermission('bookkeeper', 'bookkeeping:categorize', {
        revoke: ['bookkeeping:categorize'],
      }),
    ).toBe(false)
  })

  it('falls back to role defaults when overrides are malformed', () => {
    expect(parseOverrides('not json at all')).toBeNull()
    expect(parseOverrides(null)).toBeNull()
  })

  it('ignores unknown permission strings in overrides', () => {
    const parsed = parseOverrides(JSON.stringify({ grant: ['not:a:permission', 'audit:view'] }))
    expect(parsed?.grant).toEqual(['audit:view'])
  })
})

describe('permission enforcement in services', () => {
  it('blocks a marketing user from reading the inbox', async () => {
    const fixture = await createCompanyFixture()
    const marketing = await addUserWithRole(fixture, 'marketing')

    await expect(listInbox(marketing)).rejects.toThrow(PermissionError)
  })

  it('blocks a read-only user from categorizing', async () => {
    const fixture = await createCompanyFixture()
    const auditor = await addUserWithRole(fixture, 'readonly')

    const transaction = await insertTransaction(fixture, {
      amountCents: -4_200,
      description: 'STAPLES 00114',
    })
    const expense = await fixture.account('6350')

    await expect(categorize(auditor, transaction.id, expense.id)).rejects.toThrow(PermissionError)

    // But reading is allowed.
    await expect(listAccounts(auditor)).resolves.toBeDefined()
  })

  it('blocks a read-only user from creating rules', async () => {
    const fixture = await createCompanyFixture()
    const auditor = await addUserWithRole(fixture, 'readonly')
    const expense = await fixture.account('6800')

    await expect(
      createRule(auditor, {
        name: 'Should not be allowed',
        conditions: [{ field: 'description', operator: 'contains', value: 'SHELL' }],
        chartAccountId: expense.id,
      }),
    ).rejects.toThrow(PermissionError)
  })

  it('lets a bookkeeper categorize normally', async () => {
    const fixture = await createCompanyFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    const transaction = await insertTransaction(fixture, {
      amountCents: -6_240,
      description: 'SHELL OIL 574839',
    })
    const fuel = await fixture.account('6800')

    await expect(categorize(bookkeeper, transaction.id, fuel.id)).resolves.toBeDefined()
  })

  it('reports the missing permission on the error', async () => {
    const fixture = await createCompanyFixture()
    const marketing = await addUserWithRole(fixture, 'marketing')

    await expect(listInbox(marketing)).rejects.toMatchObject({
      permission: 'bookkeeping:view',
      status: 403,
    })
  })
})
