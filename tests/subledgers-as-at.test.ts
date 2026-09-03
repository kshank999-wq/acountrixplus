import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db'
import { serviceItems } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS, SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { setModuleEnabled } from '@/modules/industry/modules'
import { checkByKey } from '@/modules/integrity/register'
import { receiveStock } from '@/modules/inventory/service'
import {
  assetRegister,
  disposeAsset,
  reconcileFixedAssets,
  registerAsset,
  runDepreciation,
} from '@/modules/assets/service'
import {
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  issueMaterial,
} from '@/modules/manufacturing/service'
import { wipPosition } from '@/modules/manufacturing/reporting'

/**
 * Two more subledgers restored to the date (Phase 111).
 *
 * Phase 110 read the eleven checks it had left `today_only` and found these two
 * present-tense for reasons only the query shows. Measured on the development
 * books at four dates, before this phase:
 *
 * ```
 * assets.register    2026-03-31: agrees  cost 10125000/10125000
 *                    2025-12-31: DIFFERS cost 10125000/0
 * manufacturing.wip  2026-03-31: agrees  12600/12600
 *                    2025-12-31: DIFFERS 12600/0
 * ```
 *
 * The left figure never moves. Both are **faults**, so asking about last
 * December reported $101,250 of broken books and a broken factory floor on
 * books that were perfectly correct. Afterwards, on the same books, every date
 * agrees and both register sides walk back to 0.
 */

describe('the asset register, as at a date', () => {
  let fixture: Fixture
  let bankId: string

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Ridgeline Plant Co' })
    bankId = (await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.defaultChecking))!.id
  })

  /** Posts the purchase, so the ledger has something to be compared against. */
  const buy = (name: string, costCents: number, acquiredDate: string) =>
    registerAsset(fixture.ctx, {
      name,
      costCents,
      lifeMonths: 48,
      acquiredDate,
      inServiceDate: acquiredDate,
      postAcquisitionCreditAccountId: bankId,
    })

  it('does not count an asset bought after the date', async () => {
    await buy('Excavator', 5_000_000, '2026-01-10')
    await buy('Trailer bought later', 800_000, '2026-06-01')

    const march = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-03-31' })
    const june = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-06-30' })

    // Before this phase the March figure was 5800000 against a ledger walked
    // back to 5000000 — a fault on correct books.
    expect(march.registerCostCents).toBe(5_000_000)
    expect(march.ledgerCostCents).toBe(5_000_000)
    expect(march.agrees).toBe(true)

    expect(june.registerCostCents).toBe(5_800_000)
    expect(june.agrees).toBe(true)
  })

  it('counts an asset on the very day it arrives', async () => {
    // Inclusive, because `registerAsset` posts with `entryDate: acquiredDate`
    // and a report as at that day includes the entry.
    await buy('Excavator', 5_000_000, '2026-01-10')

    expect((await reconcileFixedAssets(fixture.ctx, { asOf: '2026-01-10' })).registerCostCents).toBe(
      5_000_000,
    )
    expect((await reconcileFixedAssets(fixture.ctx, { asOf: '2026-01-09' })).registerCostCents).toBe(
      0,
    )
  })

  it('still counts an asset that was sold after the date', async () => {
    const asset = await buy('Van', 1_200_000, '2026-01-10')
    await disposeAsset(fixture.ctx, {
      assetId: asset.id,
      disposedOn: '2026-06-30',
      proceedsCents: 400_000,
      proceedsAccountId: bankId,
    })

    // It was on the books in March, and both sides know it.
    const march = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-03-31' })
    expect(march.registerCostCents).toBe(1_200_000)
    expect(march.ledgerCostCents).toBe(1_200_000)
    expect(march.agrees).toBe(true)
  })

  it('drops it on the day it is sold, not the day after', async () => {
    // Exclusive, for the mirror-image reason: `disposeAsset` posts the reversal
    // with `entryDate: disposedOn`, so the ledger as at that day has let it go.
    const asset = await buy('Van', 1_200_000, '2026-01-10')
    await disposeAsset(fixture.ctx, {
      assetId: asset.id,
      disposedOn: '2026-06-30',
      proceedsCents: 400_000,
      proceedsAccountId: bankId,
    })

    const onTheDay = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-06-30' })
    const dayBefore = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-06-29' })

    expect(onTheDay.registerCostCents).toBe(0)
    expect(onTheDay.agrees).toBe(true)
    expect(dayBefore.registerCostCents).toBe(1_200_000)
    expect(dayBefore.agrees).toBe(true)
  })

  it('agrees on both halves once depreciation has run', async () => {
    // The half that already worked, asserted so the repair is shown not to
    // have broken it: depreciation_entries was always filtered by period_end.
    await buy('Van', 4_800_000, '2026-01-10')
    await runDepreciation(fixture.ctx, { throughDate: '2026-06-30' })

    const june = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-06-30' })

    expect(june.registerAccumulatedCents).toBe(june.ledgerAccumulatedCents)
    expect(june.registerAccumulatedCents).toBeGreaterThan(0)
    expect(june.agrees).toBe(true)
  })

  it('says how many the date left out rather than showing a shorter list', async () => {
    await buy('Excavator', 5_000_000, '2026-01-10')
    await buy('Trailer bought later', 800_000, '2026-06-01')

    const march = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-03-31' })
    const june = await reconcileFixedAssets(fixture.ctx, { asOf: '2026-06-30' })

    expect(march.excludedNote).toContain('1 asset is left out')
    expect(march.excludedNote).toContain('2026-03-31')
    // Nothing to explain once everything is there.
    expect(june.excludedNote).toBeNull()
  })

  it('answers the same undated as it does for today', async () => {
    // The nightly run passes today; nothing about it changes.
    await buy('Excavator', 5_000_000, '2026-01-10')

    const undated = await assetRegister(fixture.ctx)
    const today = await assetRegister(fixture.ctx, { asOf: '2026-09-03' })

    expect(undated.map((asset) => asset.tag)).toEqual(today.map((asset) => asset.tag))
  })

  it('reaches any date, and says what makes that possible', () => {
    const check = checkByKey('assets.register')!

    expect(check.asAt.reach).toBe('any_date')
    expect(check.asAt.because).toContain('acquired_date')
    expect(check.asAt.because).toContain('disposed_on')
  })

  it('carries the exclusion through to the check somebody reads', async () => {
    // The note has to reach the operations page, which renders a stored run's
    // `detail`. Verified in the browser against Ridgeline's books at
    // 2026-02-28, where the register agrees at $58,500 and says why it is a
    // shorter list than today's.
    await buy('Excavator', 5_000_000, '2026-01-10')
    await buy('Trailer bought later', 800_000, '2026-06-01')

    const check = checkByKey('assets.register')!
    const march = await check.run(fixture.ctx, '2026-03-31')
    const june = await check.run(fixture.ctx, '2026-06-30')

    expect(march.agrees).toBe(true)
    expect(march.detail).toContain('1 asset is left out')
    expect(june.detail).toBeUndefined()
  })
})

