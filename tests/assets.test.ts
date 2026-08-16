import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { fixedAssets } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  addMonths,
  amountForPeriod,
  conventionWeights,
  depreciableBaseCents,
  depreciationSchedule,
  disposalOutcome,
  InvalidScheduleError,
  monthEnd,
  monthStart,
  periodsThrough,
  type DepreciationConvention,
  type DepreciationMethod,
} from '@/modules/assets/depreciation'
import {
  assetRegister,
  cashChartAccounts,
  depreciationDue,
  depreciationHistory,
  DepreciationRaceError,
  disposeAsset,
  reconcileFixedAssets,
  registerAsset,
  runDepreciation,
} from '@/modules/assets/service'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { trialBalance } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'

/**
 * The fixed asset register (spec §13, Phase 16).
 *
 * The claim under test: **the register equals the ledger.** The schedule block
 * is the arithmetic it rests on; the rest are the ways it could come apart.
 */

const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

describe('depreciation schedules', () => {
  it('spreads the depreciable base evenly on straight line', () => {
    const schedule = depreciationSchedule({
      costCents: 1_000_000,
      salvageValueCents: 100_000,
      lifeMonths: 36,
      method: 'straight_line',
      convention: 'full_month',
      inServiceMonth: '2026-01-01',
    })

    expect(schedule).toHaveLength(36)
    expect(schedule[0]).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      amountCents: 25_000,
    })
    expect(schedule[35].periodEnd).toBe('2028-12-31')
  })

  /**
   * The property the whole module rests on. If a schedule can be a cent short,
   * an asset never fully depreciates and the residue survives every close
   * until somebody has to explain it years later.
   */
  it('sums exactly to the depreciable base for every method, convention and life', () => {
    const methods: DepreciationMethod[] = [
      'straight_line',
      'declining_balance',
      'declining_balance_switch',
    ]
    const conventions: DepreciationConvention[] = ['full_month', 'mid_month', 'half_year']
    // Costs picked to divide badly: 999.99 over 7 years is not a round cent.
    const costs = [1_000_000, 99_999, 1_234_567, 3, 87_654_321]
    const salvages = [0, 7, 100_000]
    const lives = [1, 2, 12, 36, 60, 84, 120]

    let checked = 0

    for (const method of methods) {
      for (const convention of conventions) {
        for (const costCents of costs) {
          for (const salvageValueCents of salvages) {
            for (const lifeMonths of lives) {
              if (salvageValueCents >= costCents) continue

              const schedule = depreciationSchedule({
                costCents,
                salvageValueCents,
                lifeMonths,
                method,
                convention,
                inServiceMonth: '2026-01-01',
              })

              const base = depreciableBaseCents(costCents, salvageValueCents)
              const total = schedule.reduce((sum, period) => sum + period.amountCents, 0)

              expect(total).toBe(base)
              expect(schedule[schedule.length - 1].bookValueCents).toBe(salvageValueCents)
              expect(schedule.every((period) => period.amountCents > 0)).toBe(true)

              checked += 1
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(500)
  })

  it('gives a half-year convention exactly half a year in year one', () => {
    const schedule = depreciationSchedule({
      costCents: 1_200_000,
      salvageValueCents: 0,
      lifeMonths: 60,
      method: 'straight_line',
      convention: 'half_year',
      inServiceMonth: '2026-01-01',
    })

    // $1,200,000 over 60 months is $20,000 a month; six months is $120,000.
    const yearOne = schedule.slice(0, 12).reduce((sum, period) => sum + period.amountCents, 0)
    expect(yearOne).toBe(120_000)
    // The six months held back extend the schedule past the nominal life.
    expect(schedule).toHaveLength(66)
  })

  it('gives a mid-month convention half a month at each end', () => {
    const schedule = depreciationSchedule({
      costCents: 360_000,
      salvageValueCents: 0,
      lifeMonths: 36,
      method: 'straight_line',
      convention: 'mid_month',
      inServiceMonth: '2026-01-01',
    })

    expect(schedule).toHaveLength(37)
    expect(schedule[0].amountCents).toBe(5_000)
    expect(schedule[1].amountCents).toBe(10_000)
    expect(schedule[36].amountCents).toBe(5_000)
  })

  it('front-loads declining balance and lands on salvage anyway', () => {
    const declining = depreciationSchedule({
      costCents: 1_000_000,
      salvageValueCents: 0,
      lifeMonths: 60,
      method: 'declining_balance',
      convention: 'full_month',
      inServiceMonth: '2026-01-01',
      decliningFactor: 2,
    })

    const straight = depreciationSchedule({
      costCents: 1_000_000,
      salvageValueCents: 0,
      lifeMonths: 60,
      method: 'straight_line',
      convention: 'full_month',
      inServiceMonth: '2026-01-01',
    })

    expect(declining[0].amountCents).toBeGreaterThan(straight[0].amountCents)
    // Without a crossover the method never reaches salvage on its own, so the
    // final period visibly carries the remainder. That lump is the honest
    // depiction of declining balance, not a rounding artifact.
    expect(declining[59].amountCents).toBeGreaterThan(declining[58].amountCents)
  })

  it('switches to straight line before the tail becomes a lump', () => {
    const withSwitch = depreciationSchedule({
      costCents: 1_000_000,
      salvageValueCents: 0,
      lifeMonths: 60,
      method: 'declining_balance_switch',
      convention: 'full_month',
      inServiceMonth: '2026-01-01',
      decliningFactor: 2,
    })

    const withoutSwitch = depreciationSchedule({
      costCents: 1_000_000,
      salvageValueCents: 0,
      lifeMonths: 60,
      method: 'declining_balance',
      convention: 'full_month',
      inServiceMonth: '2026-01-01',
      decliningFactor: 2,
    })

    // Same front end — the switch has not bitten yet.
    expect(withSwitch[0].amountCents).toBe(withoutSwitch[0].amountCents)
    // Level tail rather than a final lump. Within a cent, because the running
    // rounding hands a cent back and forth between adjacent periods to keep
    // the total exact — which is the trade this design makes on purpose.
    expect(Math.abs(withSwitch[59].amountCents - withSwitch[58].amountCents)).toBeLessThanOrEqual(1)
    // The lump the crossover exists to remove: without it, the last period is
    // an order of magnitude bigger than its neighbours.
    expect(withoutSwitch[59].amountCents).toBeGreaterThan(withSwitch[59].amountCents * 5)
  })

  it('depreciates nothing when salvage equals cost', () => {
    expect(
      depreciationSchedule({
        costCents: 500_000,
        salvageValueCents: 500_000,
        lifeMonths: 60,
        method: 'straight_line',
        convention: 'full_month',
        inServiceMonth: '2026-01-01',
      }),
    ).toEqual([])
  })

  it('refuses terms that cannot produce a schedule', () => {
    expect(() =>
      depreciationSchedule({
        costCents: 100_000,
        salvageValueCents: 0,
        lifeMonths: 0,
        method: 'straight_line',
        convention: 'full_month',
        inServiceMonth: '2026-01-01',
      }),
    ).toThrow(InvalidScheduleError)
  })

  it('handles month arithmetic across year and leap boundaries', () => {
    expect(monthStart('2026-03-17')).toBe('2026-03-01')
    expect(monthEnd('2026-02-01')).toBe('2026-02-28')
    expect(monthEnd('2028-02-01')).toBe('2028-02-29')
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01')
    expect(addMonths('2026-01-01', 24)).toBe('2028-01-01')
  })

  it('keeps convention weights summing to the life', () => {
    for (const convention of ['full_month', 'mid_month', 'half_year'] as const) {
      for (const life of [1, 6, 12, 36, 60]) {
        const total = conventionWeights(life, convention).reduce((sum, w) => sum + w, 0)
        expect(total).toBeCloseTo(life, 9)
      }
    }
  })

  it('finds a period, and every period through a date', () => {
    const schedule = depreciationSchedule({
      costCents: 120_000,
      salvageValueCents: 0,
      lifeMonths: 12,
      method: 'straight_line',
      convention: 'full_month',
      inServiceMonth: '2026-01-01',
    })

    expect(amountForPeriod(schedule, '2026-04-30')?.amountCents).toBe(10_000)
    expect(amountForPeriod(schedule, '2029-04-30')).toBeNull()
    expect(periodsThrough(schedule, '2026-03-31')).toHaveLength(3)
  })

  it('computes gain and loss from book value', () => {
    expect(disposalOutcome(1_000_000, 600_000, 500_000)).toEqual({
      bookValueCents: 400_000,
      gainLossCents: 100_000,
    })
    expect(disposalOutcome(1_000_000, 600_000, 250_000)).toEqual({
      bookValueCents: 400_000,
      gainLossCents: -150_000,
    })
  })
})

async function truckFixture(): Promise<Fixture & { assetId: string; tag: string }> {
  const fixture = await createCompanyFixture()

  // $48,000 van, no salvage, four years. $1,000 a month exactly, so a failure
  // is a real defect rather than an argument about rounding.
  const asset = await registerAsset(fixture.ctx, {
    name: 'Ford Transit van',
    category: 'Vehicles',
    costCents: 4_800_000,
    lifeMonths: 48,
    acquiredDate: '2026-01-10',
    inServiceDate: '2026-01-10',
    // The purchase is not otherwise in these books, so post it.
    postAcquisitionCreditAccountId: (await accountByNumber(
      fixture.companyId,
      SYSTEM_ACCOUNTS.defaultChecking,
    ))!.id,
  })

  return { ...fixture, assetId: asset.id, tag: asset.tag }
}

describe('the register', () => {
  it('registering an asset posts nothing by default', async () => {
    const fixture = await createCompanyFixture()

    const before = await trialBalance(fixture.ctx)
    await registerAsset(fixture.ctx, {
      name: 'Second-hand forklift',
      costCents: 900_000,
      lifeMonths: 60,
      acquiredDate: '2026-02-01',
    })
    const after = await trialBalance(fixture.ctx)

    // The purchase was already coded when the bill was entered. Posting it
    // again would put the forklift on the balance sheet twice.
    expect(after.totalDebitCents).toBe(before.totalDebitCents)
    expect(after.totalCreditCents).toBe(before.totalCreditCents)
  })

  it('numbers assets sequentially', async () => {
    const fixture = await createCompanyFixture()

    const first = await registerAsset(fixture.ctx, {
      name: 'Laptop',
      costCents: 200_000,
      lifeMonths: 36,
      acquiredDate: '2026-01-01',
    })
    const second = await registerAsset(fixture.ctx, {
      name: 'Monitor',
      costCents: 60_000,
      lifeMonths: 36,
      acquiredDate: '2026-01-01',
    })

    expect(first.tag).toBe('FA-0001')
    expect(second.tag).toBe('FA-0002')
  })

  it('refuses salvage above cost', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      registerAsset(fixture.ctx, {
        name: 'Appreciating sculpture',
        costCents: 100_000,
        salvageValueCents: 150_000,
        lifeMonths: 60,
        acquiredDate: '2026-01-01',
      }),
    ).rejects.toThrow(/salvage/i)
  })

  it('refuses an in-service date before acquisition', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      registerAsset(fixture.ctx, {
        name: 'Time-travelling oven',
        costCents: 100_000,
        lifeMonths: 60,
        acquiredDate: '2026-06-01',
        inServiceDate: '2026-01-01',
      }),
    ).rejects.toThrow(/before it was acquired/i)
  })
})

