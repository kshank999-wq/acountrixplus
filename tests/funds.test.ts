import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, fundReleases, journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { createCustomer } from '@/modules/receivables/service'
import { ModuleDisabledError, setModuleEnabled } from '@/modules/industry/modules'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { accountByNumber } from '@/modules/coa/service'
import { postManualEntry } from '@/modules/ledger/journal'
import { profitAndLoss } from '@/modules/ledger/reports'
import { dimensionalProfitAndLoss } from '@/modules/dimensions/reporting'
import { listDimensions } from '@/modules/dimensions/service'
import {
  fundRollforward,
  isReleasable,
  netAssetClassOf,
  releaseFor,
} from '@/modules/funds/restriction'
import { FundError, closeFund, createFund, listFunds, updateFund } from '@/modules/funds/service'
import {
  listContributions,
  outstandingPledges,
  receivePledge,
  recordContribution,
} from '@/modules/funds/contributions'
import { previewReleases, runReleases } from '@/modules/funds/releases'
import { fundBalances, netAssets } from '@/modules/funds/reporting'

/**
 * Fund accounting (spec §5 Nonprofit, Phase 26).
 *
 * Four claims under test:
 *
 *  1. **A restriction is the donor's, not the charity's.** A fund never
 *     releases more than it was given, whatever it spends.
 *  2. **A promise is revenue when it is made.** Receiving it later is not
 *     revenue a second time.
 *  3. **A release changes no total.** It moves money between the two columns
 *     of the statement of activities and leaves the income for the year alone.
 *  4. **Spending is whatever the ledger says**, including postings made
 *     through no part of this module.
 */

/** A charity with one restricted appeal, ready to receive. */
async function charity(name = 'Riverside Trust') {
  const fixture = await createCompanyFixture({ name, industry: 'nonprofit' })

  const roof = await createFund(fixture.ctx, {
    code: 'ROOF',
    name: 'Roof appeal',
    restriction: 'restricted',
    purpose: 'Replacing the hall roof, as set out in the appeal letter.',
  })

  return { fixture, roof }
}

/** The Fund dimension's id, for tagging a posting by hand. */
async function fundDimension(fixture: Fixture) {
  const dimensions = await listDimensions(fixture.ctx)
  const dimension = dimensions.find((d) => d.code === 'FUND')
  expect(dimension).toBeTruthy()
  return dimension!
}

/** Posts an ordinary expense against a fund, through no part of this module. */
async function spendByHand(
  fixture: Fixture,
  dimensionValueId: string,
  amountCents: number,
  entryDate: string,
  accountNumber = '6020',
) {
  const dimension = await fundDimension(fixture)
  const expense = await accountByNumber(fixture.companyId, accountNumber)
  const [bank] = await db
    .select()
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, '1000')))
    .limit(1)

  return postManualEntry(fixture.ctx, {
    entryDate,
    memo: 'Paid by somebody who has never opened the funds screen',
    lines: [
      {
        chartAccountId: expense!.id,
        debitCents: amountCents,
        dimensions: { [dimension.id]: dimensionValueId },
      },
      { chartAccountId: bank.id, creditCents: amountCents },
    ],
  })
}

