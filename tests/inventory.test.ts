import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, serviceItems } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  applyConsumption,
  averageUnitCostCents,
  consume,
  extend,
  quantityOnHand,
  reversalLot,
  valueOnHand,
  type Lot,
} from '@/modules/inventory/costing'
import {
  adjustStock,
  costMethodFor,
  openLots,
  previewSaleCost,
  receiveStock,
  reconcileInventory,
  reorderList,
  returnStockFromSale,
  stockOnHand,
} from '@/modules/inventory/service'
import {
  createPurchaseOrder,
  matchPurchaseOrder,
  purchaseOrderWithLines,
  receiveGoods,
  unbilledReceipts,
} from '@/modules/inventory/purchasing'
import { createCustomer, createInvoice, createVendor } from '@/modules/receivables/service'
import { trialBalance } from '@/modules/ledger/balances'
import { setModuleEnabled } from '@/modules/industry/modules'
import { profitAndLoss } from '@/modules/ledger/reports'

/**
 * Inventory (spec §5, §13).
 *
 * The claim under test: **the inventory subledger equals the Inventory account
 * in the ledger, always.** The costing block below is the arithmetic that has
 * to be right for it to hold; everything after it is a way the two could come
 * apart.
 */

const lot = (id: string, remainingMilli: number, unitCostCents: number, receivedAt: string): Lot => ({
  id,
  remainingMilli,
  // The value a lot arrives with is its quantity at its rate; from then on the
  // value is what is authoritative and the rate is only for reading.
  remainingValueCents: Math.round((remainingMilli * unitCostCents) / 1000),
  unitCostCents,
  receivedAt,
})

async function retailFixture(): Promise<Fixture & { itemId: string }> {
  const fixture = await createCompanyFixture({ industry: 'retail' })
  await setModuleEnabled(fixture.ctx, 'inventory', true)

  const revenue = await fixture.account('4000')

  const [item] = await db
    .insert(serviceItems)
    .values({
      companyId: fixture.companyId,
      code: 'WIDGET',
      name: 'Widget',
      unit: 'each',
      unitPriceCents: 5_000,
      unitCostCents: 2_000,
      isInventoried: true,
      chartAccountId: revenue.id,
    })
    .returning()

  return { ...fixture, itemId: item.id }
}

