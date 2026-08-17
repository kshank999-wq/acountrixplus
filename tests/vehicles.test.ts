import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries, journalLines, repairOrders, serviceItems, vehicles } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { ModuleDisabledError, setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'
import { receiveStock } from '@/modules/inventory/service'
import { authorityFor, odometerStep } from '@/modules/vehicles/authority'
import {
  REPAIR_ACCOUNTS,
  RepairError,
  UnauthorisedWorkError,
  addLine,
  addVehicle,
  authorise,
  cancelRepairOrder,
  completeRepairOrder,
  openRepairOrder,
  recordOdometer,
  repairOrderView,
  transferVehicle,
} from '@/modules/vehicles/service'
import {
  authorisationsAgree,
  openOrders,
  shopMix,
  vehicleHistory,
  vehicleList,
} from '@/modules/vehicles/reporting'

/**
 * Customer vehicles and repair orders (spec §5 Automotive, Phase 30).
 *
 * Five claims under test:
 *
 *  1. **Nobody bills past what the customer authorised.**
 *  2. **An odometer does not go backwards.**
 *  3. **The record follows the car**, not the owner.
 *  4. **Parts, labour and sublet are three different things.**
 *  5. **A part fitted is a sale**, relieving the shelf at what it actually cost.
 */

/** A garage with the automotive pack and the module on. */
async function garage(name = 'Ashgrove Motors'): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name, industry: 'automotive' })
  await setModuleEnabled(fixture.ctx, 'vehicles', true)
  return fixture
}

async function aCar(fixture: Fixture, registration = 'YK21 ZRT') {
  return addVehicle(fixture.ctx, {
    registration,
    vin: `VIN${registration.replace(/\s/g, '')}`,
    make: 'Volkswagen',
    model: 'Golf',
    year: 2021,
    odometerMiles: 48_000,
  })
}

describe('what the customer agreed to (Phase 30)', () => {
  it('applies the tolerance to the authorised amount, not to the quote', () => {
    // £400 authorised, 10% tolerance. The ceiling is £440 and stays £440
    // however large the quote grows — a tolerance that scaled with the
    // overspend would be the opposite of a limit.
    for (const quoted of [0, 40_000, 44_000, 100_000]) {
      const authority = authorityFor({
        authorisedCents: 40_000,
        toleranceBp: 1_000,
        quotedCents: quoted,
      })
      expect(authority.ceilingCents).toBe(44_000)
    }
  })

  it('says how much headroom is left, and how far over it is', () => {
    const under = authorityFor({ authorisedCents: 40_000, toleranceBp: 0, quotedCents: 36_000 })
    expect(under.withinAuthority).toBe(true)
    expect(under.headroomCents).toBe(4_000)
    expect(under.overByCents).toBe(0)
    expect(under.needsAuthorisationForCents).toBe(0)

    const over = authorityFor({ authorisedCents: 40_000, toleranceBp: 0, quotedCents: 52_000 })
    expect(over.withinAuthority).toBe(false)
    expect(over.headroomCents).toBe(0)
    expect(over.overByCents).toBe(12_000)
    // The number read down the phone is the *extra*, not the new total.
    expect(over.needsAuthorisationForCents).toBe(12_000)
  })

  it('does not count the tolerance twice when asking for more', () => {
    // £400 authorised with 10% tolerance, work at £520. What must be approved
    // is £120 — the gap to the authorised amount — not £80 to the ceiling.
    // Asking only to the ceiling would let the tolerance apply again on top of
    // the new authorisation, and a limit that compounds is not a limit.
    const authority = authorityFor({
      authorisedCents: 40_000,
      toleranceBp: 1_000,
      quotedCents: 52_000,
    })
    expect(authority.needsAuthorisationForCents).toBe(12_000)
  })

  it('rounds the ceiling down, never up', () => {
    // 3% of £333.33 is £9.9999. A ceiling that rounded up would be one the
    // shop set for itself.
    const authority = authorityFor({ authorisedCents: 33_333, toleranceBp: 300, quotedCents: 0 })
    expect(authority.ceilingCents).toBe(33_333 + 999)
  })

  it('treats a nonsense tolerance as a typo', () => {
    expect(
      authorityFor({ authorisedCents: 10_000, toleranceBp: 90_000, quotedCents: 0 }).ceilingCents,
    ).toBe(20_000)
    expect(
      authorityFor({ authorisedCents: 10_000, toleranceBp: -500, quotedCents: 0 }).ceilingCents,
    ).toBe(10_000)
  })

  it('authorises nothing when nothing was agreed', () => {
    const authority = authorityFor({ authorisedCents: 0, toleranceBp: 1_000, quotedCents: 5_000 })
    expect(authority.ceilingCents).toBe(0)
    expect(authority.withinAuthority).toBe(false)
    expect(authority.needsAuthorisationForCents).toBe(5_000)
  })
})

