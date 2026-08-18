import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customers, payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { setModuleEnabled, ModuleDisabledError } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { createInvoice } from '@/modules/receivables/service'
import { takePayment } from '@/modules/counter/service'
import {
  DRAWER_ACCOUNTS,
  DrawerError,
  addDrawer,
  closeShift,
  countFor,
  describe as describeCount,
  listDrawers,
  drawerPosition,
  openShift,
  payOut,
  shiftHistory,
  shiftPosition,
} from '@/modules/drawer/service'
import { INTEGRITY_CHECKS } from '@/modules/integrity/register'

/**
 * The drawer is counted, and the difference is named (Phase 34).
 *
 * Five claims under test:
 *
 *  1. **A float is not revenue.** It moves between two of the business's own
 *     pockets and the balance sheet total does not change.
 *  2. **Two people cannot open the same drawer at once**, and the database is
 *     what says so.
 *  3. **Counting is a declaration.** Nothing derives it, adjusts it, or rounds
 *     it towards what was expected — and the difference is posted, never
 *     absorbed.
 *  4. **Cash taken at the counter goes into the open drawer**, and a card
 *     never does.
 *  5. **A closed shift is a signed statement** and cannot be re-counted.
 */

async function shop(): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name: 'Marlowe Street', industry: 'restaurant' })
  await setModuleEnabled(fixture.ctx, 'cash_drawer', true)
  return fixture
}

async function aDrawer(fixture: Fixture, name = 'Front counter', defaultFloatCents = 10_000) {
  return addDrawer(fixture.ctx, { name, defaultFloatCents })
}

/** A bill somebody can pay across the counter. */
async function aBill(fixture: Fixture, totalCents: number) {
  const [customer] = await db
    .insert(customers)
    .values({ companyId: fixture.companyId, name: 'Walk-in' })
    .returning()

  const revenue = await accountByNumber(fixture.companyId, '4000')

  return createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-04-01',
    dueDate: '2026-04-01',
    lines: [
      {
        description: 'Lunch',
        quantityMilli: 1_000,
        unitPriceCents: totalCents,
        chartAccountId: revenue!.id,
      },
    ],
  })
}

async function drawerBalance(fixture: Fixture): Promise<number> {
  const account = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.cashInDrawers)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

describe('what a drawer should hold (Phase 34)', () => {
  it('is the float plus what was kept, less what was paid out', () => {
    const count = countFor({
      floatCents: 10_000,
      takingsCents: 43_500,
      paidOut: [{ reason: 'Window cleaner', amountCents: 2_000 }],
      countedCents: 51_500,
    })

    expect(count.expectedCents).toBe(51_500)
    expect(count.balances).toBe(true)
    expect(count.overShortCents).toBe(0)
  })

  it('names a short drawer and an over one with the same arithmetic', () => {
    const short = countFor({ floatCents: 10_000, takingsCents: 5_000, countedCents: 14_750 })
    expect(short.overShortCents).toBe(-250)
    expect(describeCount(short)).toContain('less in the drawer')

    const over = countFor({ floatCents: 10_000, takingsCents: 5_000, countedCents: 15_400 })
    expect(over.overShortCents).toBe(400)
    expect(describeCount(over)).toContain('more in the drawer')
  })

  it('keeps the float on the expected side, so a wrong float shows up', () => {
    // Opened with $80 when it should have been $100. Comparing counted-less-
    // float against takings would hide this; keeping the float in `expected`
    // reports it on the day, which is while somebody can still remember.
    const count = countFor({ floatCents: 8_000, takingsCents: 5_000, countedCents: 13_000 })
    expect(count.expectedCents).toBe(13_000)
    expect(count.balances).toBe(true)

    const asOpened = countFor({ floatCents: 10_000, takingsCents: 5_000, countedCents: 13_000 })
    expect(asOpened.overShortCents).toBe(-2_000)
  })

  it('banks what was counted, not what was expected', () => {
    // A short drawer can only hand over the money it actually has.
    const count = countFor({
      floatCents: 10_000,
      takingsCents: 5_000,
      countedCents: 14_000,
      retainFloatCents: 10_000,
    })

    expect(count.toBankCents).toBe(4_000)
    expect(count.floatRetainedCents).toBe(10_000)
  })

  it('never retains more float than is actually there', () => {
    const count = countFor({
      floatCents: 10_000,
      takingsCents: 0,
      countedCents: 6_000,
      retainFloatCents: 10_000,
    })

    expect(count.floatRetainedCents).toBe(6_000)
    expect(count.toBankCents).toBe(0)
  })

  it('refuses a drawer that paid out more than ever went in', () => {
    expect(() =>
      countFor({
        floatCents: 1_000,
        takingsCents: 0,
        paidOut: [{ reason: 'Nonsense', amountCents: 50_000 }],
        countedCents: 0,
      }),
    ).toThrow(DrawerError)
  })

  it('refuses a figure the ledger cannot hold rather than quietly zeroing it', () => {
    const count = countFor({
      floatCents: 10_000,
      takingsCents: Number.NaN,
      countedCents: 10_000,
    })
    expect(count.takingsCents).toBe(0)
    expect(count.balances).toBe(true)
  })
})

