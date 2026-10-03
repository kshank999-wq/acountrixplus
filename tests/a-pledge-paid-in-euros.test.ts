import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, contributionReceipts, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createFund } from '@/modules/funds/service'
import { recordContribution, receivePledge } from '@/modules/funds/contributions'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { FX_ACCOUNTS, putRate } from '@/modules/fx/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { PENDING_WIRING } from '@/modules/staging/wiring'
import { FundError } from '@/modules/funds/service'

/**
 * A pledge paid in euros (Phase 157).
 *
 * ## The acceptance test ADR 0136 could not write
 *
 * `PENDING_WIRING` carried `mayPostToBank` with `acceptance: null` for
 * twenty-one phases, and the `null` was honest twice over: first because the
 * column did not exist, and then — after Phase 153 added columns for three of
 * its four targets — because *this* one needed a **row**. A pledge arrives in
 * instalments, so each has its own day and its own rate, and a single
 * `exchange_rate_millionths` on `contributions` would have been right for the
 * first and quietly wrong for the second.
 *
 * `contribution_receipts` is that row, so this is the test.
 *
 * ## Two instalments at two rates, and no realised difference
 *
 * `BANK_MONEY_SITES` calls this receivable `carried-in-home-money`: it predates
 * the cash — the revenue was recognised when the promise was made — and
 * `contributions` has no currency column, so it is held in the company's own
 * money with no rate of its own. A €600 receipt worth $660 relieves $660 of a
 * dollar receivable, exactly.
 *
 * That is the third origin, and it was found by wiring the site Phase 153 had
 * declared `already-carried` and never acted on.
 */

let fixture: Fixture
let fundId: string
let euroAccountId: string
let pledgeId: string

/** 1.10 in March, 1.20 in September. */
const MARCH = 1_100_000
const SEPTEMBER = 1_200_000

/** $20,000 promised, in the books' own money — a pledge carries no currency. */
const PROMISED = 2_000_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Rheinhaus Stiftung', industry: 'nonprofit' })

  for (const [rateDate, rateMillionths] of [
    ['2026-03-01', MARCH],
    ['2026-09-01', SEPTEMBER],
  ] as const) {
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate,
      rateMillionths,
      source: 'manual',
    })
  }

  const fund = await createFund(fixture.ctx, {
    code: 'ROOF',
    name: 'Roof appeal',
    restriction: 'restricted',
    purpose: 'Replacing the hall roof, as set out in the appeal letter.',
  })
  fundId = fund.id

  const euro = await createFinancialAccount(fixture.ctx, {
    name: 'Frankfurt Spendenkonto',
    kind: 'checking',
    currency: 'EUR',
  })
  euroAccountId = euro.id

  const pledge = await recordContribution(fixture.ctx, {
    fundId,
    kind: 'pledge',
    receivedOn: '2026-02-01',
    amountCents: PROMISED,
  })
  pledgeId = pledge.id
})

/** What one account was debited and credited across every posted entry. */
async function movement(number: string): Promise<{ debit: number; credit: number }> {
  const rows = await db
    .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, number)))

  return {
    debit: rows.reduce((total, row) => total + row.debit, 0),
    credit: rows.reduce((total, row) => total + row.credit, 0),
  }
}