describe('what a restriction means, in arithmetic (Phase 26)', () => {
  it('releases the lesser of what was given and what was spent', () => {
    expect(releaseFor(10_000, 4_000)).toEqual({ releaseCents: 4_000, shortfallCents: 0 })
    expect(releaseFor(4_000, 10_000)).toEqual({ releaseCents: 4_000, shortfallCents: 6_000 })
    expect(releaseFor(4_000, 4_000)).toEqual({ releaseCents: 4_000, shortfallCents: 0 })
  })

  it('never releases from a fund with nothing in it', () => {
    expect(releaseFor(0, 9_999)).toEqual({ releaseCents: 0, shortfallCents: 9_999 })
    // A fund already overdrawn cannot release a negative amount into existence.
    expect(releaseFor(-5_000, 1_000)).toEqual({ releaseCents: 0, shortfallCents: 1_000 })
  })

  it('treats spending nothing as releasing nothing, not as a shortfall', () => {
    expect(releaseFor(10_000, 0)).toEqual({ releaseCents: 0, shortfallCents: 0 })
    expect(releaseFor(10_000, -50)).toEqual({ releaseCents: 0, shortfallCents: 0 })
  })

  it('places an endowment in the restricted column and refuses to release it', () => {
    expect(netAssetClassOf('perpetual')).toBe('with_donor_restrictions')
    expect(netAssetClassOf('restricted')).toBe('with_donor_restrictions')
    expect(netAssetClassOf('unrestricted')).toBe('without_donor_restrictions')

    expect(isReleasable('perpetual')).toBe(false)
    expect(isReleasable('unrestricted')).toBe(false)
    expect(isReleasable('restricted')).toBe(true)
  })

  it('will not let February spend March money', () => {
    // £8,000 spent in February, £10,000 given in March. Netting the year would
    // say February was covered. It was not.
    const roll = fundRollforward(0, [
      { periodStart: '2026-02-01', receivedCents: 0, spentCents: 8_000, releasedCents: 0 },
      { periodStart: '2026-03-01', receivedCents: 10_000, spentCents: 0, releasedCents: 0 },
    ])

    expect(roll.periods[0].releasableCents).toBe(0)
    expect(roll.periods[0].shortfallCents).toBe(8_000)
    expect(roll.closingCents).toBe(10_000)
  })

  it('lets a month spend what it was given in that same month', () => {
    const roll = fundRollforward(0, [
      { periodStart: '2026-03-01', receivedCents: 10_000, spentCents: 4_000, releasedCents: 4_000 },
    ])

    expect(roll.periods[0].releasableCents).toBe(4_000)
    expect(roll.periods[0].shortfallCents).toBe(0)
    expect(roll.closingCents).toBe(6_000)
  })

  it('counts release earned but not posted, without spending it twice', () => {
    const roll = fundRollforward(0, [
      { periodStart: '2026-03-01', receivedCents: 10_000, spentCents: 4_000, releasedCents: 0 },
    ])

    // The money is still in the fund, because the entry has not been posted.
    expect(roll.closingCents).toBe(10_000)
    expect(roll.unreleasedCents).toBe(4_000)
  })
})

describe('a restriction is the donor’s, not the charity’s (Phase 26)', () => {
  it('opens a fund with a dimension value, so it reports through Phase 16', async () => {
    const { fixture, roof } = await charity()

    expect(roof.dimensionValueId).toBeTruthy()
    const dimension = await fundDimension(fixture)
    expect(dimension.name).toBe('Fund')

    const funds = await listFunds(fixture.ctx)
    expect(funds.map((fund) => fund.code)).toEqual(['ROOF'])
  })

  it('installs the accounts it posts to, even off the nonprofit pack', async () => {
    const fixture = await createCompanyFixture({ name: 'Village Hall CIC', industry: 'general' })
    await setModuleEnabled(fixture.ctx, 'funds', true)

    await createFund(fixture.ctx, { code: 'BUILD', name: 'Building fund' })

    for (const number of [
      INDUSTRY_ACCOUNTS.pledgesReceivable,
      INDUSTRY_ACCOUNTS.contributionRevenue,
      INDUSTRY_ACCOUNTS.releasedFromRestriction,
      INDUSTRY_ACCOUNTS.releasedToUnrestricted,
    ]) {
      expect(await accountByNumber(fixture.companyId, number)).toBeTruthy()
    }
  })

  it('refuses to open a fund when the module is off', async () => {
    const fixture = await createCompanyFixture({ name: 'No Funds Ltd', industry: 'general' })

    await expect(createFund(fixture.ctx, { code: 'X', name: 'X' })).rejects.toThrow(
      ModuleDisabledError,
    )
  })

  it('refuses to open a fund without the journal permission', async () => {
    const { fixture } = await charity()
    const salesperson = { ...fixture.ctx, role: 'sales' as const }

    await expect(createFund(salesperson, { code: 'Y', name: 'Y' })).rejects.toThrow(
      PermissionError,
    )
  })

  it('offers no way to change what the donor said', async () => {
    const { fixture, roof } = await charity()

    const updated = await updateFund(fixture.ctx, roof.id, { name: 'Roof and gutters appeal' })
    expect(updated.name).toBe('Roof and gutters appeal')
    // The restriction is not in the input type at all, so this is the whole
    // assertion: it cannot be edited, only superseded by closing the fund.
    expect(updated.restriction).toBe('restricted')
  })

  it('closes a fund that still holds money rather than refusing to', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
    })

    const closed = await closeFund(fixture.ctx, roof.id)
    expect(closed.isActive).toBe(false)

    // The money is untouched — closing is about what may arrive next, not
    // about what is already there.
    const [balance] = await fundBalances(fixture.ctx, {
      asOf: '2026-12-31',
      includeInactive: true,
    })
    expect(balance.availableCents).toBe(30_000)
  })
})