describe('running depreciation', () => {
  it('charges each arrears month to its own month, not to the run date', async () => {
    const fixture = await truckFixture()

    const runs = await runDepreciation(fixture.ctx, { throughDate: '2026-05-31' })

    // In service in January, run in May: five months, five entries, each
    // dated to the month the van was actually wearing out.
    expect(runs).toHaveLength(5)
    expect(runs.map((run) => run.periodEnd)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ])
    expect(runs.every((run) => run.amountCents === 100_000)).toBe(true)
  })

  /**
   * The claim. It will be run twice — a person clicks the button, a scheduled
   * job fires an hour later — and the second run must charge nothing.
   */
  it('running the same period twice charges once', async () => {
    const fixture = await truckFixture()

    await runDepreciation(fixture.ctx, { throughDate: '2026-03-31' })
    const second = await runDepreciation(fixture.ctx, { throughDate: '2026-03-31' })

    expect(second).toEqual([])

    const [asset] = await assetRegister(fixture.ctx)
    expect(asset.accumulatedCents).toBe(300_000)
    expect(await depreciationHistory(fixture.ctx, fixture.assetId)).toHaveLength(3)
  })

  it('two concurrent runs post one set of entries between them', async () => {
    const fixture = await truckFixture()

    const results = await Promise.allSettled([
      runDepreciation(fixture.ctx, { throughDate: '2026-02-28' }),
      runDepreciation(fixture.ctx, { throughDate: '2026-02-28' }),
    ])

    // One may lose the race outright, or find nothing left to do. Either is
    // correct; charging the van twice in February is not.
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(DepreciationRaceError)
      }
    }

    const history = await depreciationHistory(fixture.ctx, fixture.assetId)
    expect(history).toHaveLength(2)
    expect(history.reduce((sum, row) => sum + row.amountCents, 0)).toBe(200_000)
  })

  it('posts one entry a month covering every asset', async () => {
    const fixture = await truckFixture()
    await registerAsset(fixture.ctx, {
      name: 'Espresso machine',
      costCents: 240_000,
      lifeMonths: 24,
      acquiredDate: '2026-01-05',
    })

    const runs = await runDepreciation(fixture.ctx, { throughDate: '2026-01-31' })

    expect(runs).toHaveLength(1)
    expect(runs[0].assetCount).toBe(2)
    // $1,000 for the van plus $100 for the machine.
    expect(runs[0].amountCents).toBe(110_000)
  })

  it('lands the charge on Depreciation Expense', async () => {
    const fixture = await truckFixture()
    await runDepreciation(fixture.ctx, { throughDate: '2026-03-31' })

    const pl = await profitAndLoss(fixture.ctx, YEAR)
    const line = pl.otherExpenses.rows.find(
      (row) => row.number === SYSTEM_ACCOUNTS.depreciationExpense,
    )

    expect(line?.balanceCents).toBe(300_000)
  })

  it('stops when the schedule runs out, and marks the asset', async () => {
    const fixture = await createCompanyFixture()
    const asset = await registerAsset(fixture.ctx, {
      name: 'Short-lived tablet',
      costCents: 60_000,
      lifeMonths: 2,
      acquiredDate: '2026-01-01',
      postAcquisitionCreditAccountId: (await accountByNumber(
        fixture.companyId,
        SYSTEM_ACCOUNTS.defaultChecking,
      ))!.id,
    })

    await runDepreciation(fixture.ctx, { throughDate: '2026-12-31' })

    const [row] = await db.select().from(fixedAssets).where(eq(fixedAssets.id, asset.id))
    expect(row.status).toBe('fully_depreciated')

    const [registered] = await assetRegister(fixture.ctx)
    expect(registered.accumulatedCents).toBe(60_000)
    expect(registered.bookValueCents).toBe(0)

    // And nothing more is ever owed.
    expect(await depreciationDue(fixture.ctx, { throughDate: '2030-12-31' })).toEqual([])
  })

  /**
   * A period is owed once it has *ended*. Rounding the cut-off up to the end
   * of its month meant asking "what is owed today" on the 16th offered a whole
   * month of that month, dated the 31st — a future-dated entry for a month
   * that had not happened.
   */
  it('does not charge a month that has not finished', async () => {
    const fixture = await truckFixture()

    const midMarch = await depreciationDue(fixture.ctx, { throughDate: '2026-03-16' })
    expect(midMarch.map((row) => row.periodEnd)).toEqual(['2026-01-31', '2026-02-28'])

    // Somebody who genuinely wants March says so.
    const endMarch = await depreciationDue(fixture.ctx, { throughDate: '2026-03-31' })
    expect(endMarch).toHaveLength(3)
  })

  it('charges nothing before the asset goes into service', async () => {
    const fixture = await createCompanyFixture()
    await registerAsset(fixture.ctx, {
      name: 'Oven still in its crate',
      costCents: 120_000,
      lifeMonths: 12,
      acquiredDate: '2026-01-01',
      inServiceDate: '2026-07-01',
    })

    expect(await depreciationDue(fixture.ctx, { throughDate: '2026-06-30' })).toEqual([])
    expect(await depreciationDue(fixture.ctx, { throughDate: '2026-07-31' })).toHaveLength(1)
  })
})

