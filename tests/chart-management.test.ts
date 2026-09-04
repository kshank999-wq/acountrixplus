import { beforeEach, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, chartAccounts } from '@/db/schema'
import { createCompanyFixture, addUserWithRole, type Fixture } from './helpers'
import {
  categorizableAccounts,
  createAccount,
  listAccounts,
  setAccountRetired,
} from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'

/**
 * Adding to and retiring from the chart of accounts (Phase 118).
 *
 * `createAccount` was written in Phase 1 and had no caller for 117 phases —
 * Phase 49's defect class, where a function with no caller is a feature that
 * does not exist. These are the first tests that ask what it does when a
 * person uses it.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Chart Co' })
})

describe('adding an account', () => {
  it('puts it on the chart, where every picker reads it', async () => {
    const account = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'Van hire',
      type: 'expense',
    })

    expect(account.number).toBe('6210')
    expect(account.isSystem).toBe(false)
    expect(account.isActive).toBe(true)

    const listed = await listAccounts(fixture.ctx)
    expect(listed.map((row) => row.number)).toContain('6210')

    // An expense is categorizable, so it reaches the transaction inbox too —
    // which is the point of adding one.
    const categorizable = await categorizableAccounts(fixture.ctx)
    expect(categorizable.map((row) => row.number)).toContain('6210')
  })

  it('records who added it', async () => {
    const account = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'Van hire',
      type: 'expense',
    })

    const [entry] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, account.id))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1)

    expect(entry.action).toBe('account.create')
    expect(entry.userId).toBe(fixture.userId)
  })

  it('refuses a duplicate number in a sentence, not a unique-index violation', async () => {
    // Before this the second insert reached Postgres and came back as
    // `duplicate key value violates unique constraint`, which is not something
    // a bookkeeper can act on.
    await expect(
      createAccount(fixture.ctx, { number: '1000', name: 'Another bank', type: 'asset' }),
    ).rejects.toThrow(/already on this chart|installs and looks up by number/)
  })

  it('refuses an expense numbered among the assets', async () => {
    // 1042 is free on the installed chart, so the only thing wrong with this
    // proposal is that an expense does not belong in the asset band.
    await expect(
      createAccount(fixture.ctx, { number: '1042', name: 'Van hire', type: 'expense' }),
    ).rejects.toThrow(/outside 6000–6999/)
  })

  it('refuses a number the software posts into by name', async () => {
    await expect(
      createAccount(fixture.ctx, {
        number: SYSTEM_ACCOUNTS.accountsReceivable,
        name: 'Mine now',
        type: 'asset',
      }),
    ).rejects.toThrow(/installs and looks up by number/)
  })

  it('refuses somebody without permission to touch the ledger', async () => {
    const readonly = await addUserWithRole(fixture, 'readonly')

    await expect(
      createAccount(readonly, { number: '6210', name: 'Van hire', type: 'expense' }),
    ).rejects.toThrow()
  })

  it('does not let one company see another’s account', async () => {
    const other = await createCompanyFixture({ name: 'Other Co' })
    await createAccount(other.ctx, { number: '6210', name: 'Their van hire', type: 'expense' })

    const listed = await listAccounts(fixture.ctx)
    expect(listed.map((row) => row.number)).not.toContain('6210')

    // And the number is free here, because uniqueness is per company.
    const mine = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'My van hire',
      type: 'expense',
    })
    expect(mine.name).toBe('My van hire')
  })
})

describe('retiring an account', () => {
  it('takes it out of the pickers and leaves it on the chart', async () => {
    const account = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'Van hire',
      type: 'expense',
    })

    await setAccountRetired(fixture.ctx, { accountId: account.id, retired: true })

    const active = await listAccounts(fixture.ctx, { activeOnly: true })
    expect(active.map((row) => row.number)).not.toContain('6210')

    // Not a delete: the entries behind it still point here, and a chart that
    // loses an account loses the heading its own history was filed under.
    const all = await listAccounts(fixture.ctx)
    expect(all.map((row) => row.number)).toContain('6210')

    const categorizable = await categorizableAccounts(fixture.ctx)
    expect(categorizable.map((row) => row.number)).not.toContain('6210')
  })

  it('brings one back', async () => {
    const account = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'Van hire',
      type: 'expense',
    })

    await setAccountRetired(fixture.ctx, { accountId: account.id, retired: true })
    const back = await setAccountRetired(fixture.ctx, { accountId: account.id, retired: false })

    expect(back.isActive).toBe(true)
    const active = await listAccounts(fixture.ctx, { activeOnly: true })
    expect(active.map((row) => row.number)).toContain('6210')
  })

  it('keeps the number reserved while it is retired', async () => {
    const account = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'Van hire',
      type: 'expense',
    })
    await setAccountRetired(fixture.ctx, { accountId: account.id, retired: true })

    await expect(
      createAccount(fixture.ctx, { number: '6210', name: 'Van hire again', type: 'expense' }),
    ).rejects.toThrow(/retired account keeps its number/)
  })

  it('refuses to retire an account the software posts into by number', async () => {
    const receivables = await fixture.account(SYSTEM_ACCOUNTS.accountsReceivable)

    await expect(
      setAccountRetired(fixture.ctx, { accountId: receivables.id, retired: true }),
    ).rejects.toThrow(/posts into by number/)

    const [row] = await db
      .select()
      .from(chartAccounts)
      .where(eq(chartAccounts.id, receivables.id))
      .limit(1)
    expect(row.isActive).toBe(true)
  })

  it('refuses an account belonging to another company', async () => {
    const other = await createCompanyFixture({ name: 'Other Co' })
    const theirs = await createAccount(other.ctx, {
      number: '6210',
      name: 'Their van hire',
      type: 'expense',
    })

    await expect(
      setAccountRetired(fixture.ctx, { accountId: theirs.id, retired: true }),
    ).rejects.toThrow(/not on this chart/)
  })

  it('records the retirement and the return as different acts', async () => {
    const account = await createAccount(fixture.ctx, {
      number: '6210',
      name: 'Van hire',
      type: 'expense',
    })

    await setAccountRetired(fixture.ctx, { accountId: account.id, retired: true })
    await setAccountRetired(fixture.ctx, { accountId: account.id, retired: false })

    const entries = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, account.id))
      .orderBy(desc(auditEvents.createdAt))

    expect(entries.map((row) => row.action)).toEqual(
      expect.arrayContaining(['account.create', 'account.retire', 'account.restore']),
    )
  })
})