describe('work in process, as at a date', () => {
  let fixture: Fixture & { rawId: string; stoolId: string }

  beforeEach(async () => {
    const base = await createCompanyFixture({ industry: 'manufacturing', name: 'Kestrel Floor Co' })
    await setModuleEnabled(base.ctx, 'manufacturing', true)
    await setModuleEnabled(base.ctx, 'inventory', true)

    const revenue = await base.account('4060')
    const rawMaterials = await accountByNumber(base.companyId, INDUSTRY_ACCOUNTS.rawMaterials)
    const finishedGoods = await accountByNumber(base.companyId, INDUSTRY_ACCOUNTS.finishedGoods)

    const rows = await db
      .insert(serviceItems)
      .values([
        {
          companyId: base.companyId,
          code: 'OAK',
          name: 'Oak plank',
          unit: 'metre',
          unitPriceCents: 0,
          unitCostCents: 1_200,
          isInventoried: true,
          chartAccountId: revenue.id,
          inventoryAccountId: rawMaterials!.id,
        },
        {
          companyId: base.companyId,
          code: 'STOOL',
          name: 'Oak stool',
          unit: 'each',
          unitPriceCents: 9_500,
          unitCostCents: 0,
          isInventoried: true,
          chartAccountId: revenue.id,
          inventoryAccountId: finishedGoods!.id,
        },
      ])
      .returning()

    fixture = { ...base, rawId: rows[0].id, stoolId: rows[1].id }

    await receiveStock(fixture.ctx, {
      itemId: fixture.rawId,
      quantityMilli: 100_000,
      unitCostCents: 1_200,
      receivedOn: '2026-01-05',
      creditAccountId: (await fixture.account('2050')).id,
    })
  })

  const aRun = async () =>
    createWorkOrder(fixture.ctx, { outputItemId: fixture.stoolId, plannedMilli: 10_000 })

  const issue = (workOrderId: string, quantityMilli: number, occurredOn: string) =>
    issueMaterial(fixture.ctx, { workOrderId, itemId: fixture.rawId, quantityMilli, occurredOn })

  it('holds only what had been issued by the date', async () => {
    const order = await aRun()
    await issue(order.id, 10_000, '2026-02-10')
    await issue(order.id, 20_000, '2026-05-10')

    const march = await wipPosition(fixture.ctx, { asOf: '2026-03-31' })
    const june = await wipPosition(fixture.ctx, { asOf: '2026-06-30' })

    // Before this phase March read the running `wip_cents` — 36000 — against a
    // ledger walked back to 12000.
    expect(march.registerCents).toBe(12_000)
    expect(march.ledgerCents).toBe(12_000)
    expect(march.agrees).toBe(true)

    expect(june.registerCents).toBe(36_000)
    expect(june.agrees).toBe(true)
  })

  it('still sees a run that finished after the date', async () => {
    // The case that made this `today_only`: released in February, finished in
    // May, and not `released` now — so a March report used to miss it entirely.
    const order = await aRun()
    await issue(order.id, 10_000, '2026-02-10')
    await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      completedOn: '2026-05-31',
      producedMilli: 10_000,
    })

    const march = await wipPosition(fixture.ctx, { asOf: '2026-03-31' })

    expect(march.registerCents).toBe(12_000)
    expect(march.ledgerCents).toBe(12_000)
    expect(march.agrees).toBe(true)
    expect(march.openOrders).toHaveLength(1)
  })

  it('holds nothing on the day the run finishes', async () => {
    // Exclusive: completion posts its entry dated `completedOn`, so the ledger
    // as at that day has already moved the cost into finished goods.
    const order = await aRun()
    await issue(order.id, 10_000, '2026-02-10')
    await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      completedOn: '2026-05-31',
      producedMilli: 10_000,
    })

    const onTheDay = await wipPosition(fixture.ctx, { asOf: '2026-05-31' })
    const dayBefore = await wipPosition(fixture.ctx, { asOf: '2026-05-30' })

    expect(onTheDay.registerCents).toBe(0)
    expect(onTheDay.agrees).toBe(true)
    expect(dayBefore.registerCents).toBe(12_000)
    expect(dayBefore.agrees).toBe(true)
  })

  it('treats a cancelled run the same way a finished one is treated', async () => {
    // `completed_on` is set on cancellation too, with a journal entry dated the
    // same day — so the closing date means the same thing either way.
    const order = await aRun()
    await issue(order.id, 10_000, '2026-02-10')
    await cancelWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      cancelledOn: '2026-04-30',
      reason: 'Customer pulled the order',
    })

    const march = await wipPosition(fixture.ctx, { asOf: '2026-03-31' })
    const may = await wipPosition(fixture.ctx, { asOf: '2026-05-31' })

    expect(march.registerCents).toBe(12_000)
    expect(march.agrees).toBe(true)
    expect(may.registerCents).toBe(0)
    expect(may.agrees).toBe(true)
  })

  it('shows nothing before the run started', async () => {
    const order = await aRun()
    await issue(order.id, 10_000, '2026-02-10')

    const before = await wipPosition(fixture.ctx, { asOf: '2026-01-31' })

    expect(before.registerCents).toBe(0)
    expect(before.ledgerCents).toBe(0)
    expect(before.agrees).toBe(true)
    expect(before.openOrders).toHaveLength(0)
  })

  it('leaves a draft run out of every date', async () => {
    // A draft has no start date because nothing has happened to it. Reading
    // that as the beginning of time would put it on every historical report.
    await aRun()

    for (const asOf of ['2020-01-01', '2026-03-31', '2030-01-01']) {
      const position = await wipPosition(fixture.ctx, { asOf })
      expect(position.openOrders, asOf).toHaveLength(0)
      expect(position.registerCents, asOf).toBe(0)
    }
  })

  it('answers the same undated as it does for today', async () => {
    const order = await aRun()
    await issue(order.id, 10_000, '2026-02-10')

    const undated = await wipPosition(fixture.ctx)
    const today = await wipPosition(fixture.ctx, { asOf: '2026-09-03' })

    expect(undated.registerCents).toBe(today.registerCents)
    expect(undated.openOrders.map((run) => run.number)).toEqual(
      today.openOrders.map((run) => run.number),
    )
  })

  it('reaches any date, and says what makes that possible', () => {
    const check = checkByKey('manufacturing.wip')!

    expect(check.asAt.reach).toBe('any_date')
    expect(check.asAt.because).toContain('work_order_entries')
    expect(check.asAt.because).toContain('completed_on')
  })
})