describe('a promise is revenue when it is made (Phase 26)', () => {
  it('recognises a pledge as income on the day it is promised', async () => {
    const { fixture, roof } = await charity()
    const donor = await createCustomer(fixture.ctx, { name: 'Marguerite Adeyemi' })

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      donorId: donor.id,
      kind: 'pledge',
      receivedOn: '2026-03-10',
      amountCents: 50_000,
    })

    const pl = await profitAndLoss(fixture.ctx, { startDate: '2026-03-01', endDate: '2026-03-31' })
    expect(pl.revenue.totalCents).toBe(50_000)

    // …and it sits in Pledges Receivable, not in the bank.
    const receivable = await accountByNumber(
      fixture.companyId,
      INDUSTRY_ACCOUNTS.pledgesReceivable,
    )
    const lines = await db
      .select({ debitCents: journalLines.debitCents })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.companyId, fixture.companyId),
          eq(journalLines.chartAccountId, receivable!.id),
        ),
      )
    expect(lines.reduce((sum, line) => sum + line.debitCents, 0)).toBe(50_000)
  })

  it('posts no income at all when the promised money arrives', async () => {
    const { fixture, roof } = await charity()

    const pledge = await recordContribution(fixture.ctx, {
      fundId: roof.id,
      kind: 'pledge',
      receivedOn: '2026-03-10',
      amountCents: 50_000,
    })

    const before = await profitAndLoss(fixture.ctx, { startDate: '2026-01-01', endDate: '2026-12-31' })

    await receivePledge(fixture.ctx, {
      contributionId: pledge.id,
      amountCents: 50_000,
      receivedOn: '2026-06-04',
      financialAccountId: fixture.financialAccountId,
    })

    const after = await profitAndLoss(fixture.ctx, { startDate: '2026-01-01', endDate: '2026-12-31' })

    // The whole claim: counting it again here would reconcile perfectly — the
    // bank agrees, the fund agrees — and only the income for the year would be
    // wrong, by the size of the appeal.
    expect(after.revenue.totalCents).toBe(before.revenue.totalCents)
  })

  it('takes a promise in instalments and reports what is still owed', async () => {
    const { fixture, roof } = await charity()

    const pledge = await recordContribution(fixture.ctx, {
      fundId: roof.id,
      kind: 'pledge',
      receivedOn: '2026-03-10',
      amountCents: 50_000,
    })

    const first = await receivePledge(fixture.ctx, {
      contributionId: pledge.id,
      amountCents: 20_000,
      receivedOn: '2026-04-01',
      financialAccountId: fixture.financialAccountId,
    })
    expect(first.outstandingCents).toBe(30_000)

    const waiting = await outstandingPledges(fixture.ctx)
    expect(waiting).toHaveLength(1)
    expect(waiting[0].outstandingCents).toBe(30_000)

    await receivePledge(fixture.ctx, {
      contributionId: pledge.id,
      amountCents: 30_000,
      receivedOn: '2026-05-01',
      financialAccountId: fixture.financialAccountId,
    })

    expect(await outstandingPledges(fixture.ctx)).toHaveLength(0)
  })

  it('refuses to receive more than was promised', async () => {
    const { fixture, roof } = await charity()

    const pledge = await recordContribution(fixture.ctx, {
      fundId: roof.id,
      kind: 'pledge',
      receivedOn: '2026-03-10',
      amountCents: 50_000,
    })

    await expect(
      receivePledge(fixture.ctx, {
        contributionId: pledge.id,
        amountCents: 60_000,
        receivedOn: '2026-04-01',
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(FundError)
  })

  it('refuses to "receive" a gift, which is already in', async () => {
    const { fixture, roof } = await charity()

    const gift = await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-10',
      amountCents: 10_000,
      financialAccountId: fixture.financialAccountId,
    })

    await expect(
      receivePledge(fixture.ctx, {
        contributionId: gift.id,
        amountCents: 10_000,
        receivedOn: '2026-04-01',
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(FundError)
  })

  it('records an anonymous gift, because a collection tin has no donor', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-10',
      amountCents: 4_250,
      financialAccountId: fixture.financialAccountId,
    })

    const [row] = await listContributions(fixture.ctx)
    expect(row.donorName).toBeNull()
    expect(row.amountCents).toBe(4_250)
  })
})