describe('what a sale costs', () => {
  const lots = [lot('a', 1000, 100, '2026-01-01'), lot('b', 1000, 200, '2026-02-01')]

  it('adds up what is on hand', () => {
    expect(quantityOnHand(lots)).toBe(2000)
    expect(valueOnHand(lots)).toBe(300)
    expect(averageUnitCostCents(lots)).toBe(150)
    expect(averageUnitCostCents([])).toBeNull()
  })

  it('takes the oldest first under FIFO', () => {
    const result = consume(lots, 1500, 'fifo')

    // The whole of the first lot at 100, half of the second at 200.
    expect(result.consumed).toEqual([
      { lotId: 'a', quantityMilli: 1000, costCents: 100 },
      { lotId: 'b', quantityMilli: 500, costCents: 100 },
    ])
    expect(result.totalCostCents).toBe(200)
  })

  it('pools the cost under weighted average', () => {
    const result = consume(lots, 1500, 'weighted_average')

    // 1.5 units at the pooled 150 = 225, which is deliberately not FIFO's 200.
    expect(result.totalCostCents).toBe(225)
    expect(result.consumed.reduce((sum, entry) => sum + entry.quantityMilli, 0)).toBe(1500)
  })

  it('makes the parts sum to the whole, exactly', () => {
    // Three lots at a price that does not divide evenly is where a naive
    // implementation loses a cent — and that cent is the difference between
    // the subledger and the ledger, once a week, forever.
    const awkward = [
      lot('a', 333, 997, '2026-01-01'),
      lot('b', 333, 331, '2026-01-02'),
      lot('c', 334, 673, '2026-01-03'),
    ]

    for (const method of ['fifo', 'weighted_average'] as const) {
      for (let take = 1; take <= 1000; take += 7) {
        const result = consume(awkward, take, method)
        const summed = result.consumed.reduce((sum, entry) => sum + entry.costCents, 0)
        expect(summed).toBe(result.totalCostCents)
      }
    }
  })

  it('consuming everything costs exactly what the pool was worth', () => {
    for (const method of ['fifo', 'weighted_average'] as const) {
      const result = consume(lots, 2000, method)
      // No rounding may appear when nothing is being split.
      expect(result.totalCostCents).toBe(valueOnHand(lots))
      expect(result.shortfallMilli).toBe(0)
    }
  })

  it('reports a shortfall rather than refusing', () => {
    const result = consume(lots, 3000, 'fifo')

    // A shop that sells the last one twice on a busy Saturday has a real
    // problem to record, and a costing function that throws cannot help.
    expect(result.shortfallMilli).toBe(1000)
    expect(result.consumed.reduce((sum, entry) => sum + entry.quantityMilli, 0)).toBe(2000)
  })

  it('breaks receipt-date ties deterministically', () => {
    const sameDay = [lot('b', 500, 200, '2026-01-01'), lot('a', 500, 100, '2026-01-01')]
    // Without the id tie-break, two runs of the same report disagree.
    expect(consume(sameDay, 500, 'fifo').consumed[0].lotId).toBe('a')
  })

  it('puts a return back at the cost it left at', () => {
    const consumed = [
      { lotId: 'a', quantityMilli: 1000, costCents: 100 },
      { lotId: 'b', quantityMilli: 500, costCents: 100 },
    ]
    const restored = reversalLot(consumed, '2026-03-01', 'new')

    // 200 cents exactly — what left. The per-unit rate rounds to 133 and is
    // for display only; valuing the return at today's average instead would
    // invent or destroy value with no transaction behind it.
    expect(restored).toEqual({
      id: 'new',
      remainingMilli: 1500,
      remainingValueCents: 200,
      unitCostCents: 133,
      receivedAt: '2026-03-01',
    })
  })

  it('applies a consumption without mutating the input', () => {
    const before = [...lots]
    const result = consume(lots, 1200, 'fifo')
    const after = applyConsumption(lots, result.consumed)

    expect(lots).toEqual(before)
    expect(quantityOnHand(after)).toBe(800)
  })

  it('rounds an extension in one place', () => {
    expect(extend(1500, 100)).toBe(150)
    expect(extend(333, 997)).toBe(332)
    expect(extend(0, 500)).toBe(0)
  })
})

describe('the subledger and the ledger', () => {
  it('agree after a busy month', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')
    const revenue = await fixture.account('4000')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    // Two receipts at different costs.
    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 100_000,
      unitCostCents: 2_000,
      receivedOn: '2026-03-01',
      creditAccountId: grni.id,
    })
    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 50_000,
      unitCostCents: 2_400,
      receivedOn: '2026-03-10',
      creditAccountId: grni.id,
    })

    // Three sales.
    for (const [issueDate, quantityMilli] of [
      ['2026-03-05', 30_000],
      ['2026-03-12', 45_000],
      ['2026-03-20', 12_500],
    ] as const) {
      await createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate,
        dueDate: '2026-04-30',
        lines: [
          {
            chartAccountId: revenue.id,
            itemId: fixture.itemId,
            description: 'Widget',
            quantityMilli,
            unitPriceCents: 5_000,
          },
        ],
      })
    }

    // A count that came up short.
    await adjustStock(fixture.ctx, {
      itemId: fixture.itemId,
      countedMilli: 60_000,
      adjustedOn: '2026-03-31',
      reason: 'Quarterly count — two cases damaged in the stockroom',
    })

    const reconciliation = await reconcileInventory(fixture.ctx)

    // The claim. Both sides are computed by different code from different
    // tables, so agreement is evidence rather than tautology.
    expect(reconciliation.agrees).toBe(true)
    expect(reconciliation.differenceCents).toBe(0)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-03-31' })
    expect(balances.isBalanced).toBe(true)
  })

  it('holds under FIFO too', async () => {
    const fixture = await retailFixture()
    await db
      .update(companies)
      .set({ inventoryCostMethod: 'fifo' })
      .where(eq(companies.id, fixture.companyId))

    expect(await costMethodFor(fixture.companyId)).toBe('fifo')

    const grni = await fixture.account('2050')
    const revenue = await fixture.account('4000')
    const customer = await createCustomer(fixture.ctx, { name: 'Delta Mills' })

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 7_000,
      unitCostCents: 1_997,
      receivedOn: '2026-04-01',
      creditAccountId: grni.id,
    })
    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 3_000,
      unitCostCents: 3_331,
      receivedOn: '2026-04-05',
      creditAccountId: grni.id,
    })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-10',
      dueDate: '2026-05-10',
      lines: [
        {
          chartAccountId: revenue.id,
          itemId: fixture.itemId,
          description: 'Widget',
          quantityMilli: 8_500,
          unitPriceCents: 6_000,
        },
      ],
    })

    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })
})

