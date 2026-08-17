import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customers } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { postManualEntry } from '@/modules/ledger/journal'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { arAging } from '@/modules/ledger/reports'
import { balanceForAccount } from '@/modules/ledger/balances'
import { addPractitioner, book, completeAppointment } from '@/modules/appointments/service'
import {
  addLine,
  addVehicle,
  authorise,
  completeRepairOrder,
  openRepairOrder,
} from '@/modules/vehicles/service'

/**
 * The control accounts, against the documents behind them (Phase 31).
 *
 * Four claims under test:
 *
 *  1. **What the balance sheet says is owed, the aging report can name.**
 *  2. **A service delivered raises a real invoice**, so it ages and can be paid.
 *  3. **A hand-written entry against a control account is caught**, because
 *     that is the one thing that genuinely breaks the agreement.
 *  4. **A walk-in is somebody**, and is billed to a house account rather than
 *     to nobody.
 */

const APRIL = (hour: number) => new Date(Date.UTC(2026, 3, 1, hour, 0))

async function salon(): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name: 'Fenwick Row', industry: 'personal_care' })
  await setModuleEnabled(fixture.ctx, 'appointments', true)
  return fixture
}

async function garage(): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name: 'Ashgrove Motors', industry: 'automotive' })
  await setModuleEnabled(fixture.ctx, 'vehicles', true)
  return fixture
}

