import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, inventoryLots, serviceItems, stockMovements, workOrders } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { ModuleDisabledError, setModuleEnabled } from '@/modules/industry/modules'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { receiveStock, reconcileInventory } from '@/modules/inventory/service'
import {
  componentVariance,
  explodeBom,
  unitCostOf,
  yieldOf,
} from '@/modules/manufacturing/bom'
import {
  ManufacturingError,
  absorbCost,
  cancelWorkOrder,
  completeWorkOrder,
  createBom,
  createWorkOrder,
  issueMaterial,
  requirementsFor,
  workOrderEntryList,
} from '@/modules/manufacturing/service'
import {
  finishedGoodsOnHand,
  runCost,
  stageValues,
  wipPosition,
} from '@/modules/manufacturing/reporting'

/**
 * Manufacturing (spec §5, Phase 27).
 *
 * Four claims under test:
 *
 *  1. **Cost moves with the material, and nothing is created or destroyed.**
 *     Everything that enters WIP leaves it; a completed run holds exactly zero.
 *  2. **Material is costed from the lots it came out of**, never from a BOM or
 *     a price list — there is no second costing engine.
 *  3. **Scrap raises the unit cost**, because the run cost what it cost and
 *     made fewer good units.
 *  4. **The three stages are three balance-sheet lines**, and the WIP register
 *     agrees with account 1450.
 */

/** A factory with a raw material and a finished good on separate accounts. */
async function factory(): Promise<
  Fixture & { rawId: string; boardId: string; stoolId: string }
