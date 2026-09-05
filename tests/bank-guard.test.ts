import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { financialAccounts } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { bankGlAccountFor } from '@/modules/banking/bank-guard'
import { Refusal } from '@/modules/errors'

/**
 * The same rule against the database (Phase 133).
 *
 * `bank-side.test.ts` proves the decision and reads the source for every place
 * that has to make it. This proves the one function all ten of them call: it
 * finds the ledger account, asks the company what money it keeps its books in,
 * and refuses when the two currencies disagree.
 *
 * Testing the guard rather than each of the ten is deliberate. The source scan
 * beside it is what says all ten call this — a claim ten near-identical
 * end-to-end tests would restate less rigorously, since each would prove only
 * that *that* path was wired on the day it was written.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture()
})

async function euroAccount(name = 'Frankfurt Current') {
  return createFinancialAccount(fixture.ctx, { name, kind: 'checking', currency: 'EUR' })
}

describe('the ledger account a bank account posts through', () => {
  it('hands it over for an account in the company’s own money', async () => {
    const glAccountId = await bankGlAccountFor(
      fixture.ctx,
      fixture.financialAccountId,
      'banking this deposit',
    )

    const [account] = await db
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(eq(financialAccounts.id, fixture.financialAccountId))
      .limit(1)

    // The whole of what the ten paths did before, and still do: a domestic
    // account is untouched, which is why this went unnoticed for so long.
    expect(glAccountId).toBe(account.chartAccountId)
  })

  it('refuses one held in another currency, and says which and why', async () => {
    const account = await euroAccount()

    await expect(
      bankGlAccountFor(fixture.ctx, account.id, 'remitting this liability'),
    ).rejects.toThrow(Refusal)

    const why = await bankGlAccountFor(fixture.ctx, account.id, 'remitting this liability').catch(
      (error: Error) => error.message,
    )

    expect(why).toContain('Frankfurt Current')
    expect(why).toContain('EUR')
    expect(why).toContain('USD')
    expect(why).toContain('remitting this liability')
  })

  it('is a Refusal, so the sentence reaches the person who hit it', async () => {
    // Phase 119's mechanism, and the reason this is not a bare Error: a person
    // chose a euro account from a list and needs to be told to choose another.
    // `messageFor` would replace anything else with "Something went wrong."
    const account = await euroAccount()
    const error = await bankGlAccountFor(fixture.ctx, account.id, 'holding this deposit').catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Refusal)
  })

  it('names the act it was asked about, not the operation in general', async () => {
    // Ten paths share this guard, so the sentence has to say which of them
    // refused. "Operation failed" would make somebody guess.
    const account = await euroAccount('Zurich Savings')
    const first = await bankGlAccountFor(fixture.ctx, account.id, 'banking this payout').catch(
      (error: Error) => error.message,
    )
    const second = await bankGlAccountFor(fixture.ctx, account.id, 'refunding this credit').catch(
      (error: Error) => error.message,
    )

    expect(first).toContain('banking this payout')
    expect(second).toContain('refunding this credit')
    expect(first).not.toBe(second)
  })

  it('refuses an account that is not on these books at all', async () => {
    // The lookup and the question travel together, so the missing-row refusal
    // is still here rather than having been dropped when they merged.
    await expect(
      bankGlAccountFor(
        fixture.ctx,
        '00000000-0000-0000-0000-000000000000',
        'banking this deposit',
      ),
    ).rejects.toThrow()
  })
})