describe('an odometer does not go backwards (Phase 30)', () => {
  it('accepts the first reading whatever it says', () => {
    expect(odometerStep(null, 120_000)).toEqual({ kind: 'ok', milesTravelled: null })
  })

  it('reports the distance travelled since last time', () => {
    expect(odometerStep(48_000, 51_200)).toEqual({ kind: 'ok', milesTravelled: 3_200 })
  })

  it('tells a car that has not moved from one that has', () => {
    // Towed in, looked at, collected. Not an error, and not silently folded
    // into "ok" either — a run of them is a question worth asking.
    expect(odometerStep(48_000, 48_000)).toEqual({ kind: 'unmoved' })
  })

  it('refuses a reading below the last one', () => {
    expect(odometerStep(48_000, 41_000)).toEqual({ kind: 'backwards', byMiles: 7_000 })
  })

  it('will not write a rollback without somebody asking for it', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    await expect(
      recordOdometer(fixture.ctx, { vehicleId: car.id, readingMiles: 41_000 }),
    ).rejects.toBeInstanceOf(RepairError)

    const [row] = await db
      .select({ miles: vehicles.odometerMiles })
      .from(vehicles)
      .where(eq(vehicles.id, car.id))
    expect(row.miles).toBe(48_000)
  })

  it('records a replaced cluster when somebody says so, and audits it', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    await recordOdometer(fixture.ctx, {
      vehicleId: car.id,
      readingMiles: 12,
      allowRollback: true,
      reason: 'Instrument cluster replaced',
    })

    const [row] = await db
      .select({ miles: vehicles.odometerMiles })
      .from(vehicles)
      .where(eq(vehicles.id, car.id))
    expect(row.miles).toBe(12)

    const { auditEvents } = await import('@/db/schema')
    const events = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.companyId, fixture.companyId),
          eq(auditEvents.action, 'vehicle.odometer_rollback'),
        ),
      )
    expect(events).toHaveLength(1)
  })
})

describe('the record follows the car (Phase 30)', () => {
  it('keeps the history when the car changes hands', async () => {
    const fixture = await garage()
    const { customers } = await import('@/db/schema')

    const [first] = await db
      .insert(customers)
      .values({ companyId: fixture.companyId, name: 'Priya Raman' })
      .returning()
    const [second] = await db
      .insert(customers)
      .values({ companyId: fixture.companyId, name: 'Tomasz Lewandowski' })
      .returning()

    const car = await addVehicle(fixture.ctx, {
      registration: 'YK21 ZRT',
      customerId: first.id,
      odometerMiles: 48_000,
    })

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
      complaint: 'Knocking from the front',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 30_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Front suspension',
      quantityMilli: 2_000,
      unitPriceCents: 9_000,
    })
    await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    // Sold.
    await transferVehicle(fixture.ctx, { vehicleId: car.id, customerId: second.id })

    const history = await vehicleHistory(fixture.ctx, car.id)
    expect(history).toHaveLength(1)
    expect(history[0].totalCents).toBe(18_000)

    const list = await vehicleList(fixture.ctx)
    expect(list[0].customerName).toBe('Tomasz Lewandowski')
    // The visit and the money stay with the car, under its new keeper.
    expect(list[0].visits).toBe(1)
    expect(list[0].spentCents).toBe(18_000)
  })

  it('refuses two vehicles with the same VIN', async () => {
    const fixture = await garage()
    await addVehicle(fixture.ctx, { vin: 'WVWZZZ1KZAW000001' })

    await expect(
      addVehicle(fixture.ctx, { vin: 'wvwzzz1kzaw000001' }),
    ).rejects.toBeInstanceOf(RepairError)
  })

  it("keeps one garage's cars off another's ramp", async () => {
    const a = await garage('Ashgrove Motors')
    const b = await garage('Brookvale Autos')

    await aCar(a, 'AAA 111')

    expect(await vehicleList(b.ctx)).toHaveLength(0)
    const car = (await vehicleList(a.ctx))[0]

    await expect(
      openRepairOrder(b.ctx, { vehicleId: car.id, openedOn: '2026-05-01' }),
    ).rejects.toBeInstanceOf(RepairError)
  })
})