> {
  const fixture = await createCompanyFixture({ industry: 'manufacturing' })
  await setModuleEnabled(fixture.ctx, 'manufacturing', true)
  await setModuleEnabled(fixture.ctx, 'inventory', true)

  const revenue = await fixture.account('4060')
  const rawMaterials = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.rawMaterials)
  const finishedGoods = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.finishedGoods)

  const rows = await db
    .insert(serviceItems)
    .values([
      {
        companyId: fixture.companyId,
        code: 'OAK',
        name: 'Oak plank',
        unit: 'metre',
        unitPriceCents: 0,
        unitCostCents: 1_200,
        isInventoried: true,
        chartAccountId: revenue.id,
        // The seam Phase 14 left: a raw material sits on 1440, not on 1400.
        inventoryAccountId: rawMaterials!.id,
      },
      {
        companyId: fixture.companyId,
        code: 'LEG',
        name: 'Steel leg',
        unit: 'each',
        unitPriceCents: 0,
        unitCostCents: 300,
        isInventoried: true,
        chartAccountId: revenue.id,
        inventoryAccountId: rawMaterials!.id,
      },
      {
        companyId: fixture.companyId,
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

  return {
    ...fixture,
    rawId: rows[0].id,
    boardId: rows[1].id,
    stoolId: rows[2].id,
  }
}

/** Buys raw material in, so a run has something to consume. */
async function buyIn(
  fixture: Fixture,
  itemId: string,
  quantityMilli: number,
  unitCostCents: number,
  receivedOn = '2026-03-01',
) {
  const payable = await fixture.account('2000')
  return receiveStock(fixture.ctx, {
    itemId,
    quantityMilli,
    unitCostCents,
    receivedOn,
    creditAccountId: payable.id,
  })
}

describe('what a batch needs and what it cost (Phase 27)', () => {
  it('scales a recipe in one step, not per unit then multiplied', () => {
    const lines = [
      { componentItemId: 'oak', quantityMilli: 3_000, scrapBp: 0 },
      { componentItemId: 'leg', quantityMilli: 12_000, scrapBp: 0 },
    ]

    // A recipe for 4 stools, run for 10.
    expect(explodeBom(lines, 4_000, 10_000)).toEqual([
      { componentItemId: 'oak', netMilli: 7_500, grossMilli: 7_500 },
      { componentItemId: 'leg', netMilli: 30_000, grossMilli: 30_000 },
    ])
  })

  it('adds expected wastage on top of what the drawing says', () => {
    const lines = [{ componentItemId: 'oak', quantityMilli: 1_000, scrapBp: 250 }]

    const [line] = explodeBom(lines, 1_000, 100_000)
    expect(line.netMilli).toBe(100_000)
    // 2.5% more, because that much ends up on the floor.
    expect(line.grossMilli).toBe(102_500)
  })

  it('refuses a bill of materials that makes nothing', () => {
    expect(() => explodeBom([], 0, 1_000)).toThrow()
  })

  it('divides the whole cost over the good units', () => {
    const cost = unitCostOf({
      materialCents: 60_000,
      labourCents: 30_000,
      overheadCents: 10_000,
      goodMilli: 10_000,
    })

    expect(cost.totalCents).toBe(100_000)
    expect(cost.unitCostCents).toBe(10_000)
    expect(cost.roundingCents).toBe(0)
  })

  it('raises the unit cost when some of the run was scrapped', () => {
    const clean = unitCostOf({
      materialCents: 100_000,
      labourCents: 0,
      overheadCents: 0,
      goodMilli: 100_000,
    })
    const scrapped = unitCostOf({
      materialCents: 100_000,
      labourCents: 0,
      overheadCents: 0,
      goodMilli: 95_000,
    })

    expect(clean.unitCostCents).toBe(1_000)
    // The same money over 95 units instead of 100.
    expect(scrapped.unitCostCents).toBe(1_053)
    expect(scrapped.totalCents).toBe(clean.totalCents)
  })

  it('hands back the rounding rather than dropping it', () => {
    // £100.00 over 3 units is £33.333… each, and three of those is not £100.00.
    const cost = unitCostOf({
      materialCents: 10_000,
      labourCents: 0,
      overheadCents: 0,
      goodMilli: 3_000,
    })

    expect(cost.unitCostCents).toBe(3_333)
    expect(cost.extendedCents).toBe(9_999)
    expect(cost.roundingCents).toBe(1)
    // The remainder is never lost: the two always add back to the total.
    expect(cost.extendedCents + cost.roundingCents).toBe(cost.totalCents)
  })

  it('says nothing was made rather than dividing by zero', () => {
    const cost = unitCostOf({
      materialCents: 5_000,
      labourCents: 0,
      overheadCents: 0,
      goodMilli: 0,
    })

    expect(cost.unitCostCents).toBe(0)
    expect(cost.roundingCents).toBe(5_000)
  })

  it('measures yield against the plan and scrap against what came off the line', () => {
    // Asked for 100, made 98, of which 3 were bad.
    const report = yieldOf(100_000, 95_000, 3_000)

    expect(report.yieldBp).toBe(9_500)
    expect(report.scrapBp).toBe(306)

    // A run stopped early has a terrible yield and perfect scrap. One number
    // covering both could not tell these apart.
    const stopped = yieldOf(100_000, 50_000, 0)
    expect(stopped.yieldBp).toBe(5_000)
    expect(stopped.scrapBp).toBe(0)
  })

  it('reports a component nobody expected as well as one used heavily', () => {
    const expected = [
      { componentItemId: 'oak', netMilli: 10_000, grossMilli: 10_000 },
      { componentItemId: 'leg', netMilli: 40_000, grossMilli: 40_000 },
    ]

    const rows = componentVariance(expected, [
      { componentItemId: 'oak', quantityMilli: 11_500 },
      { componentItemId: 'glue', quantityMilli: 500 },
    ])

    expect(rows).toEqual([
      { componentItemId: 'oak', expectedMilli: 10_000, issuedMilli: 11_500, varianceMilli: 1_500 },
      { componentItemId: 'leg', expectedMilli: 40_000, issuedMilli: 0, varianceMilli: -40_000 },
      // A substitution nobody recorded — the thing an overspend investigation
      // is looking for, and one a report of expected components could not show.
      { componentItemId: 'glue', expectedMilli: 0, issuedMilli: 500, varianceMilli: 500 },
    ])
  })
})

describe('cost moves with the material (Phase 27)', () => {
  it('takes material out of raw materials and puts it in WIP', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_200)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })

    const issued = await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 30_000,
      occurredOn: '2026-03-05',
    })

    expect(issued.costCents).toBe(36_000)
    expect(issued.wipCents).toBe(36_000)

    const raw = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.rawMaterials)
    const wip = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.workInProcess)

    // 100 metres in at £12, 30 out: £840 left in raw materials, £360 in WIP.
    expect(await balanceForAccount(fixture.ctx, raw!.id)).toBe(84_000)
    expect(await balanceForAccount(fixture.ctx, wip!.id)).toBe(36_000)
  })

  it('costs material from the lots, not from a price list', async () => {
    const fixture = await factory()
    // Two lots at different prices. The company default is weighted average,
    // so they pool: £300 over 20 metres is £15 each.
    await buyIn(fixture, fixture.rawId, 10_000, 1_000, '2026-01-10')
    await buyIn(fixture, fixture.rawId, 10_000, 2_000, '2026-02-10')

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 5_000,
    })

    const issued = await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 15_000,
      occurredOn: '2026-03-05',
    })

    // 15 metres at the pooled £15 — £225. The item's `unitCostCents` of £12 is
    // a planning figure and is deliberately not what was posted, and neither is
    // any figure from a bill of materials.
    expect(issued.costCents).toBe(22_500)
  })

  it('records the issue as its own kind of movement, not as shrinkage', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 10_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 5_000,
      occurredOn: '2026-03-05',
    })

    const movements = await db
      .select({ kind: stockMovements.kind })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, fixture.companyId),
          eq(stockMovements.itemId, fixture.rawId),
        ),
      )

    expect(movements.map((row) => row.kind).sort()).toEqual(['receipt', 'work_order_issue'])
  })

  it('absorbs labour by crediting the expense, not by debiting it again', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 10_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 5_000,
      occurredOn: '2026-03-05',
    })

    const result = await absorbCost(fixture.ctx, {
      workOrderId: order.id,
      kind: 'labour',
      costCents: 15_000,
      occurredOn: '2026-03-06',
    })

    expect(result.wipCents).toBe(20_000)

    // Direct Labor goes negative: the wages were already an expense when they
    // were paid, and this is the moment that cost becomes part of something on
    // a shelf. What is left in 5070 at a period end is unabsorbed — idle time.
    const labour = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.directLabor)
    expect(await balanceForAccount(fixture.ctx, labour!.id)).toBe(-15_000)
  })

  it('clears work in process to exactly zero on completion', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_200)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 30_000,
      occurredOn: '2026-03-05',
    })
    await absorbCost(fixture.ctx, {
      workOrderId: order.id,
      kind: 'labour',
      costCents: 20_000,
      occurredOn: '2026-03-06',
    })
    await absorbCost(fixture.ctx, {
      workOrderId: order.id,
      kind: 'overhead',
      costCents: 4_000,
      occurredOn: '2026-03-06',
    })

    const completion = await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 10_000,
      completedOn: '2026-03-10',
    })

    expect(completion.totalCents).toBe(60_000)
    expect(completion.unitCostCents).toBe(6_000)

    const wip = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.workInProcess)
    const finished = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.finishedGoods)

    // The whole claim: everything that went in came out.
    expect(await balanceForAccount(fixture.ctx, wip!.id)).toBe(0)
    expect(await balanceForAccount(fixture.ctx, finished!.id)).toBe(60_000)

    const [row] = await db
      .select({ wipCents: workOrders.wipCents, status: workOrders.status })
      .from(workOrders)
      .where(eq(workOrders.id, order.id))
    expect(row.wipCents).toBe(0)
    expect(row.status).toBe('completed')
  })

  it('leaves not one penny behind when the cost does not divide', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 10_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 3_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 10_000,
      occurredOn: '2026-03-05',
    })

    // £100.00 over 3 units. The extension at £33.33 is £99.99.
    const completion = await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 3_000,
      completedOn: '2026-03-10',
    })

    expect(completion.totalCents).toBe(10_000)
    expect(completion.unitCostCents).toBe(3_333)
    expect(completion.roundingCents).toBe(1)

    const wip = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.workInProcess)
    const finished = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.finishedGoods)

    // A penny left in WIP would never clear. It is posted, not dropped.
    expect(await balanceForAccount(fixture.ctx, wip!.id)).toBe(0)
    expect(await balanceForAccount(fixture.ctx, finished!.id)).toBe(10_000)
  })

  it('makes the finished goods a lot like any other, sellable at that cost', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_200)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 30_000,
      occurredOn: '2026-03-05',
    })
    const completion = await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 10_000,
      completedOn: '2026-03-10',
    })

    const [lot] = await db
      .select()
      .from(inventoryLots)
      .where(eq(inventoryLots.id, completion.lotId))

    expect(lot.itemId).toBe(fixture.stoolId)
    expect(lot.remainingMilli).toBe(10_000)
    expect(lot.remainingValueCents).toBe(36_000)
  })

  it('raises the unit cost of a run that scrapped some of its output', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 100_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 100_000,
      occurredOn: '2026-03-05',
    })

    const completion = await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 95_000,
      scrappedMilli: 5_000,
      completedOn: '2026-03-10',
    })

    // £1,000 of material over 95 good units rather than 100.
    expect(completion.totalCents).toBe(100_000)
    expect(completion.unitCostCents).toBe(1_053)

    const wip = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.workInProcess)
    expect(await balanceForAccount(fixture.ctx, wip!.id)).toBe(0)
  })

  it('writes a cancelled run off to overhead rather than back to the store', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 10_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 5_000,
      occurredOn: '2026-03-05',
    })

    const result = await cancelWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      cancelledOn: '2026-03-08',
      reason: 'Machine failure',
    })

    expect(result.writtenOffCents).toBe(5_000)

    const wip = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.workInProcess)
    const overhead = await accountByNumber(
      fixture.companyId,
      INDUSTRY_ACCOUNTS.manufacturingOverhead,
    )
    const raw = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.rawMaterials)

    expect(await balanceForAccount(fixture.ctx, wip!.id)).toBe(0)
    expect(await balanceForAccount(fixture.ctx, overhead!.id)).toBe(5_000)
    // The material was cut. It does not come back as pickable stock.
    expect(await balanceForAccount(fixture.ctx, raw!.id)).toBe(5_000)
  })

  it('refuses to finish a run that has absorbed nothing', async () => {
    const fixture = await factory()

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })

    await expect(
      completeWorkOrder(fixture.ctx, {
        workOrderId: order.id,
        producedMilli: 1_000,
        completedOn: '2026-03-10',
      }),
    ).rejects.toThrow(ManufacturingError)
  })

  it('refuses to issue anything more to a finished run', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 20_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 5_000,
      occurredOn: '2026-03-05',
    })
    await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 1_000,
      completedOn: '2026-03-10',
    })

    await expect(
      issueMaterial(fixture.ctx, {
        workOrderId: order.id,
        itemId: fixture.rawId,
        quantityMilli: 1_000,
        occurredOn: '2026-03-11',
      }),
    ).rejects.toThrow(ManufacturingError)
  })

  it('issues nothing and says so when the store is empty', async () => {
    const fixture = await factory()

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })

    const issued = await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 5_000,
      occurredOn: '2026-03-05',
    })

    expect(issued.costCents).toBe(0)
    expect(issued.shortfallMilli).toBe(5_000)
    expect(issued.wipCents).toBe(0)
  })
})