describe('a release changes no total (Phase 26)', () => {
  it('moves money between the columns and leaves the income for the year alone', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-20')

    const before = await profitAndLoss(fixture.ctx, { startDate: '2026-01-01', endDate: '2026-12-31' })
    const run = await runReleases(fixture.ctx, { month: '2026-03-01' })
    const after = await profitAndLoss(fixture.ctx, { startDate: '2026-01-01', endDate: '2026-12-31' })

    expect(run.releasedCents).toBe(40_000)
    expect(run.postedCount).toBe(1)

    // The whole claim. The debit and the credit are both income accounts and
    // they sum to zero, so the total is identical either side of the run.
    expect(after.revenue.totalCents).toBe(before.revenue.totalCents)
    expect(after.netIncomeCents).toBe(before.netIncomeCents)
  })

  it('lowers what the fund still holds by exactly what it released', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-20')

    const [before] = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    expect(before.availableCents).toBe(100_000)
    expect(before.unreleasedCents).toBe(40_000)

    await runReleases(fixture.ctx, { month: '2026-03-01' })

    const [after] = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    expect(after.availableCents).toBe(60_000)
    expect(after.releasedCents).toBe(40_000)
    expect(after.unreleasedCents).toBe(0)
  })

  it('releases once per fund per month, however many times the run fires', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-20')

    const first = await runReleases(fixture.ctx, { month: '2026-03-01' })
    const second = await runReleases(fixture.ctx, { month: '2026-03-01' })

    expect(first.postedCount).toBe(1)
    expect(second.postedCount).toBe(0)
    expect(second.lines[0].skipped).toBe('already_released')

    const rows = await db
      .select()
      .from(fundReleases)
      .where(eq(fundReleases.companyId, fixture.companyId))
    expect(rows).toHaveLength(1)
  })

  it('survives two runs racing for the same month', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-20')

    const [a, b] = await Promise.all([
      runReleases(fixture.ctx, { month: '2026-03-01' }),
      runReleases(fixture.ctx, { month: '2026-03-01' }),
    ])

    // The database arbitrates: exactly one of them posted.
    expect(a.postedCount + b.postedCount).toBe(1)

    const rows = await db
      .select()
      .from(fundReleases)
      .where(eq(fundReleases.companyId, fixture.companyId))
    expect(rows).toHaveLength(1)
  })

  it('does not release the same donation twice across two months', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 60_000, '2026-03-20')
    await spendByHand(fixture, roof.dimensionValueId, 60_000, '2026-04-15')

    await runReleases(fixture.ctx, { month: '2026-03-01' })
    const april = await runReleases(fixture.ctx, { month: '2026-04-01' })

    // Only £40,000 was left, so April releases that and reports the rest as
    // spending the fund never had.
    expect(april.releasedCents).toBe(40_000)
    expect(april.shortfallCents).toBe(20_000)

    const [balance] = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    expect(balance.releasedCents).toBe(100_000)
    expect(balance.availableCents).toBe(0)
  })

  it('does not release the same donation twice when the months are run out of order', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-01-05',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 100_000, '2026-02-10')
    await spendByHand(fixture, roof.dimensionValueId, 100_000, '2026-03-10')

    // March first, then somebody notices February was never run. Counting only
    // the releases dated before February would make February blind to March's,
    // and £100,000 of donations would release £200,000.
    const march = await runReleases(fixture.ctx, { month: '2026-03-01' })
    const february = await runReleases(fixture.ctx, { month: '2026-02-01' })

    expect(march.releasedCents).toBe(100_000)
    expect(february.releasedCents).toBe(0)
    expect(february.shortfallCents).toBe(100_000)

    const [balance] = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    expect(balance.releasedCents).toBe(100_000)
    expect(balance.availableCents).toBe(0)
  })

  it('never drives a fund negative, however much is spent', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 10_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 90_000, '2026-03-20')

    const run = await runReleases(fixture.ctx, { month: '2026-03-01' })
    expect(run.releasedCents).toBe(10_000)
    expect(run.shortfallCents).toBe(80_000)

    const [balance] = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    expect(balance.availableCents).toBe(0)
    expect(balance.shortfallCents).toBe(80_000)
  })

  it('never releases an endowment’s principal', async () => {
    const { fixture } = await charity()

    const endowment = await createFund(fixture.ctx, {
      code: 'LEGACY',
      name: 'Hoyle legacy',
      restriction: 'perpetual',
    })

    await recordContribution(fixture.ctx, {
      fundId: endowment.id,
      receivedOn: '2026-03-02',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, endowment.dimensionValueId, 50_000, '2026-03-20')

    const preview = await previewReleases(fixture.ctx, { month: '2026-03-01' })
    expect(preview.lines.map((line) => line.fundCode)).not.toContain('LEGACY')

    const run = await runReleases(fixture.ctx, { month: '2026-03-01' })
    expect(run.postedCount).toBe(0)

    const balances = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    const legacy = balances.find((fund) => fund.code === 'LEGACY')!
    expect(legacy.availableCents).toBe(500_000)
    expect(legacy.unreleasedCents).toBe(0)
  })

  it('says what it would do before it does it', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-20')

    const preview = await previewReleases(fixture.ctx, { month: '2026-03-01' })
    expect(preview.releasedCents).toBe(40_000)
    expect(preview.postedCount).toBe(0)

    // Nothing was posted by looking.
    const rows = await db
      .select()
      .from(fundReleases)
      .where(eq(fundReleases.companyId, fixture.companyId))
    expect(rows).toHaveLength(0)
  })

  it('takes the month as a parameter rather than reading the clock', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2021-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2021-03-20')

    // Five years ago, asked today.
    const run = await runReleases(fixture.ctx, { month: '2021-03-01' })
    expect(run.releasedCents).toBe(40_000)

    const [entry] = await db
      .select({ entryDate: journalEntries.entryDate, source: journalEntries.source })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.source, 'release'),
        ),
      )
    expect(entry.entryDate).toBe('2021-03-01')
  })

  it('refuses to run a release without the journal permission', async () => {
    const { fixture } = await charity()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    await expect(runReleases(readonly, { month: '2026-03-01' })).rejects.toThrow(PermissionError)
  })
})