describe('nobody bills past what was authorised (Phase 30)', () => {
  it('refuses to bill an estimate nobody agreed to', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Diagnostics',
      unitPriceCents: 9_000,
    })

    await expect(
      completeRepairOrder(fixture.ctx, { repairOrderId: order.id, completedOn: '2026-05-02' }),
    ).rejects.toBeInstanceOf(UnauthorisedWorkError)

    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.companyId, fixture.companyId), eq(journalEntries.source, 'repair')),
      )
    expect(entries).toHaveLength(0)
  })

  it('lets the work be priced past the authority, and only refuses the bill', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 20_000 })

    // The advisor prices the extra work in order to ring up and ask about it.
    // Refusing the *line* would make that impossible.
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Cambelt',
      quantityMilli: 4_000,
      unitPriceCents: 9_000,
    })

    const view = await repairOrderView(fixture.ctx, order.id)
    expect(view.totals.totalCents).toBe(36_000)
    expect(view.authority.withinAuthority).toBe(false)
    expect(view.authority.needsAuthorisationForCents).toBe(16_000)

    await expect(
      completeRepairOrder(fixture.ctx, { repairOrderId: order.id, completedOn: '2026-05-02' }),
    ).rejects.toBeInstanceOf(UnauthorisedWorkError)
  })

  it('bills once the customer says yes to the rest', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 20_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Cambelt',
      quantityMilli: 4_000,
      unitPriceCents: 9_000,
    })

    // The phone call.
    await authorise(fixture.ctx, {
      repairOrderId: order.id,
      amountCents: 16_000,
      channel: 'phone',
      approvedBy: 'Priya Raman',
    })

    const result = await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    expect(result.posted).toBe(true)
    expect(result.totals.totalCents).toBe(36_000)

    const labour = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.labourRevenue)
    expect(await balanceForAccount(fixture.ctx, labour!.id)).toBe(36_000)
  })

  it('allows a tolerance without allowing an open cheque', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
      toleranceBp: 1_000,
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 40_000 })

    // £2 over the authorised £400 — inside the 10% tolerance, no phone call.
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Service',
      unitPriceCents: 40_200,
    })

    await expect(
      completeRepairOrder(fixture.ctx, { repairOrderId: order.id, completedOn: '2026-05-02' }),
    ).resolves.toBeTruthy()

    // But a second order at £441 on the same £400 is over the £440 ceiling.
    const second = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-03',
      toleranceBp: 1_000,
    })
    await authorise(fixture.ctx, { repairOrderId: second.id, amountCents: 40_000 })
    await addLine(fixture.ctx, {
      repairOrderId: second.id,
      kind: 'labour',
      description: 'More',
      unitPriceCents: 44_100,
    })

    await expect(
      completeRepairOrder(fixture.ctx, { repairOrderId: second.id, completedOn: '2026-05-04' }),
    ).rejects.toBeInstanceOf(UnauthorisedWorkError)
  })

  it('keeps every authorisation as its own row, with who and how', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, {
      repairOrderId: order.id,
      amountCents: 20_000,
      channel: 'in_person',
      approvedBy: 'Priya Raman',
    })
    await authorise(fixture.ctx, {
      repairOrderId: order.id,
      amountCents: 16_000,
      channel: 'phone',
      approvedBy: 'Priya Raman',
    })

    const { listAuthorisations } = await import('@/modules/vehicles/service')
    const rows = await listAuthorisations(fixture.ctx, order.id)

    // A shop challenged over a bill has to be able to say which approval,
    // when, and down which channel. One running total cannot say any of it.
    expect(rows).toHaveLength(2)
    expect(rows[0].channel).toBe('in_person')
    expect(rows[1].channel).toBe('phone')
    expect(rows[1].amountCents).toBe(16_000)

    const check = await authorisationsAgree(fixture.ctx)
    expect(check.storedCents).toBe(36_000)
    expect(check.recordedCents).toBe(36_000)
    expect(check.agrees).toBe(true)
  })

  it('can withdraw an authorisation given in error', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 50_000 })
    await authorise(fixture.ctx, {
      repairOrderId: order.id,
      amountCents: -20_000,
      notes: 'Keyed twice',
    })

    const view = await repairOrderView(fixture.ctx, order.id)
    expect(view.authorisedCents).toBe(30_000)

    // History is corrected by a further row, never by editing the first.
    const check = await authorisationsAgree(fixture.ctx)
    expect(check.agrees).toBe(true)
  })

  it('will not let a withdrawal take the total below zero', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 10_000 })

    await expect(
      authorise(fixture.ctx, { repairOrderId: order.id, amountCents: -20_000 }),
    ).rejects.toBeInstanceOf(RepairError)
  })

  it('flags an over-authority order on the board without alarming about estimates', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const quoted = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await addLine(fixture.ctx, {
      repairOrderId: quoted.id,
      kind: 'labour',
      description: 'Quoted only',
      unitPriceCents: 90_000,
    })

    const running = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-02',
    })
    await authorise(fixture.ctx, { repairOrderId: running.id, amountCents: 10_000 })
    await addLine(fixture.ctx, {
      repairOrderId: running.id,
      kind: 'labour',
      description: 'Ran over',
      unitPriceCents: 25_000,
    })

    const board = await openOrders(fixture.ctx)
    const estimate = board.find((row) => row.id === quoted.id)
    const authorised = board.find((row) => row.id === running.id)

    // An estimate nobody has agreed to has no authority to be over — a
    // different and unalarming state from work that ran past its approval.
    expect(estimate?.withinAuthority).toBe(true)
    expect(authorised?.withinAuthority).toBe(false)
    expect(authorised?.overByCents).toBe(15_000)
  })

  it('refuses to bill an order with nothing on it', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 10_000 })

    await expect(
      completeRepairOrder(fixture.ctx, { repairOrderId: order.id, completedOn: '2026-05-02' }),
    ).rejects.toBeInstanceOf(RepairError)
  })

  it('refuses to bill or to add to a cancelled order', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 10_000 })
    await cancelRepairOrder(fixture.ctx, { repairOrderId: order.id })

    await expect(
      addLine(fixture.ctx, {
        repairOrderId: order.id,
        kind: 'labour',
        description: 'Too late',
        unitPriceCents: 1_000,
      }),
    ).rejects.toBeInstanceOf(RepairError)

    await expect(
      completeRepairOrder(fixture.ctx, { repairOrderId: order.id, completedOn: '2026-05-02' }),
    ).rejects.toBeInstanceOf(RepairError)
  })

  it('bills once however many times the button is pressed', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 20_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Service',
      unitPriceCents: 18_000,
    })

    const first = await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })
    const second = await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    expect(first.posted).toBe(true)
    expect(second.posted).toBe(false)

    const labour = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.labourRevenue)
    expect(await balanceForAccount(fixture.ctx, labour!.id)).toBe(18_000)
  })

  it('refuses to open an order when the module is off', async () => {
    const fixture = await createCompanyFixture({ name: 'No Ramp', industry: 'general' })
    await expect(
      openRepairOrder(fixture.ctx, {
        vehicleId: '00000000-0000-0000-0000-000000000000',
        openedOn: '2026-05-01',
      }),
    ).rejects.toBeInstanceOf(ModuleDisabledError)
  })

  it('refuses to bill without the journal permission', async () => {
    const fixture = await garage()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }
    await expect(
      completeRepairOrder(readonly, {
        repairOrderId: '00000000-0000-0000-0000-000000000000',
        completedOn: '2026-05-02',
      }),
    ).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('parts, labour and sublet are three different things (Phase 30)', () => {
  async function stockedGarage() {
    const fixture = await garage()
    await setModuleEnabled(fixture.ctx, 'inventory', true)

    const partsAccount = await accountByNumber(fixture.companyId, '1480')
    const revenue = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.partsRevenue)
    const payable = await accountByNumber(fixture.companyId, '2000')

    const [pads] = await db
      .insert(serviceItems)
      .values({
        companyId: fixture.companyId,
        code: 'PADS',
        name: 'Brake pads, front',
        unitPriceCents: 8_000,
        unitCostCents: 3_000,
        isInventoried: true,
        chartAccountId: revenue!.id,
        inventoryAccountId: partsAccount!.id,
      })
      .returning()

    await receiveStock(fixture.ctx, {
      itemId: pads.id,
      quantityMilli: 4_000,
      unitCostCents: 3_000,
      receivedOn: '2026-04-01',
      creditAccountId: payable!.id,
    })

    return { fixture, pads }
  }

  it('splits the bill three ways and relieves the shelf for the parts', async () => {
    const { fixture, pads } = await stockedGarage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 60_000 })

    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Fit front pads',
      quantityMilli: 1_500,
      unitPriceCents: 9_000,
    })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'part',
      description: 'Brake pads, front',
      itemId: pads.id,
      quantityMilli: 2_000,
      unitPriceCents: 8_000,
    })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'sublet',
      description: 'Discs skimmed',
      unitPriceCents: 6_000,
      subletCostCents: 4_000,
    })

    const result = await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
      odometerOut: 48_140,
    })

    expect(result.totals.labourCents).toBe(13_500)
    expect(result.totals.partsCents).toBe(16_000)
    expect(result.totals.subletCents).toBe(6_000)
    expect(result.totals.totalCents).toBe(35_500)
    // Two sets of pads out of the lot they came from, at what they cost.
    expect(result.partsCostCents).toBe(6_000)
    expect(result.shortfalls).toHaveLength(0)

    const labour = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.labourRevenue)
    const parts = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.partsRevenue)
    const sublet = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.subletRevenue)
    const partsCost = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.partsCost)

    expect(await balanceForAccount(fixture.ctx, labour!.id)).toBe(13_500)
    expect(await balanceForAccount(fixture.ctx, parts!.id)).toBe(16_000)
    expect(await balanceForAccount(fixture.ctx, sublet!.id)).toBe(6_000)
    expect(await balanceForAccount(fixture.ctx, partsCost!.id)).toBe(6_000)

    // The shelf is two sets lighter and £60 lighter.
    const partsInventory = await accountByNumber(fixture.companyId, '1480')
    expect(await balanceForAccount(fixture.ctx, partsInventory!.id)).toBe(12_000 - 6_000)
  })

  it('does not post the sublet cost, leaving it to the supplier bill', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 10_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'sublet',
      description: 'Discs skimmed',
      unitPriceCents: 6_000,
      subletCostCents: 4_000,
    })
    await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    // 5180 stays empty. Accruing it here would double-count the machine shop's
    // invoice the moment it was entered through accounts payable, and nothing
    // links the two well enough to net them off.
    const subletCost = await accountByNumber(fixture.companyId, REPAIR_ACCOUNTS.subletCost)
    expect(await balanceForAccount(fixture.ctx, subletCost!.id)).toBe(0)

    // The margin is still reportable, which is the point of recording it.
    const mix = await shopMix(fixture.ctx)
    expect(mix.subletCents).toBe(6_000)
    expect(mix.subletCostCents).toBe(4_000)
    expect(mix.subletMarginCents).toBe(2_000)
  })

  it('says what the shop was made of', async () => {
    const { fixture, pads } = await stockedGarage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 60_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Labour',
      quantityMilli: 1_500,
      unitPriceCents: 9_000,
    })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'part',
      description: 'Pads',
      itemId: pads.id,
      quantityMilli: 2_000,
      unitPriceCents: 8_000,
    })

    // An unbilled order contributes nothing: a shop's mix is what it did, not
    // what it hoped to do.
    const before = await shopMix(fixture.ctx)
    expect(before.totalCents).toBe(0)

    await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    const after = await shopMix(fixture.ctx)
    expect(after.labourCents).toBe(13_500)
    expect(after.partsCents).toBe(16_000)
    expect(after.totalCents).toBe(29_500)
  })

  it('posts one balanced entry for the whole order', async () => {
    const { fixture, pads } = await stockedGarage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 60_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Labour',
      unitPriceCents: 13_500,
    })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'part',
      description: 'Pads',
      itemId: pads.id,
      quantityMilli: 2_000,
      unitPriceCents: 8_000,
    })

    const result = await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    const lines = await db
      .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, result.journalEntryId))

    // Receivable, labour, parts.
    expect(lines).toHaveLength(3)
    const debits = lines.reduce((sum, line) => sum + line.debit, 0)
    const credits = lines.reduce((sum, line) => sum + line.credit, 0)
    expect(debits).toBe(credits)
    expect(debits).toBe(29_500)

    // The profit and loss shows the margin on the parts, not just the sale.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.revenue.totalCents).toBe(29_500)
  })

  it('bills a part the shelf could not supply, and says so', async () => {
    const { fixture, pads } = await stockedGarage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 100_000 })
    // Ten sets on the order; four on the shelf.
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'part',
      description: 'Pads',
      itemId: pads.id,
      quantityMilli: 10_000,
      unitPriceCents: 8_000,
    })

    const result = await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    // The customer is billed for what was fitted; the shortfall is named
    // rather than silently costed at zero.
    expect(result.totals.partsCents).toBe(80_000)
    expect(result.shortfalls).toHaveLength(1)
    expect(result.shortfalls[0].shortfallMilli).toBe(6_000)
    expect(result.partsCostCents).toBe(12_000)
  })

  it('refuses a part line with no part on it', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })

    await expect(
      addLine(fixture.ctx, {
        repairOrderId: order.id,
        kind: 'part',
        description: 'Something',
        unitPriceCents: 1_000,
      }),
    ).rejects.toBeInstanceOf(RepairError)
  })

  it('records the odometer out when the car leaves', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
      odometerIn: 48_100,
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 20_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Road test',
      unitPriceCents: 9_000,
    })
    await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
      odometerOut: 48_112,
    })

    const [row] = await db
      .select({ miles: vehicles.odometerMiles })
      .from(vehicles)
      .where(eq(vehicles.id, car.id))
    expect(row.miles).toBe(48_112)

    const [stored] = await db
      .select({ inMiles: repairOrders.odometerIn, outMiles: repairOrders.odometerOut })
      .from(repairOrders)
      .where(eq(repairOrders.id, order.id))
    expect(stored.inMiles).toBe(48_100)
    expect(stored.outMiles).toBe(48_112)
  })

  it('refuses to bill when the car leaves with fewer miles than it arrived', async () => {
    const fixture = await garage()
    const car = await aCar(fixture)

    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
      odometerIn: 48_100,
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 20_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Road test',
      unitPriceCents: 9_000,
    })

    await expect(
      completeRepairOrder(fixture.ctx, {
        repairOrderId: order.id,
        completedOn: '2026-05-02',
        odometerOut: 41_000,
      }),
    ).rejects.toBeInstanceOf(RepairError)

    // And nothing posted: the whole completion is one transaction.
    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.companyId, fixture.companyId), eq(journalEntries.source, 'repair')),
      )
    expect(entries).toHaveLength(0)
  })
})