describe('the register agrees with the ledger', () => {
  it('cost and accumulated depreciation both reconcile', async () => {
    const fixture = await truckFixture()
    await runDepreciation(fixture.ctx, { throughDate: '2026-06-30' })

    const reconciliation = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-06-30' })

    expect(reconciliation.registerCostCents).toBe(4_800_000)
    expect(reconciliation.ledgerCostCents).toBe(4_800_000)
    expect(reconciliation.registerAccumulatedCents).toBe(600_000)
    expect(reconciliation.ledgerAccumulatedCents).toBe(600_000)
    expect(reconciliation.agrees).toBe(true)
    expect(reconciliation.registerBookValueCents).toBe(4_200_000)
  })

  it('holds across several assets on different methods', async () => {
    const fixture = await truckFixture()
    const bank = (await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking))!.id

    await registerAsset(fixture.ctx, {
      name: 'Server rack',
      costCents: 1_499_999,
      salvageValueCents: 99_999,
      lifeMonths: 60,
      method: 'declining_balance_switch',
      convention: 'half_year',
      acquiredDate: '2026-02-14',
      postAcquisitionCreditAccountId: bank,
    })
    await registerAsset(fixture.ctx, {
      name: 'Delivery bike',
      costCents: 333_333,
      lifeMonths: 36,
      method: 'declining_balance',
      convention: 'mid_month',
      acquiredDate: '2026-03-01',
      postAcquisitionCreditAccountId: bank,
    })

    await runDepreciation(fixture.ctx, { throughDate: '2026-12-31' })

    const reconciliation = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-12-31' })
    expect(reconciliation.agrees).toBe(true)
    expect(reconciliation.registerCostCents).toBe(4_800_000 + 1_499_999 + 333_333)
  })

  /**
   * The failure the register exists to catch, asserted directly. An asset
   * entered on the register that nobody ever coded to Fixed Assets is
   * invisible on every other report — the balance sheet is right, the register
   * is right on its own terms, and only the comparison finds it.
   */
  it('reports a disagreement when an asset was never posted', async () => {
    const fixture = await truckFixture()
    await registerAsset(fixture.ctx, {
      name: 'Trailer nobody entered a bill for',
      costCents: 750_000,
      lifeMonths: 60,
      acquiredDate: '2026-01-01',
    })

    const reconciliation = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-01-31' })

    expect(reconciliation.costAgrees).toBe(false)
    expect(reconciliation.registerCostCents - reconciliation.ledgerCostCents).toBe(750_000)
    expect(reconciliation.agrees).toBe(false)
  })
})