describe('spending is whatever the ledger says (Phase 26)', () => {
  it('counts a bill coded to a fund by somebody who never opened this module', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })

    // Posted through `postManualEntry` with a dimension — no funds API touched
    // it at all. This is the same proof Phase 23 ran for a roof repair against
    // a property.
    await spendByHand(fixture, roof.dimensionValueId, 25_000, '2026-03-11')

    const [balance] = await fundBalances(fixture.ctx, { asOf: '2026-12-31' })
    expect(balance.spentCents).toBe(25_000)

    const run = await runReleases(fixture.ctx, { month: '2026-03-01' })
    expect(run.releasedCents).toBe(25_000)
  })

  it('reports per fund through Phase 16 rather than through a report of its own', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 25_000, '2026-03-11')

    const dimension = await fundDimension(fixture)
    const report = await dimensionalProfitAndLoss(fixture.ctx, {
      dimensionId: dimension.id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    const column = report.columns.findIndex((col) => col.code === 'ROOF')
    expect(column).toBeGreaterThanOrEqual(0)
    expect(
      report.operatingExpenses.some((row) => row.amountsCents[column] === 25_000),
    ).toBe(true)
  })

  it('nets a refund off the spending rather than ignoring it', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-11')

    // The supplier refunds half: an expense credit, same fund, same month.
    const dimension = await fundDimension(fixture)
    const expense = await accountByNumber(fixture.companyId, '6020')
    const [bank] = await db
      .select()
      .from(chartAccounts)
      .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, '1000')))
      .limit(1)

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-18',
      memo: 'Supplier refund',
      lines: [
        { chartAccountId: bank.id, debitCents: 20_000 },
        {
          chartAccountId: expense!.id,
          creditCents: 20_000,
          dimensions: { [dimension.id]: roof.dimensionValueId },
        },
      ],
    })

    const run = await previewReleases(fixture.ctx, { month: '2026-03-01' })
    expect(run.lines[0].spentCents).toBe(20_000)
  })
})