describe('recipes, and the gates around them (Phase 27)', () => {
  it('explodes a stored bill of materials to a run size', async () => {
    const fixture = await factory()

    const bom = await createBom(fixture.ctx, {
      outputItemId: fixture.stoolId,
      name: 'Oak stool, batch of 4',
      batchMilli: 4_000,
      components: [
        { componentItemId: fixture.rawId, quantityMilli: 3_000 },
        { componentItemId: fixture.boardId, quantityMilli: 12_000, scrapBp: 500 },
      ],
    })

    const requirements = await requirementsFor(fixture.ctx, {
      bomId: bom.id,
      quantityMilli: 20_000,
    })

    expect(requirements).toEqual([
      { componentItemId: fixture.rawId, netMilli: 15_000, grossMilli: 15_000 },
      { componentItemId: fixture.boardId, netMilli: 60_000, grossMilli: 63_000 },
    ])
  })

  it('refuses a recipe that makes something out of itself', async () => {
    const fixture = await factory()

    await expect(
      createBom(fixture.ctx, {
        outputItemId: fixture.stoolId,
        name: 'Impossible',
        batchMilli: 1_000,
        components: [{ componentItemId: fixture.stoolId, quantityMilli: 1_000 }],
      }),
    ).rejects.toThrow(ManufacturingError)
  })

  it('refuses a recipe with no components', async () => {
    const fixture = await factory()

    await expect(
      createBom(fixture.ctx, {
        outputItemId: fixture.stoolId,
        name: 'From nothing',
        batchMilli: 1_000,
        components: [],
      }),
    ).rejects.toThrow(ManufacturingError)
  })

  it('installs the accounts it posts to, even off the manufacturing pack', async () => {
    const fixture = await createCompanyFixture({ name: 'Bench Workshop', industry: 'general' })
    await setModuleEnabled(fixture.ctx, 'manufacturing', true)

    const revenue = await fixture.account('4000')
    const [item] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        code: 'KIT',
        name: 'Assembled kit',
        unit: 'each',
        unitPriceCents: 1_000,
        unitCostCents: 0,
        isInventoried: true,
        chartAccountId: revenue.id,
      })
      .returning()

    await createWorkOrder(fixture.ctx, { outputItemId: item.id, plannedMilli: 1_000 })

    for (const number of [
      INDUSTRY_ACCOUNTS.rawMaterials,
      INDUSTRY_ACCOUNTS.workInProcess,
      INDUSTRY_ACCOUNTS.finishedGoods,
      INDUSTRY_ACCOUNTS.directLabor,
      INDUSTRY_ACCOUNTS.manufacturingOverhead,
    ]) {
      expect(await accountByNumber(fixture.companyId, number)).toBeTruthy()
    }
  })

  it('refuses to run anything when the module is off', async () => {
    const fixture = await createCompanyFixture({ name: 'No Factory', industry: 'general' })
    const revenue = await fixture.account('4000')
    const [item] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        code: 'X',
        name: 'X',
        unit: 'each',
        unitPriceCents: 0,
        unitCostCents: 0,
        isInventoried: true,
        chartAccountId: revenue.id,
      })
      .returning()

    await expect(
      createWorkOrder(fixture.ctx, { outputItemId: item.id, plannedMilli: 1_000 }),
    ).rejects.toThrow(ModuleDisabledError)
  })

  it('refuses to issue material without the journal permission', async () => {
    const fixture = await factory()
    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })

    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    await expect(
      issueMaterial(readonly, {
        workOrderId: order.id,
        itemId: fixture.rawId,
        quantityMilli: 1_000,
        occurredOn: '2026-03-05',
      }),
    ).rejects.toThrow(PermissionError)
  })

  it('keeps one factory’s runs off another’s floor', async () => {
    const ours = await factory()
    const theirs = await factory()

    await createWorkOrder(ours.ctx, { outputItemId: ours.stoolId, plannedMilli: 1_000 })

    const { listWorkOrders } = await import('@/modules/manufacturing/service')
    expect(await listWorkOrders(theirs.ctx)).toHaveLength(0)
    expect(await listWorkOrders(ours.ctx)).toHaveLength(1)
  })
})