describe('selling stock', () => {
  it('posts the cost in the invoice’s own transaction', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')
    const revenue = await fixture.account('4000')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 10_000,
      unitCostCents: 2_000,
      receivedOn: '2026-05-01',
      creditAccountId: grni.id,
    })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-05-05',
      dueDate: '2026-06-05',
      lines: [
        {
          chartAccountId: revenue.id,
          itemId: fixture.itemId,
          description: 'Widget',
          quantityMilli: 4_000,
          unitPriceCents: 5_000,
        },
      ],
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })

    // Four units sold at 50.00 against a cost of 20.00 — a margin that only
    // exists because the cost posted alongside the revenue.
    expect(pl.revenue.totalCents).toBe(200_00)
    expect(pl.costOfSales.totalCents).toBe(80_00)
    expect(pl.grossProfitCents).toBe(120_00)

    const positions = await stockOnHand(fixture.ctx)
    expect(positions[0].quantityMilli).toBe(6_000)
    expect(positions[0].valueCents).toBe(120_00)
  })

  it('leaves a service line alone', async () => {
    const fixture = await retailFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const [service] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Installation',
        unit: 'hour',
        unitPriceCents: 12_000,
        // Not stocked — the default, and what every item was before Phase 14.
        isInventoried: false,
      })
      .returning()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-05-05',
      dueDate: '2026-06-05',
      lines: [
        {
          chartAccountId: revenue.id,
          itemId: service.id,
          description: 'Installation',
          quantityMilli: 2_000,
          unitPriceCents: 12_000,
        },
      ],
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    })

    expect(pl.revenue.totalCents).toBe(240_00)
    expect(pl.costOfSales.totalCents).toBe(0)
    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })

  it('records the sale even when the shelf is empty, and says so', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')
    const revenue = await fixture.account('4000')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 1_000,
      unitCostCents: 2_000,
      receivedOn: '2026-05-01',
      creditAccountId: grni.id,
    })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-05-05',
      dueDate: '2026-06-05',
      lines: [
        {
          chartAccountId: revenue.id,
          itemId: fixture.itemId,
          description: 'Widget',
          quantityMilli: 3_000,
          unitPriceCents: 5_000,
        },
      ],
    })

    // The sale happened. Refusing to record it would teach somebody to record
    // something else instead.
    expect(invoice.stockShortfalls).toHaveLength(1)
    expect(invoice.stockShortfalls[0].shortfallMilli).toBe(2_000)
    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })

  it('puts a return back at the cost it left at', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')
    const revenue = await fixture.account('4000')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 10_000,
      unitCostCents: 2_000,
      receivedOn: '2026-05-01',
      creditAccountId: grni.id,
    })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-05-05',
      dueDate: '2026-06-05',
      lines: [
        {
          chartAccountId: revenue.id,
          itemId: fixture.itemId,
          description: 'Widget',
          quantityMilli: 4_000,
          unitPriceCents: 5_000,
        },
      ],
    })

    // Prices rise before the return comes back.
    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 10_000,
      unitCostCents: 6_000,
      receivedOn: '2026-05-10',
      creditAccountId: grni.id,
    })

    const restored = await db.transaction((tx) =>
      returnStockFromSale(fixture.ctx, invoice.id, '2026-05-15', tx),
    )

    // 80.00 — what the four units cost when they left, not the 240.00 they
    // would cost at today's price.
    expect(restored).toBe(80_00)
    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })
})