describe('a pledge received into a euro account', () => {
  it('can be received at all, which it could not before', async () => {
    // The capability, not the figure. This refused outright until Phase 157, so
    // a fund banking in euros had to record a donor's receipt against a
    // home-currency account the money did not go into, or not record it.
    const result = await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 60_000,
      currency: 'EUR',
      receivedOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    expect(result.journalEntryId).toBeTruthy()
  })

  it('relieves the promise by what the money is worth, not by its face amount', async () => {
    // €600 at 1.10 is $660, and the receivable is a dollar balance. Taking the
    // face figure off it would be the `contractorPayments` defect Phase 152
    // repaired, one module over.
    const result = await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 60_000,
      currency: 'EUR',
      receivedOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    expect(result.functionalCents).toBe(66_000)
    expect(result.receivedCents).toBe(66_000)
    expect(result.outstandingCents).toBe(PROMISED - 66_000)

    // Both ledger lines are the same figure, because the receivable carries no
    // rate for the day's rate to differ from.
    const receivable = await movement(INDUSTRY_ACCOUNTS.pledgesReceivable)
    expect(receivable.credit).toBe(66_000)
  })

  it('posts no realised difference, because there is none to post', async () => {
    // The third origin's measurable half. `carried-in-home-money` means the
    // balance pre-exists *and carries no rate*, so a posting to the exchange
    // account would be the difference between a figure and itself.
    await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 60_000,
      currency: 'EUR',
      receivedOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })

    const fx = await movement(FX_ACCOUNTS.gainOrLoss)
    expect(fx.debit + fx.credit).toBe(0)
  })

  it('writes each instalment down with its own day and its own rate', async () => {
    /**
     * **The reason this needed a row.** Phase 153 cleared three of
     * `mayPostToBank`'s four targets with columns and said a single
     * `exchange_rate_millionths` on `contributions` would be right for the first
     * instalment and wrong for the second. Here are the two instalments.
     */
    await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 60_000,
      currency: 'EUR',
      receivedOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })
    await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 60_000,
      currency: 'EUR',
      receivedOn: '2026-09-01',
      financialAccountId: euroAccountId,
    })

    const receipts = await db
      .select()
      .from(contributionReceipts)
      .where(eq(contributionReceipts.contributionId, pledgeId))
      .orderBy(contributionReceipts.receivedOn)

    expect(receipts).toHaveLength(2)

    // The same €600 twice, worth different amounts, each recorded at the rate it
    // was posted at — Phase 129's rule, which a column on the contribution could
    // not have kept.
    expect(receipts.map((r) => r.amountCents)).toEqual([60_000, 60_000])
    expect(receipts.map((r) => r.exchangeRateMillionths)).toEqual([MARCH, SEPTEMBER])
    expect(receipts.map((r) => r.functionalCents)).toEqual([66_000, 72_000])
    expect(receipts.every((r) => r.currency === 'EUR')).toBe(true)

    // And the promise came down by the worth of both, not by €1,200.
    const receivable = await movement(INDUSTRY_ACCOUNTS.pledgesReceivable)
    expect(receivable.credit).toBe(66_000 + 72_000)
  })

  it('still refuses more than is promised, measured in the books money', async () => {
    // The guard that was there before, on the figure that moves. €18,000 is
    // worth $19,800 at 1.10 and fits; the same €18,000 at 1.20 is $21,600 and
    // does not.
    await expect(
      receivePledge(fixture.ctx, {
        contributionId: pledgeId,
        amountCents: 1_800_000,
        currency: 'EUR',
        receivedOn: '2026-09-01',
        financialAccountId: euroAccountId,
      }),
    ).rejects.toThrow(FundError)

    // At March's rate the same face amount is within the promise.
    const fits = await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 1_800_000,
      currency: 'EUR',
      receivedOn: '2026-03-01',
      financialAccountId: euroAccountId,
    })
    expect(fits.functionalCents).toBe(1_980_000)
  })

  it('still refuses a euro receipt into a dollar account', async () => {
    // The gate's other branch, untouched. The bank converted at its own rate on
    // the day and these books do not have it, so any figure posted is a guess at
    // somebody else's arithmetic.
    await expect(
      receivePledge(fixture.ctx, {
        contributionId: pledgeId,
        amountCents: 60_000,
        currency: 'EUR',
        receivedOn: '2026-03-01',
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/held in USD/)
  })

  it('changes nothing for a domestic receipt', async () => {
    // Why no caller had to change. At the identity rate the face amount is the
    // functional amount, which is every receipt that could be recorded before
    // this phase.
    const result = await receivePledge(fixture.ctx, {
      contributionId: pledgeId,
      amountCents: 50_000,
      receivedOn: '2026-03-01',
      financialAccountId: fixture.financialAccountId,
    })

    expect(result.functionalCents).toBe(50_000)
    expect(result.receivedCents).toBe(50_000)

    const [receipt] = await db
      .select()
      .from(contributionReceipts)
      .where(eq(contributionReceipts.contributionId, pledgeId))

    expect(receipt.exchangeRateMillionths).toBe(1_000_000)
    expect(receipt.amountCents).toBe(receipt.functionalCents)
  })
})

describe('the register this was the last entry on', () => {
  it('is empty, and this file is why', async () => {
    // Phase 139's device: an entry points at the test that says when it is done.
    // `PENDING_WIRING` held seven entries over eleven targets when it was built
    // and is empty for the first time — one entry at a time, each with a
    // sentence saying what was in the way.
    expect(PENDING_WIRING).toEqual([])
  })
})