describe('the balance sheet and the aging report agree (Phase 31)', () => {
  it('agrees on an empty company', async () => {
    const fixture = await salon()
    const report = await controlAccounts(fixture.ctx)

    expect(report.agrees).toBe(true)
    expect(report.receivables.ledgerCents).toBe(0)
    expect(report.receivables.subledgerCents).toBe(0)
  })

  it('agrees after a visit is delivered, and names who owes it', async () => {
    const fixture = await salon()
    const [client] = await db
      .insert(customers)
      .values({ companyId: fixture.companyId, name: 'Priya Raman' })
      .returning()

    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })
    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      customerId: client.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    const report = await controlAccounts(fixture.ctx)

    // This is the assertion Phase 29 would have failed: £65 on the balance
    // sheet and £0 on the aging report, with nobody named.
    expect(report.receivables.ledgerCents).toBe(6_500)
    expect(report.receivables.subledgerCents).toBe(6_500)
    expect(report.receivables.agrees).toBe(true)
    expect(report.receivables.parties).toHaveLength(1)
    expect(report.receivables.parties[0].name).toBe('Priya Raman')

    // And the aging report, which reads invoices, can see it too.
    const aging = await arAging(fixture.ctx, { asOfDate: '2026-04-30' })
    expect(aging.totals.totalCents).toBe(6_500)
    expect(aging.rows.map((row) => row.partyName)).toContain('Priya Raman')
  })

  it('agrees after a repair order is billed', async () => {
    const fixture = await garage()
    const [keeper] = await db
      .insert(customers)
      .values({ companyId: fixture.companyId, name: 'Tomasz Lewandowski' })
      .returning()

    const car = await addVehicle(fixture.ctx, {
      customerId: keeper.id,
      registration: 'YK21 ZRT',
      odometerMiles: 48_000,
    })
    const order = await openRepairOrder(fixture.ctx, {
      vehicleId: car.id,
      openedOn: '2026-05-01',
    })
    await authorise(fixture.ctx, { repairOrderId: order.id, amountCents: 40_000 })
    await addLine(fixture.ctx, {
      repairOrderId: order.id,
      kind: 'labour',
      description: 'Cambelt',
      quantityMilli: 4_000,
      unitPriceCents: 9_000,
    })
    await completeRepairOrder(fixture.ctx, {
      repairOrderId: order.id,
      completedOn: '2026-05-02',
    })

    const report = await controlAccounts(fixture.ctx)
    expect(report.receivables.ledgerCents).toBe(36_000)
    expect(report.receivables.subledgerCents).toBe(36_000)
    expect(report.receivables.agrees).toBe(true)
    expect(report.receivables.parties[0].name).toBe('Tomasz Lewandowski')
  })

  it('bills a walk-in to a house account rather than to nobody', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    // No client on the booking. Half a salon's book is like this.
    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 4_000,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    const report = await controlAccounts(fixture.ctx)
    expect(report.receivables.agrees).toBe(true)
    expect(report.receivables.parties[0].name).toBe('Walk-in')

    // One house account, however many walk-ins.
    const second = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(12),
      endsAt: APRIL(13),
      priceCents: 3_000,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: second.id,
      completedOn: '2026-04-01',
    })

    const after = await controlAccounts(fixture.ctx)
    expect(after.receivables.parties).toHaveLength(1)
    expect(after.receivables.parties[0].balanceCents).toBe(7_000)
    expect(after.receivables.agrees).toBe(true)
  })

  it('catches a hand-written entry against the control account', async () => {
    const fixture = await salon()
    const ar = await accountByNumber(fixture.companyId, '1100')
    const bank = await accountByNumber(fixture.companyId, '1000')

    // Somebody journals straight at Accounts Receivable. The ledger moves and
    // no customer's account does — which is precisely the split this exists to
    // find, and the only thing that legitimately breaks the agreement.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-01',
      memo: 'A receivable nobody owes',
      lines: [
        { chartAccountId: ar!.id, debitCents: 25_000 },
        { chartAccountId: bank!.id, creditCents: 25_000 },
      ],
    })

    const report = await controlAccounts(fixture.ctx)
    expect(report.receivables.ledgerCents).toBe(25_000)
    expect(report.receivables.subledgerCents).toBe(0)
    expect(report.receivables.differenceCents).toBe(25_000)
    expect(report.receivables.agrees).toBe(false)
    expect(report.agrees).toBe(false)
  })

  it('checks payables the same way', async () => {
    const fixture = await salon()
    const ap = await accountByNumber(fixture.companyId, '2000')
    const bank = await accountByNumber(fixture.companyId, '1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-01',
      memo: 'A payable nobody is owed',
      lines: [
        { chartAccountId: bank!.id, debitCents: 9_000 },
        { chartAccountId: ap!.id, creditCents: 9_000 },
      ],
    })

    const report = await controlAccounts(fixture.ctx)
    expect(report.payables.ledgerCents).toBe(9_000)
    expect(report.payables.subledgerCents).toBe(0)
    expect(report.payables.agrees).toBe(false)
    // Receivables are still fine; the report does not blame both for one fault.
    expect(report.receivables.agrees).toBe(true)
  })

  it('keeps one company out of another', async () => {
    const a = await salon()
    const b = await garage()

    const ar = await accountByNumber(a.companyId, '1100')
    const bank = await accountByNumber(a.companyId, '1000')
    await postManualEntry(a.ctx, {
      entryDate: '2026-04-01',
      memo: 'Theirs, not ours',
      lines: [
        { chartAccountId: ar!.id, debitCents: 12_000 },
        { chartAccountId: bank!.id, creditCents: 12_000 },
      ],
    })

    expect((await controlAccounts(a.ctx)).receivables.ledgerCents).toBe(12_000)
    expect((await controlAccounts(b.ctx)).receivables.ledgerCents).toBe(0)
  })

  it('a gift card settles the invoice, not just the ledger', async () => {
    const fixture = await salon()
    const { sellGiftCard, redeemGiftCard } = await import('@/modules/appointments/service')

    const [client] = await db
      .insert(customers)
      .values({ companyId: fixture.companyId, name: 'Priya Raman' })
      .returning()

    await sellGiftCard(fixture.ctx, {
      code: 'GC-1',
      amountCents: 5_000,
      issuedOn: '2026-03-01',
    })

    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })
    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      customerId: client.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    await redeemGiftCard(fixture.ctx, {
      code: 'GC-1',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    // £15 still owed, on both sides. Phase 29 moved the ledger and left the
    // invoice at £65, which this check would have reported immediately.
    const report = await controlAccounts(fixture.ctx)
    expect(report.receivables.ledgerCents).toBe(1_500)
    expect(report.receivables.subledgerCents).toBe(1_500)
    expect(report.receivables.agrees).toBe(true)

    const ar = await accountByNumber(fixture.companyId, '1100')
    expect(await balanceForAccount(fixture.ctx, ar!.id)).toBe(1_500)
  })
})