describe('counting stock', () => {
  it('books a shortage to shrinkage, not to cost of sales', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 10_000,
      unitCostCents: 2_000,
      receivedOn: '2026-06-01',
      creditAccountId: grni.id,
    })

    const result = await adjustStock(fixture.ctx, {
      itemId: fixture.itemId,
      countedMilli: 9_000,
      adjustedOn: '2026-06-30',
      reason: 'Breakage',
    })

    expect(result.varianceMilli).toBe(-1_000)
    expect(result.valueChangeCents).toBe(-20_00)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-06-30' })
    // Its own account. A gross margin quietly containing theft explains
    // nothing to whoever reads it.
    expect(balances.rows.find((row) => row.number === '5400')?.balanceCents).toBe(20_00)
    expect(balances.rows.find((row) => row.number === '5000')?.balanceCents ?? 0).toBe(0)
    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })

  it('refuses a count with no reason', async () => {
    const fixture = await retailFixture()

    await expect(
      adjustStock(fixture.ctx, {
        itemId: fixture.itemId,
        countedMilli: 5,
        adjustedOn: '2026-06-30',
        reason: '   ',
      }),
    ).rejects.toThrow(/Say why/)
  })

  it('records a count that found exactly what was expected', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 5_000,
      unitCostCents: 1_000,
      receivedOn: '2026-06-01',
      creditAccountId: grni.id,
    })

    const result = await adjustStock(fixture.ctx, {
      itemId: fixture.itemId,
      countedMilli: 5_000,
      adjustedOn: '2026-06-30',
      reason: 'Quarterly count',
    })

    // "We counted and it was right" is a fact worth keeping, and it posts
    // nothing because nothing changed.
    expect(result).toEqual({ varianceMilli: 0, valueChangeCents: 0 })
  })

  it('values a surplus at the current average', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 4_000,
      unitCostCents: 1_000,
      receivedOn: '2026-06-01',
      creditAccountId: grni.id,
    })

    const result = await adjustStock(fixture.ctx, {
      itemId: fixture.itemId,
      countedMilli: 5_000,
      adjustedOn: '2026-06-30',
      reason: 'Found a case behind the shelf',
    })

    expect(result.varianceMilli).toBe(1_000)
    expect(result.valueChangeCents).toBe(10_00)
    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })
})