describe('opening a shift (Phase 34)', () => {
  it('moves the float without earning anything', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)

    const revenueBefore = await balanceForAccount(
      fixture.ctx,
      (await accountByNumber(fixture.companyId, '4000'))!.id,
    )

    await openShift(fixture.ctx, { drawerId: drawer.id })

    expect(await drawerBalance(fixture)).toBe(10_000)

    // Petty cash went down by exactly what the drawer went up by. Nothing was
    // earned: a float is the shop's own money changing pocket.
    const petty = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.pettyCash)
    expect(await balanceForAccount(fixture.ctx, petty!.id)).toBe(-10_000)

    const revenueAfter = await balanceForAccount(
      fixture.ctx,
      (await accountByNumber(fixture.companyId, '4000'))!.id,
    )
    expect(revenueAfter).toBe(revenueBefore)
  })

  it('installs the drawer account on first use', async () => {
    const fixture = await shop()
    expect(await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.cashInDrawers)).toBeNull()

    const drawer = await aDrawer(fixture)
    await openShift(fixture.ctx, { drawerId: drawer.id })

    expect(await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.cashInDrawers)).toBeDefined()
  })

  it('opens with no float at all, which is a real thing', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture, 'Card counter', 0)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    expect(shift.floatCents).toBe(0)
    expect(shift.openingEntryId).toBeNull()
  })

  it('refuses a second shift on the same drawer, and says who has it', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    await openShift(fixture.ctx, { drawerId: drawer.id })

    // The database is what refuses this, not a read-then-write in the service:
    // two people opening a till at 9am is exactly the race a check cannot win.
    await expect(openShift(fixture.ctx, { drawerId: drawer.id })).rejects.toBeInstanceOf(
      DrawerError,
    )

    try {
      await openShift(fixture.ctx, { drawerId: drawer.id })
    } catch (error) {
      expect((error as Error).message).toContain('already open')
    }
  })

  it('lets a second drawer open alongside the first', async () => {
    const fixture = await shop()
    const front = await aDrawer(fixture, 'Front counter')
    const bar = await aDrawer(fixture, 'Bar', 5_000)

    await openShift(fixture.ctx, { drawerId: front.id })
    await openShift(fixture.ctx, { drawerId: bar.id })

    const drawers = await listDrawers(fixture.ctx)
    expect(drawers.filter((row) => row.openShiftId !== null)).toHaveLength(2)
    expect(await drawerBalance(fixture)).toBe(15_000)
  })

  it('needs the module switched on', async () => {
    const fixture = await createCompanyFixture({ name: 'No till', industry: 'general' })
    await expect(addDrawer(fixture.ctx, { name: 'Front' })).rejects.toBeInstanceOf(
      ModuleDisabledError,
    )
  })

  it('needs the journal permission to open one', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)

    await expect(
      openShift({ ...fixture.ctx, role: 'sales' }, { drawerId: drawer.id }),
    ).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('cash at the counter goes into the drawer (Phase 34)', () => {
  it('puts a note in the open till rather than in Undeposited Funds', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 5_000 }],
    })

    // Float plus what was kept. The $6.50 of change is in no entry, which is
    // exactly what makes this sum come out — Phase 32's decision paying off.
    expect(await drawerBalance(fixture)).toBe(14_350)

    const undeposited = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.undeposited)
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(0)

    const position = await shiftPosition(fixture.ctx, shift.id)
    expect(position.takingsCents).toBe(4_350)
    expect(position.expectedCents).toBe(14_350)
  })

  it('never puts a card in a drawer', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'card', amountCents: 4_350 }],
    })

    // The drawer still holds only its float; the card is in Undeposited Funds
    // waiting for a batch. A card counted into a till would make every count
    // wrong by the day's card takings.
    expect(await drawerBalance(fixture)).toBe(10_000)

    const undeposited = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.undeposited)
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(4_350)

    expect((await shiftPosition(fixture.ctx, shift.id)).takingsCents).toBe(0)
  })

  it('splits a mixed tender between the drawer and the batch', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 8_000)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [
        { kind: 'card', amountCents: 5_000 },
        { kind: 'cash', amountCents: 5_000 },
      ],
    })

    // Non-cash first, so the card takes $50 and the cash covers the $30 left,
    // with $20 handed back. The drawer gains the $30 that was kept.
    expect(await drawerBalance(fixture)).toBe(13_000)
    expect((await shiftPosition(fixture.ctx, shift.id)).takingsCents).toBe(3_000)
  })

  it('falls back to Undeposited Funds when no till is open', async () => {
    const fixture = await shop()
    const invoice = await aBill(fixture, 4_350)

    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 4_350 }],
    })

    const undeposited = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.undeposited)
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(4_350)
  })

  it('refuses to guess between two open tills', async () => {
    const fixture = await shop()
    const front = await aDrawer(fixture, 'Front counter')
    const bar = await aDrawer(fixture, 'Bar', 5_000)
    await openShift(fixture.ctx, { drawerId: front.id })
    await openShift(fixture.ctx, { drawerId: bar.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 4_350 }],
    })

    // A note in the wrong till is a short drawer for one person and a long one
    // for another. Undeposited Funds is the honest answer to "which one".
    expect(await drawerBalance(fixture)).toBe(15_000)

    const [row] = await db
      .select({ drawerShiftId: payments.drawerShiftId })
      .from(payments)
      .where(eq(payments.companyId, fixture.companyId))
    expect(row.drawerShiftId).toBeNull()
  })

  it('puts it in the till that was named', async () => {
    const fixture = await shop()
    const front = await aDrawer(fixture, 'Front counter')
    const bar = await aDrawer(fixture, 'Bar', 5_000)
    await openShift(fixture.ctx, { drawerId: front.id })
    const barShift = await openShift(fixture.ctx, { drawerId: bar.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 4_350 }],
      drawerShiftId: barShift.id,
    })

    expect((await shiftPosition(fixture.ctx, barShift.id)).takingsCents).toBe(4_350)
  })
})