describe('disposal', () => {
  it('charges arrears first so book value is what the ledger says', async () => {
    const fixture = await truckFixture()
    const bank = (await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking))!.id

    // Depreciation last run in March; the van is sold at the end of June.
    await runDepreciation(fixture.ctx, { throughDate: '2026-03-31' })

    const result = await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-06-30',
      proceedsCents: 4_400_000,
      proceedsAccountId: bank,
      reason: 'Sold to a courier firm',
    })

    // Three months were owed and charged before the disposal: six months at
    // $1,000 leaves a book value of $42,000, not the $45,000 the stale ledger
    // would have implied.
    expect(result.arrearsCharged).toBe(3)
    expect(result.bookValueCents).toBe(4_200_000)
    expect(result.gainLossCents).toBe(200_000)
  })

  it('a gain lands in Other income, not in Sales Revenue', async () => {
    const fixture = await truckFixture()
    const bank = (await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking))!.id

    await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-06-30',
      proceedsCents: 4_400_000,
      proceedsAccountId: bank,
    })

    const pl = await profitAndLoss(fixture.ctx, YEAR)
    expect(
      pl.otherIncome.rows.find((row) => row.number === SYSTEM_ACCOUNTS.gainOnDisposal)
        ?.balanceCents,
    ).toBe(200_000)
    expect(pl.revenue.rows).toHaveLength(0)
  })

  it('a loss lands in Other expense', async () => {
    const fixture = await truckFixture()
    const bank = (await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking))!.id

    await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-06-30',
      proceedsCents: 3_000_000,
      proceedsAccountId: bank,
    })

    const pl = await profitAndLoss(fixture.ctx, YEAR)
    expect(
      pl.otherExpenses.rows.find((row) => row.number === SYSTEM_ACCOUNTS.lossOnDisposal)
        ?.balanceCents,
    ).toBe(1_200_000)
  })

  it('takes the asset off the balance sheet entirely', async () => {
    const fixture = await truckFixture()
    const bank = (await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking))!.id

    await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-06-30',
      proceedsCents: 4_400_000,
      proceedsAccountId: bank,
    })

    const reconciliation = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-12-31' })
    expect(reconciliation.registerCostCents).toBe(0)
    expect(reconciliation.ledgerCostCents).toBe(0)
    expect(reconciliation.registerAccumulatedCents).toBe(0)
    expect(reconciliation.ledgerAccumulatedCents).toBe(0)
    expect(reconciliation.agrees).toBe(true)
  })

  it('scrapping for nothing is a loss of the whole book value', async () => {
    const fixture = await truckFixture()

    const result = await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-01-31',
      proceedsCents: 0,
      reason: 'Written off after a crash',
    })

    expect(result.gainLossCents).toBe(-4_700_000)

    const balance = await trialBalance(fixture.ctx)
    expect(balance.isBalanced).toBe(true)
  })

  it('refuses to dispose of the same asset twice', async () => {
    const fixture = await truckFixture()

    await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-06-30',
      proceedsCents: 0,
    })

    await expect(
      disposeAsset(fixture.ctx, {
        assetId: fixture.assetId,
        disposedOn: '2026-07-31',
        proceedsCents: 0,
      }),
    ).rejects.toThrow(/already been disposed/i)
  })

  /**
   * The disposal screen offers a list of accounts to bank the proceeds into,
   * and it first offered `depositableAccounts` — which returns **financial**
   * accounts, the bank connection rather than the ledger account. Every
   * disposal with proceeds failed at post time with "one or more chart
   * accounts were not found", which is the journal refusing correctly and a
   * useless thing to read on a form.
   *
   * This posts through the same list the screen renders, so the two cannot
   * drift apart again.
   */
  it('disposes through the account list the screen offers', async () => {
    const fixture = await truckFixture()

    const offered = await cashChartAccounts(fixture.ctx)
    expect(offered.length).toBeGreaterThan(0)

    const result = await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-06-30',
      proceedsCents: 4_400_000,
      proceedsAccountId: offered[0].id,
    })

    expect(result.gainLossCents).toBe(200_000)
    expect((await trialBalance(fixture.ctx)).isBalanced).toBe(true)
  })

  it('refuses proceeds with nowhere to put them', async () => {
    const fixture = await truckFixture()

    await expect(
      disposeAsset(fixture.ctx, {
        assetId: fixture.assetId,
        disposedOn: '2026-06-30',
        proceedsCents: 500_000,
      }),
    ).rejects.toThrow(/which account/i)
  })

  it('a disposed asset stops depreciating', async () => {
    const fixture = await truckFixture()

    await disposeAsset(fixture.ctx, {
      assetId: fixture.assetId,
      disposedOn: '2026-03-31',
      proceedsCents: 0,
    })

    expect(await depreciationDue(fixture.ctx, { throughDate: '2026-12-31' })).toEqual([])
  })
})