describe('buying stock', () => {
  it('orders without posting anything', async () => {
    const fixture = await retailFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    const order = await createPurchaseOrder(fixture.ctx, {
      vendorId: vendor.id,
      orderedOn: '2026-07-01',
      lines: [{ itemId: fixture.itemId, quantityMilli: 100_000, unitCostCents: 2_000 }],
    })

    expect(order.number).toBe('PO-1001')
    expect(order.totalCents).toBe(200_000)

    // An order is a commitment, not a transaction. Posting it would overstate
    // inventory and payables for as long as the supplier takes to ship.
    const balances = await trialBalance(fixture.ctx, { endDate: '2026-07-31' })
    expect(balances.rows.find((row) => row.number === '1400')?.balanceCents ?? 0).toBe(0)
    expect(balances.rows.find((row) => row.number === '2000')?.balanceCents ?? 0).toBe(0)
  })

  it('receives into Goods Received Not Invoiced, not into payables', async () => {
    const fixture = await retailFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    const order = await createPurchaseOrder(fixture.ctx, {
      vendorId: vendor.id,
      orderedOn: '2026-07-01',
      lines: [{ itemId: fixture.itemId, quantityMilli: 100_000, unitCostCents: 2_000 }],
    })

    const { lines } = await purchaseOrderWithLines(fixture.ctx, order.id)

    await receiveGoods(fixture.ctx, {
      vendorId: vendor.id,
      receivedOn: '2026-07-10',
      purchaseOrderId: order.id,
      lines: [
        { purchaseOrderLineId: lines[0].id, itemId: fixture.itemId, quantityMilli: 96_000 },
      ],
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-07-31' })

    // The stock is on the shelf and on the balance sheet, and no supplier has
    // invoiced yet — which is exactly what 2050 is for.
    expect(balances.rows.find((row) => row.number === '1400')?.balanceCents).toBe(192_000)
    expect(balances.rows.find((row) => row.number === '2050')?.balanceCents).toBe(192_000)
    expect(balances.rows.find((row) => row.number === '2000')?.balanceCents ?? 0).toBe(0)

    expect((await reconcileInventory(fixture.ctx)).agrees).toBe(true)
  })

  it('shows a short shipment in the match', async () => {
    const fixture = await retailFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    const order = await createPurchaseOrder(fixture.ctx, {
      vendorId: vendor.id,
      orderedOn: '2026-07-01',
      lines: [{ itemId: fixture.itemId, quantityMilli: 100_000, unitCostCents: 2_000 }],
    })
    const { lines } = await purchaseOrderWithLines(fixture.ctx, order.id)

    await receiveGoods(fixture.ctx, {
      vendorId: vendor.id,
      receivedOn: '2026-07-10',
      purchaseOrderId: order.id,
      lines: [
        { purchaseOrderLineId: lines[0].id, itemId: fixture.itemId, quantityMilli: 96_000 },
      ],
    })

    const match = await matchPurchaseOrder(fixture.ctx, order.id)

    // Ordered 100, received 96. Each figure is defensible alone; together they
    // are the control.
    expect(match[0].quantityVarianceMilli).toBe(-4_000)
    expect(match[0].hasVariance).toBe(true)

    const reloaded = await purchaseOrderWithLines(fixture.ctx, order.id)
    expect(reloaded.order.status).toBe('partial')
  })

  it('lists what has arrived and not been billed', async () => {
    const fixture = await retailFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    await receiveGoods(fixture.ctx, {
      vendorId: vendor.id,
      receivedOn: '2026-07-10',
      lines: [{ itemId: fixture.itemId, quantityMilli: 10_000, unitCostCents: 2_000 }],
    })

    const unbilled = await unbilledReceipts(fixture.ctx)

    // An accountant looking at the 2050 balance asks "what is in it", and the
    // answer has to be a list of deliveries rather than a number.
    expect(unbilled).toHaveLength(1)
    expect(unbilled[0].totalCents).toBe(20_000)
  })

  it('closes an order once every line is satisfied', async () => {
    const fixture = await retailFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    const order = await createPurchaseOrder(fixture.ctx, {
      vendorId: vendor.id,
      orderedOn: '2026-07-01',
      lines: [{ itemId: fixture.itemId, quantityMilli: 10_000, unitCostCents: 2_000 }],
    })
    const { lines } = await purchaseOrderWithLines(fixture.ctx, order.id)

    await receiveGoods(fixture.ctx, {
      vendorId: vendor.id,
      receivedOn: '2026-07-05',
      purchaseOrderId: order.id,
      lines: [{ purchaseOrderLineId: lines[0].id, itemId: fixture.itemId, quantityMilli: 4_000 }],
    })
    expect((await purchaseOrderWithLines(fixture.ctx, order.id)).order.status).toBe('partial')

    await receiveGoods(fixture.ctx, {
      vendorId: vendor.id,
      receivedOn: '2026-07-09',
      purchaseOrderId: order.id,
      lines: [{ purchaseOrderLineId: lines[0].id, itemId: fixture.itemId, quantityMilli: 6_000 }],
    })
    expect((await purchaseOrderWithLines(fixture.ctx, order.id)).order.status).toBe('received')
  })
})

describe('the guards around stock', () => {
  it('refuses to stock a service', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    const [service] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Consulting',
        unit: 'hour',
        isInventoried: false,
      })
      .returning()

    // Quietly allowing it would put a value on the balance sheet for something
    // that does not exist.
    await expect(
      receiveStock(fixture.ctx, {
        itemId: service.id,
        quantityMilli: 1_000,
        unitCostCents: 100,
        receivedOn: '2026-07-01',
        creditAccountId: grni.id,
      }),
    ).rejects.toThrow(/not a stocked item/)
  })

  it('refuses a negative cost', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    await expect(
      receiveStock(fixture.ctx, {
        itemId: fixture.itemId,
        quantityMilli: 1_000,
        unitCostCents: -100,
        receivedOn: '2026-07-01',
        creditAccountId: grni.id,
      }),
    ).rejects.toThrow(/not a discount/)
  })

  it('refuses when the module is switched off', async () => {
    const fixture = await createCompanyFixture({ industry: 'general' })
    const [item] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        name: 'Widget',
        unit: 'each',
        isInventoried: true,
      })
      .returning()

    await expect(
      adjustStock(fixture.ctx, {
        itemId: item.id,
        countedMilli: 1,
        adjustedOn: '2026-07-01',
        reason: 'Count',
      }),
    ).rejects.toThrow(/not switched on/)
  })

  it('keeps one company’s stock out of another’s', async () => {
    const one = await retailFixture()
    const two = await retailFixture()
    const grni = await one.account('2050')

    await receiveStock(one.ctx, {
      itemId: one.itemId,
      quantityMilli: 5_000,
      unitCostCents: 1_000,
      receivedOn: '2026-07-01',
      creditAccountId: grni.id,
    })

    expect(await stockOnHand(two.ctx)).toEqual([
      expect.objectContaining({ quantityMilli: 0, valueCents: 0 }),
    ])
    expect((await openLots(two.companyId, one.itemId)).length).toBe(0)
  })
})