describe('where the value sits (Phase 27)', () => {
  it('agrees with account 1450 while a run is open, and after it closes', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 40_000,
      occurredOn: '2026-03-05',
    })

    const open = await wipPosition(fixture.ctx, { asOf: '2026-12-31' })
    expect(open.registerCents).toBe(40_000)
    expect(open.ledgerCents).toBe(40_000)
    expect(open.agrees).toBe(true)
    expect(open.openOrders).toHaveLength(1)

    await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 10_000,
      completedOn: '2026-03-10',
    })

    const closed = await wipPosition(fixture.ctx, { asOf: '2026-12-31' })
    expect(closed.registerCents).toBe(0)
    expect(closed.ledgerCents).toBe(0)
    expect(closed.agrees).toBe(true)
    expect(closed.openOrders).toHaveLength(0)
  })

  it('splits stock across the three stages a manufacturer reports', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 30_000,
      occurredOn: '2026-03-05',
    })

    const midRun = await stageValues(fixture.ctx, { asOf: '2026-12-31' })
    const byNumber = new Map(midRun.map((row) => [row.accountNumber, row.cents]))

    expect(byNumber.get(INDUSTRY_ACCOUNTS.rawMaterials)).toBe(70_000)
    expect(byNumber.get(INDUSTRY_ACCOUNTS.workInProcess)).toBe(30_000)
    expect(byNumber.get(INDUSTRY_ACCOUNTS.finishedGoods)).toBe(0)

    await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 10_000,
      completedOn: '2026-03-10',
    })

    const after = new Map(
      (await stageValues(fixture.ctx, { asOf: '2026-12-31' })).map((row) => [
        row.accountNumber,
        row.cents,
      ]),
    )

    expect(after.get(INDUSTRY_ACCOUNTS.rawMaterials)).toBe(70_000)
    expect(after.get(INDUSTRY_ACCOUNTS.workInProcess)).toBe(0)
    expect(after.get(INDUSTRY_ACCOUNTS.finishedGoods)).toBe(30_000)
  })

  it('reports three stages and not the whole chart of accounts', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 10_000, 1_000)

    const stages = await stageValues(fixture.ctx, { asOf: '2026-12-31' })

    // The bug this pins: a raw `OR` inside `and()` is not parenthesised, and
    // SQL binds AND tighter than OR — so the account filter collapsed and every
    // account with no activity came back. Asserting the three figures was not
    // enough, because the three were right and eighty more came with them.
    expect(stages).toHaveLength(3)
    expect(stages.map((row) => row.accountNumber)).toEqual([
      INDUSTRY_ACCOUNTS.rawMaterials,
      INDUSTRY_ACCOUNTS.workInProcess,
      INDUSTRY_ACCOUNTS.finishedGoods,
    ])
  })

  it('keeps a stage at zero rather than dropping it when nothing has moved', async () => {
    const fixture = await factory()

    // No activity at all. All three stages must still be listed.
    const stages = await stageValues(fixture.ctx, { asOf: '2026-12-31' })
    expect(stages).toHaveLength(3)
    expect(stages.every((row) => row.cents === 0)).toBe(true)
  })

  it('keeps the inventory subledger equal to what the ledger says, throughout', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 30_000,
      occurredOn: '2026-03-05',
    })
    await completeWorkOrder(fixture.ctx, {
      workOrderId: order.id,
      producedMilli: 7_000,
      scrappedMilli: 3_000,
      completedOn: '2026-03-10',
    })

    // Phase 14's claim, still true with a factory in the middle. The lots and
    // the three inventory accounts have to add up to the same money.
    const lots = await db
      .select({ value: inventoryLots.remainingValueCents })
      .from(inventoryLots)
      .where(eq(inventoryLots.companyId, fixture.companyId))

    const subledger = lots.reduce((sum, row) => sum + row.value, 0)
    const stages = await stageValues(fixture.ctx, { asOf: '2026-12-31' })
    const ledger = stages.reduce((sum, row) => sum + row.cents, 0)

    expect(subledger).toBe(ledger)
  })

  it('does not multiply the shelf by the number of runs that made it', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    // Three separate runs of the same item. A join to work_orders in the
    // aggregate would report three times the stock.
    for (const month of ['03', '04', '05']) {
      const order = await createWorkOrder(fixture.ctx, {
        outputItemId: fixture.stoolId,
        plannedMilli: 1_000,
      })
      await issueMaterial(fixture.ctx, {
        workOrderId: order.id,
        itemId: fixture.rawId,
        quantityMilli: 10_000,
        occurredOn: `2026-${month}-05`,
      })
      await completeWorkOrder(fixture.ctx, {
        workOrderId: order.id,
        producedMilli: 1_000,
        completedOn: `2026-${month}-10`,
      })
    }

    const [shelf] = await finishedGoodsOnHand(fixture.ctx)
    expect(shelf.quantityMilli).toBe(3_000)
    expect(shelf.valueCents).toBe(30_000)
  })

  it('reports a run against what its recipe expected', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const bom = await createBom(fixture.ctx, {
      outputItemId: fixture.stoolId,
      name: 'Oak stool, batch of 4',
      batchMilli: 4_000,
      components: [{ componentItemId: fixture.rawId, quantityMilli: 3_000 }],
    })

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      bomId: bom.id,
      plannedMilli: 20_000,
    })

    // The recipe wanted 15; the shop floor took 18.
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 18_000,
      occurredOn: '2026-03-05',
    })

    const report = await runCost(fixture.ctx, order.id)

    expect(report.variances).not.toBeNull()
    expect(report.variances![0].expectedMilli).toBe(15_000)
    expect(report.variances![0].issuedMilli).toBe(18_000)
    expect(report.variances![0].varianceMilli).toBe(3_000)
  })

  it('has no variance to report when a run was raised without a recipe', async () => {
    const fixture = await factory()
    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 1_000,
    })

    const report = await runCost(fixture.ctx, order.id)
    expect(report.variances).toBeNull()
  })

  it('lists what a run absorbed, in the order it happened', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 10_000,
      occurredOn: '2026-03-05',
    })
    await absorbCost(fixture.ctx, {
      workOrderId: order.id,
      kind: 'labour',
      costCents: 5_000,
      occurredOn: '2026-03-06',
    })
    await absorbCost(fixture.ctx, {
      workOrderId: order.id,
      kind: 'overhead',
      costCents: 2_000,
      occurredOn: '2026-03-07',
    })

    const entries = await workOrderEntryList(fixture.ctx, order.id)
    expect(entries.map((row) => row.kind)).toEqual(['material', 'labour', 'overhead'])
    expect(entries.map((row) => row.costCents)).toEqual([10_000, 5_000, 2_000])
  })

  it('leaves the ordinary inventory reconciliation intact', async () => {
    const fixture = await factory()
    await buyIn(fixture, fixture.rawId, 100_000, 1_000)

    const order = await createWorkOrder(fixture.ctx, {
      outputItemId: fixture.stoolId,
      plannedMilli: 10_000,
    })
    await issueMaterial(fixture.ctx, {
      workOrderId: order.id,
      itemId: fixture.rawId,
      quantityMilli: 30_000,
      occurredOn: '2026-03-05',
    })

    // Phase 14's reconciliation is against account 1400, and this factory keeps
    // nothing there — every item names 1440 or 1460. Both sides are zero, and
    // they agree, which is the honest answer rather than a failure.
    const reconciliation = await reconcileInventory(fixture.ctx)
    expect(reconciliation.agrees).toBe(true)
  })
})