describe('paying out of the till (Phase 34)', () => {
  it('records the reason and takes the money out of the drawer', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const expense = await accountByNumber(fixture.companyId, '6000')

    await payOut(fixture.ctx, {
      shiftId: shift.id,
      reason: 'Window cleaner',
      amountCents: 2_000,
      chartAccountId: expense!.id,
    })

    expect(await drawerBalance(fixture)).toBe(8_000)

    const position = await shiftPosition(fixture.ctx, shift.id)
    expect(position.paidOutCents).toBe(2_000)
    expect(position.expectedCents).toBe(8_000)
    // The reason survives, because "$20 paid out" is not something anybody can
    // act on when the drawer is short.
    expect(position.payouts[0].reason).toBe('Window cleaner')
  })

  it('refuses a payout with no reason', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })
    const expense = await accountByNumber(fixture.companyId, '6000')

    await expect(
      payOut(fixture.ctx, {
        shiftId: shift.id,
        reason: '   ',
        amountCents: 2_000,
        chartAccountId: expense!.id,
      }),
    ).rejects.toBeInstanceOf(DrawerError)
  })
})

describe('counting the drawer (Phase 34)', () => {
  it('banks the takings and posts nothing when it balances', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 5_000 }],
    })

    const result = await closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 14_350 })

    expect(result.count.balances).toBe(true)
    expect(result.count.overShortCents).toBe(0)
    expect(result.count.toBankCents).toBe(4_350)

    // The float stays in for tomorrow; the takings are on their way to a bank.
    expect(await drawerBalance(fixture)).toBe(10_000)

    const undeposited = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.undeposited)
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(4_350)

    const overShort = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.overShort)
    expect(await balanceForAccount(fixture.ctx, overShort!.id)).toBe(0)
  })

  it('posts a short drawer rather than absorbing it', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 4_350 }],
    })

    // $2.50 less than the till says. Somebody gave the wrong change.
    const result = await closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 14_100 })

    expect(result.count.overShortCents).toBe(-250)
    expect(result.count.toBankCents).toBe(4_100)

    const overShort = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.overShort)
    // A cost, and a real one. A shop that is short every Friday has a fact
    // about Fridays, and it only exists because the money was booked.
    expect(await balanceForAccount(fixture.ctx, overShort!.id)).toBe(250)
    expect(await drawerBalance(fixture)).toBe(10_000)
  })

  it('posts an over drawer as a negative cost', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 4_350 }],
    })

    const result = await closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 14_750 })

    expect(result.count.overShortCents).toBe(400)

    const overShort = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.overShort)
    expect(await balanceForAccount(fixture.ctx, overShort!.id)).toBe(-400)
    // A till that is $4 over is not a till that balanced.
    expect(result.count.balances).toBe(false)
  })

  it('empties the drawer when no float is retained', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    await closeShift(fixture.ctx, {
      shiftId: shift.id,
      countedCents: 10_000,
      retainFloatCents: 0,
    })

    expect(await drawerBalance(fixture)).toBe(0)

    const undeposited = await accountByNumber(fixture.companyId, DRAWER_ACCOUNTS.undeposited)
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(10_000)
  })

  it('refuses to count a shift twice', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    await closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 10_000 })

    // A Z-reading whose number can be revised afterwards proves nothing about
    // the moment it was taken, and the moment is the whole control.
    await expect(
      closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 12_000 }),
    ).rejects.toBeInstanceOf(DrawerError)
  })

  it('frees the drawer for the next shift once it is closed', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const morning = await openShift(fixture.ctx, { drawerId: drawer.id })
    await closeShift(fixture.ctx, { shiftId: morning.id, countedCents: 10_000 })

    const afternoon = await openShift(fixture.ctx, { drawerId: drawer.id })
    expect(afternoon.id).not.toBe(morning.id)

    const history = await shiftHistory(fixture.ctx)
    expect(history).toHaveLength(2)
    expect(history.filter((row) => row.status === 'closed')).toHaveLength(1)
  })

  it('keeps what was counted, unadjusted, on the closed shift', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    await closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 9_750 })

    const [row] = await shiftHistory(fixture.ctx)
    expect(row.countedCents).toBe(9_750)
    expect(row.expectedCents).toBe(10_000)
    expect(row.overShortCents).toBe(-250)
  })

  it("keeps one company's tills out of another's", async () => {
    const first = await shop()
    const second = await shop()

    const drawer = await aDrawer(first)
    await openShift(first.ctx, { drawerId: drawer.id })

    expect(await listDrawers(second.ctx)).toHaveLength(0)
    expect(await shiftHistory(second.ctx)).toHaveLength(0)
    expect(await drawerBalance(second)).toBe(0)
  })
})