describe('knowing what to buy', () => {
  it('flags an item at or below its reorder point', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    await db
      .update(serviceItems)
      .set({ reorderPointMilli: 5_000 })
      .where(eq(serviceItems.id, fixture.itemId))

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 10_000,
      unitCostCents: 1_000,
      receivedOn: '2026-07-01',
      creditAccountId: grni.id,
    })
    expect(await reorderList(fixture.ctx)).toHaveLength(0)

    await adjustStock(fixture.ctx, {
      itemId: fixture.itemId,
      countedMilli: 5_000,
      adjustedOn: '2026-07-15',
      reason: 'Count',
    })
    // At the point, not below it — waiting until it is under would mean
    // ordering the day after running out.
    expect(await reorderList(fixture.ctx)).toHaveLength(1)
  })

  it('previews a sale’s cost without writing anything', async () => {
    const fixture = await retailFixture()
    const grni = await fixture.account('2050')

    await receiveStock(fixture.ctx, {
      itemId: fixture.itemId,
      quantityMilli: 10_000,
      unitCostCents: 2_000,
      receivedOn: '2026-07-01',
      creditAccountId: grni.id,
    })

    const preview = await previewSaleCost(fixture.ctx, fixture.itemId, 4_000)
    expect(preview.costCents).toBe(80_00)
    expect(preview.remainingAfter).toBe(6_000)

    // Nothing moved.
    expect((await stockOnHand(fixture.ctx))[0].quantityMilli).toBe(10_000)
  })
})