describe('what the two columns add up to (Phase 26)', () => {
  it('splits net assets into with and without donor restrictions', async () => {
    const { fixture, roof } = await charity()

    const general = await createFund(fixture.ctx, {
      code: 'GENERAL',
      name: 'General funds',
      restriction: 'unrestricted',
    })

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await recordContribution(fixture.ctx, {
      fundId: general.id,
      receivedOn: '2026-03-03',
      amountCents: 30_000,
      financialAccountId: fixture.financialAccountId,
    })

    const report = await netAssets(fixture.ctx, { asOf: '2026-12-31' })

    expect(report.withRestrictionCents).toBe(100_000)
    expect(report.totalCents).toBe(130_000)
    expect(report.withoutRestrictionCents).toBe(30_000)
  })

  it('moves money from one column to the other when the release runs', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 40_000, '2026-03-20')

    const before = await netAssets(fixture.ctx, { asOf: '2026-12-31' })
    await runReleases(fixture.ctx, { month: '2026-03-01' })
    const after = await netAssets(fixture.ctx, { asOf: '2026-12-31' })

    expect(before.withRestrictionCents).toBe(100_000)
    expect(after.withRestrictionCents).toBe(60_000)

    // The total is the same money, in a different column. It fell by the
    // spending and by nothing else.
    expect(before.totalCents).toBe(60_000)
    expect(after.totalCents).toBe(60_000)
  })

  it('notices a donation that belongs to no fund at all', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })

    const clean = await netAssets(fixture.ctx, { asOf: '2026-12-31' })
    expect(clean.agrees).toBe(true)
    expect(clean.untaggedContributionCents).toBe(0)

    // A donation posted straight to 4500 with no fund on the line. It is real
    // money on the books and it is outside every fund figure — which is
    // exactly what the check exists to say.
    const contributionAccount = await accountByNumber(
      fixture.companyId,
      INDUSTRY_ACCOUNTS.contributionRevenue,
    )
    const [bank] = await db
      .select()
      .from(chartAccounts)
      .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, '1000')))
      .limit(1)

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-02',
      memo: 'Cheque in the post, nobody said what for',
      lines: [
        { chartAccountId: bank.id, debitCents: 7_500 },
        { chartAccountId: contributionAccount!.id, creditCents: 7_500 },
      ],
    })

    const dirty = await netAssets(fixture.ctx, { asOf: '2026-12-31' })
    expect(dirty.agrees).toBe(false)
    expect(dirty.untaggedContributionCents).toBe(7_500)
  })

  it('lists the funds that have been spent beyond what they were given', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 10_000,
      financialAccountId: fixture.financialAccountId,
    })
    await spendByHand(fixture, roof.dimensionValueId, 90_000, '2026-03-20')
    await runReleases(fixture.ctx, { month: '2026-03-01' })

    const report = await netAssets(fixture.ctx, { asOf: '2026-12-31' })
    expect(report.overspent.map((fund) => fund.code)).toEqual(['ROOF'])
    expect(report.overspent[0].shortfallCents).toBe(80_000)
  })

  it('answers as at a date rather than as at now', async () => {
    const { fixture, roof } = await charity()

    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-03-02',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })
    await recordContribution(fixture.ctx, {
      fundId: roof.id,
      receivedOn: '2026-09-02',
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
    })

    const march = await netAssets(fixture.ctx, { asOf: '2026-03-31' })
    const december = await netAssets(fixture.ctx, { asOf: '2026-12-31' })

    expect(march.withRestrictionCents).toBe(100_000)
    expect(december.withRestrictionCents).toBe(150_000)
  })

  it('keeps one charity’s funds invisible to another', async () => {
    const { fixture: theirs } = await charity('Northgate Trust')
    const { fixture: ours } = await charity('Southgate Trust')

    expect((await listFunds(ours.ctx)).map((fund) => fund.code)).toEqual(['ROOF'])
    expect((await listFunds(theirs.ctx)).map((fund) => fund.code)).toEqual(['ROOF'])

    // Same code, different rows — and neither can see the other's.
    const oursIds = (await listFunds(ours.ctx)).map((fund) => fund.id)
    const theirsIds = (await listFunds(theirs.ctx)).map((fund) => fund.id)
    expect(oursIds).not.toEqual(theirsIds)
  })
})