describe('the open tills against the balance sheet (Phase 34)', () => {
  it('agrees with nothing open', async () => {
    const fixture = await shop()
    const position = await drawerPosition(fixture.ctx)

    expect(position.agrees).toBe(true)
    expect(position.registerCents).toBe(0)
  })

  it('agrees after a float, a sale and a payout', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 5_000 }],
    })

    const expense = await accountByNumber(fixture.companyId, '6000')
    await payOut(fixture.ctx, {
      shiftId: shift.id,
      reason: 'Milk',
      amountCents: 400,
      chartAccountId: expense!.id,
    })

    const position = await drawerPosition(fixture.ctx)
    expect(position.registerCents).toBe(13_950)
    expect(position.ledgerCents).toBe(13_950)
    expect(position.agrees).toBe(true)
  })

  it('agrees once a shift is closed and the till emptied', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })
    await closeShift(fixture.ctx, {
      shiftId: shift.id,
      countedCents: 9_750,
      retainFloatCents: 0,
    })

    const position = await drawerPosition(fixture.ctx)
    expect(position.registerCents).toBe(0)
    expect(position.ledgerCents).toBe(0)
    expect(position.agrees).toBe(true)
  })

  it('still agrees when a float is left in overnight', async () => {
    const fixture = await shop()
    const drawer = await aDrawer(fixture)
    const shift = await openShift(fixture.ctx, { drawerId: drawer.id })

    const invoice = await aBill(fixture, 4_350)
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 4_350 }],
    })

    await closeShift(fixture.ctx, { shiftId: shift.id, countedCents: 14_350 })

    // The bug this test exists for. The first version of the check summed only
    // *open* shifts, so a till closed with its float still in it read as $100
    // adrift — every night, for every shop that keeps a float overnight, which
    // is every shop. A drawer holds money whether or not somebody is standing
    // at it, so the unit is the drawer.
    const position = await drawerPosition(fixture.ctx)
    expect(position.ledgerCents).toBe(10_000)
    expect(position.registerCents).toBe(10_000)
    expect(position.agrees).toBe(true)
    expect(position.tills[0].openShiftId).toBeNull()
  })

  it('counts a shut till and an open one together', async () => {
    const fixture = await shop()
    const front = await aDrawer(fixture, 'Front counter')
    const bar = await aDrawer(fixture, 'Bar', 5_000)

    const frontShift = await openShift(fixture.ctx, { drawerId: front.id })
    await closeShift(fixture.ctx, { shiftId: frontShift.id, countedCents: 10_000 })
    await openShift(fixture.ctx, { drawerId: bar.id })

    const position = await drawerPosition(fixture.ctx)
    expect(position.registerCents).toBe(15_000)
    expect(position.agrees).toBe(true)
  })

  it('is in the register as a fault, gated on the module', () => {
    const check = INTEGRITY_CHECKS.find((row) => row.key === 'cash_drawer.open_tills')

    expect(check).toBeDefined()
    expect(check!.severity).toBe('fault')
    expect(check!.module).toBe('cash_drawer')
  })
})
