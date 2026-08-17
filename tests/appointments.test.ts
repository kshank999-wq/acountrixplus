import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { appointments, giftCards, journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { ModuleDisabledError, setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'
import { postManualEntry } from '@/modules/ledger/journal'
import { redeemFor, splitFor } from '@/modules/appointments/split'
import {
  APPOINTMENT_ACCOUNTS,
  AppointmentError,
  DoubleBookedError,
  addPractitioner,
  book,
  closeWithoutDelivery,
  completeAppointment,
  redeemGiftCard,
  sellGiftCard,
} from '@/modules/appointments/service'
import {
  diarySummary,
  giftCardPosition,
  payoutPosition,
} from '@/modules/appointments/reporting'

/**
 * Appointments (spec §5 Healthcare and Personal Care, Phase 29).
 *
 * Five claims under test:
 *
 *  1. **A booking is a promise, not a sale.** Nothing posts until the service
 *     is delivered.
 *  2. **Two people cannot be in the same chair at once**, and it is the
 *     database that says so rather than a check that races.
 *  3. **Part of the money was never the business's.** The practitioner's share
 *     is a liability from the moment the work is done.
 *  4. **A gift card is money owed, not money earned** — and redeeming one does
 *     not earn it a second time.
 *  5. **A no-show is not a cancellation**, and neither is revenue.
 */

/** A salon with the personal-care pack and the module on. */
async function salon(name = 'Fenwick Row'): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name, industry: 'personal_care' })
  await setModuleEnabled(fixture.ctx, 'appointments', true)
  return fixture
}

const APRIL = (hour: number, minute = 0) => new Date(Date.UTC(2026, 3, 1, hour, minute))

describe('what a visit is worth, and to whom (Phase 29)', () => {
  it('splits a bill so the two halves always add to the whole', () => {
    // £65 service at 45%, £20 of shampoo at 10%.
    const split = splitFor({
      serviceCents: 6_500,
      productCents: 2_000,
      commissionBp: 4_500,
      productCommissionBp: 1_000,
    })

    expect(split.totalCents).toBe(8_500)
    expect(split.practitionerCents).toBe(2_925 + 200)
    expect(split.businessCents).toBe(8_500 - 3_125)
    expect(split.practitionerCents + split.businessCents).toBe(split.totalCents)
  })

  it('never loses a penny, whatever the rate', () => {
    // A price and a rate chosen to land exactly on a half-penny: 1p at 50%.
    for (const price of [1, 3, 7, 33, 99, 12_345, 99_999]) {
      for (const bp of [1, 333, 3_333, 5_000, 6_667, 9_999]) {
        const split = splitFor({
          serviceCents: price,
          productCents: 0,
          commissionBp: bp,
          productCommissionBp: 0,
        })
        expect(split.practitionerCents + split.businessCents).toBe(price)
        expect(split.practitionerCents).toBeGreaterThanOrEqual(0)
        expect(split.businessCents).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('says who kept the fraction of a penny', () => {
    // 1p at 50% is exactly half a penny. Math.round takes it to 1p for the
    // practitioner, so the business gave it away — a negative rounding.
    const split = splitFor({
      serviceCents: 1,
      productCents: 0,
      commissionBp: 5_000,
      productCommissionBp: 0,
    })

    expect(split.practitionerCents).toBe(1)
    expect(split.businessCents).toBe(0)
    expect(split.roundingCents).toBe(-0.5)
  })

  it('splits what was charged, not what was listed', () => {
    // A £100 service discounted to £80. The practitioner earns on the £80.
    const discounted = splitFor({
      serviceCents: 8_000,
      productCents: 0,
      commissionBp: 4_000,
      productCommissionBp: 0,
    })
    expect(discounted.practitionerCents).toBe(3_200)
  })

  it('treats a nonsense rate as a typo rather than an instruction', () => {
    const over = splitFor({
      serviceCents: 10_000,
      productCents: 0,
      commissionBp: 50_000,
      productCommissionBp: 0,
    })
    // Clamped to 100%, not 500% — a practitioner cannot be owed five times the bill.
    expect(over.practitionerCents).toBe(10_000)
    expect(over.businessCents).toBe(0)

    const under = splitFor({
      serviceCents: 10_000,
      productCents: 0,
      commissionBp: -4_000,
      productCommissionBp: 0,
    })
    expect(under.practitionerCents).toBe(0)
  })

  it('never produces a figure the ledger cannot hold', () => {
    // Nothing in the schema can produce these today. The guard exists so that
    // stays true if a caller ever computes a price rather than reading one:
    // NaN balances against nothing and cannot be reported on.
    const split = splitFor({
      serviceCents: Number.NaN,
      productCents: Number.POSITIVE_INFINITY,
      commissionBp: Number.NaN,
      productCommissionBp: 4_500,
    })

    expect(Number.isFinite(split.totalCents)).toBe(true)
    expect(Number.isFinite(split.practitionerCents)).toBe(true)
    expect(split.practitionerCents + split.businessCents).toBe(split.totalCents)

    expect(redeemFor(Number.NaN, 5_000).appliedCents).toBe(0)
  })

  it('will not let a card pay more than it holds, or more than the bill', () => {
    // £50 card against a £65 bill.
    expect(redeemFor(5_000, 6_500)).toEqual({
      appliedCents: 5_000,
      remainingBalanceCents: 0,
      stillDueCents: 1_500,
    })

    // £50 card against a £30 bill: no change in cash.
    expect(redeemFor(5_000, 3_000)).toEqual({
      appliedCents: 3_000,
      remainingBalanceCents: 2_000,
      stillDueCents: 0,
    })

    // An empty card settles nothing.
    expect(redeemFor(0, 6_500).appliedCents).toBe(0)
  })
})

describe('the diary refuses what cannot happen (Phase 29)', () => {
  it('refuses to put one practitioner in two places at once', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })

    await expect(
      book(fixture.ctx, {
        practitionerId: sam.id,
        startsAt: APRIL(10, 30),
        endsAt: APRIL(11, 30),
        priceCents: 6_500,
      }),
    ).rejects.toBeInstanceOf(DoubleBookedError)

    const rows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.companyId, fixture.companyId))
    expect(rows).toHaveLength(1)
  })

  it('allows back-to-back appointments, which are not an overlap', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    await book(fixture.ctx, { practitionerId: sam.id, startsAt: APRIL(10), endsAt: APRIL(11) })
    // 11:00 to 12:00 begins exactly where the last ended. A half-open range is
    // what makes this legal, and a closed one would refuse a full day's diary.
    await book(fixture.ctx, { practitionerId: sam.id, startsAt: APRIL(11), endsAt: APRIL(12) })

    const rows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.companyId, fixture.companyId))
    expect(rows).toHaveLength(2)
  })

  it('lets two practitioners work the same hour', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })
    const rae = await addPractitioner(fixture.ctx, { name: 'Rae Lindqvist' })

    await book(fixture.ctx, { practitionerId: sam.id, startsAt: APRIL(10), endsAt: APRIL(11) })
    await book(fixture.ctx, { practitionerId: rae.id, startsAt: APRIL(10), endsAt: APRIL(11) })

    const rows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.companyId, fixture.companyId))
    expect(rows).toHaveLength(2)
  })

  it('frees the slot when an appointment is cancelled', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    const first = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
    })

    await closeWithoutDelivery(fixture.ctx, { appointmentId: first.id, status: 'cancelled' })

    // The hour is sellable again. Without the constraint's WHERE clause, calling
    // off Tuesday would block that hour for ever.
    await expect(
      book(fixture.ctx, { practitionerId: sam.id, startsAt: APRIL(10), endsAt: APRIL(11) }),
    ).resolves.toBeTruthy()
  })

  it('survives two receptionists booking the same slot at the same moment', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    const attempt = () =>
      book(fixture.ctx, { practitionerId: sam.id, startsAt: APRIL(14), endsAt: APRIL(15) })

    const results = await Promise.allSettled([attempt(), attempt()])
    const kept = results.filter((result) => result.status === 'fulfilled')

    // Exactly one. This is the case a read-then-write check cannot handle, and
    // the reason the rule lives in Postgres rather than in `book`.
    expect(kept).toHaveLength(1)
  })

  it('refuses an appointment that ends before it starts', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    await expect(
      book(fixture.ctx, { practitionerId: sam.id, startsAt: APRIL(11), endsAt: APRIL(10) }),
    ).rejects.toBeInstanceOf(AppointmentError)
  })

  it('refuses to book when the module is off', async () => {
    const fixture = await createCompanyFixture({ name: 'No Diary', industry: 'general' })
    await expect(
      book(fixture.ctx, {
        practitionerId: '00000000-0000-0000-0000-000000000000',
        startsAt: APRIL(10),
        endsAt: APRIL(11),
      }),
    ).rejects.toBeInstanceOf(ModuleDisabledError)
  })

  it('refuses to book without the journal permission', async () => {
    const fixture = await salon()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }
    await expect(
      book(readonly, {
        practitionerId: '00000000-0000-0000-0000-000000000000',
        startsAt: APRIL(10),
        endsAt: APRIL(11),
      }),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it("keeps one salon's diary out of another's", async () => {
    const a = await salon('Fenwick Row')
    const b = await salon('Marlborough Street')

    const sam = await addPractitioner(a.ctx, { name: 'Sam Okafor' })
    await book(a.ctx, { practitionerId: sam.id, startsAt: APRIL(10), endsAt: APRIL(11) })

    // The other salon cannot book against a practitioner it does not employ...
    await expect(
      book(b.ctx, { practitionerId: sam.id, startsAt: APRIL(10), endsAt: APRIL(11) }),
    ).rejects.toBeInstanceOf(AppointmentError)

    // ...and does not see the appointment either.
    const summary = await diarySummary(b.ctx)
    expect(summary.booked).toBe(0)
  })
})

describe('a booking is a promise; delivery is a sale (Phase 29)', () => {
  it('posts nothing at all when an appointment is booked', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })

    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.source, 'appointment'),
        ),
      )

    expect(entries).toHaveLength(0)

    // The forward book is a number, and it is deliberately not revenue.
    const summary = await diarySummary(fixture.ctx)
    expect(summary.bookedCents).toBe(6_500)
    expect(summary.deliveredCents).toBe(0)
  })

  it('books the whole fee as revenue and the share as a cost, never netted', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })

    const result = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    expect(result.practitionerCents).toBe(2_925)
    expect(result.businessCents).toBe(3_575)

    // The salon earned £65 and owes £29.25 of it. Netting to £35.75 of revenue
    // would hide the payout from anybody reading the profit and loss.
    const revenue = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.serviceRevenue)
    const cost = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.practitionerCost)
    const owed = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.practitionerPayable)

    expect(await balanceForAccount(fixture.ctx, revenue!.id)).toBe(6_500)
    expect(await balanceForAccount(fixture.ctx, cost!.id)).toBe(2_925)
    expect(await balanceForAccount(fixture.ctx, owed!.id)).toBe(2_925)
  })

  it('puts retail through its own revenue account at its own rate', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, {
      name: 'Sam Okafor',
      commissionBp: 4_500,
      productCommissionBp: 1_000,
    })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
      productCents: 2_000,
    })

    const result = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    // 45% of the service plus 10% of the shampoo — not 45% of both.
    expect(result.practitionerCents).toBe(2_925 + 200)

    const service = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.serviceRevenue)
    const product = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.productRevenue)

    expect(await balanceForAccount(fixture.ctx, service!.id)).toBe(6_500)
    expect(await balanceForAccount(fixture.ctx, product!.id)).toBe(2_000)
  })

  it('completing twice posts once', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })

    const first = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })
    const second = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    expect(first.posted).toBe(true)
    expect(second.posted).toBe(false)

    const revenue = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.serviceRevenue)
    expect(await balanceForAccount(fixture.ctx, revenue!.id)).toBe(6_500)
  })

  it('holds the rate that was agreed, not the one in force later', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_000 })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 10_000,
    })

    // A rise, after the booking but before the visit is marked done.
    const { practitioners } = await import('@/db/schema')
    await db.update(practitioners).set({ commissionBp: 6_000 }).where(eq(practitioners.id, sam.id))

    const result = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    // 40%, the rate the booking carried. A rise in April must not restate March.
    expect(result.practitionerCents).toBe(4_000)
  })

  it('completes a free appointment without posting anything', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 0,
    })

    const result = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    // A redo or a consultation happened, and the diary says so. There is
    // nothing to post, and no entry is invented to prove it.
    expect(result.posted).toBe(true)
    expect(result.totalCents).toBe(0)

    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.source, 'appointment'),
        ),
      )
    expect(entries).toHaveLength(0)

    const summary = await diarySummary(fixture.ctx)
    expect(summary.completed).toBe(1)
  })

  it('tells a no-show from a cancellation, and posts for neither', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    const missed = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    const calledOff = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(12),
      endsAt: APRIL(13),
      priceCents: 6_500,
    })

    await closeWithoutDelivery(fixture.ctx, { appointmentId: missed.id, status: 'no_show' })
    await closeWithoutDelivery(fixture.ctx, { appointmentId: calledOff.id, status: 'cancelled' })

    const summary = await diarySummary(fixture.ctx)
    expect(summary.noShow).toBe(1)
    expect(summary.cancelled).toBe(1)
    // A slot lost against a slot given back. One figure could not tell them apart.
    expect(summary.noShowRateBp).toBe(10_000)

    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.source, 'appointment'),
        ),
      )
    expect(entries).toHaveLength(0)
  })

  it('refuses to complete something already marked a no-show', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    await closeWithoutDelivery(fixture.ctx, { appointmentId: appointment.id, status: 'no_show' })

    await expect(
      completeAppointment(fixture.ctx, {
        appointmentId: appointment.id,
        completedOn: '2026-04-01',
      }),
    ).rejects.toBeInstanceOf(AppointmentError)
  })

  it('refuses to un-deliver something already posted', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    await expect(
      closeWithoutDelivery(fixture.ctx, { appointmentId: appointment.id, status: 'cancelled' }),
    ).rejects.toBeInstanceOf(AppointmentError)
  })
})

describe('a gift card is money owed, not money earned (Phase 29)', () => {
  it('puts a sold card on the balance sheet and nowhere near revenue', async () => {
    const fixture = await salon()

    await sellGiftCard(fixture.ctx, {
      code: 'GC-1001',
      amountCents: 5_000,
      issuedOn: '2026-03-01',
    })

    const outstanding = await accountByNumber(
      fixture.companyId,
      APPOINTMENT_ACCOUNTS.giftCardsOutstanding,
    )
    expect(await balanceForAccount(fixture.ctx, outstanding!.id)).toBe(5_000)

    // The whole claim of this half of the phase, asserted where it shows:
    // £50 came in and the salon has earned none of it.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.revenue.totalCents).toBe(0)
  })

  it('earns nothing extra when the card is spent', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    await sellGiftCard(fixture.ctx, {
      code: 'GC-1001',
      amountCents: 5_000,
      issuedOn: '2026-03-01',
    })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    const redemption = await redeemGiftCard(fixture.ctx, {
      code: 'GC-1001',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    expect(redemption.appliedCents).toBe(5_000)
    expect(redemption.stillDueCents).toBe(1_500)

    // £65 of revenue for one £65 haircut. Crediting 4720 on redemption as well
    // would state £115 of income, which is the mistake this test exists for.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.revenue.totalCents).toBe(6_500)

    // The liability is gone and the client owes only the shortfall.
    const outstanding = await accountByNumber(
      fixture.companyId,
      APPOINTMENT_ACCOUNTS.giftCardsOutstanding,
    )
    const receivable = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.receivable)
    expect(await balanceForAccount(fixture.ctx, outstanding!.id)).toBe(0)
    expect(await balanceForAccount(fixture.ctx, receivable!.id)).toBe(1_500)
  })

  it('never gives change in cash', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    await sellGiftCard(fixture.ctx, {
      code: 'GC-BIG',
      amountCents: 10_000,
      issuedOn: '2026-03-01',
    })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 3_000,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    const redemption = await redeemGiftCard(fixture.ctx, {
      code: 'GC-BIG',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    expect(redemption.appliedCents).toBe(3_000)
    expect(redemption.remainingBalanceCents).toBe(7_000)
    expect(redemption.stillDueCents).toBe(0)

    const [card] = await db
      .select({ balance: giftCards.balanceCents })
      .from(giftCards)
      .where(eq(giftCards.code, 'GC-BIG'))
    expect(card.balance).toBe(7_000)
  })

  it('cannot spend the same card twice on the same visit', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    await sellGiftCard(fixture.ctx, {
      code: 'GC-1001',
      amountCents: 10_000,
      issuedOn: '2026-03-01',
    })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 3_000,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    const first = await redeemGiftCard(fixture.ctx, {
      code: 'GC-1001',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })
    const second = await redeemGiftCard(fixture.ctx, {
      code: 'GC-1001',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)

    const [card] = await db
      .select({ balance: giftCards.balanceCents })
      .from(giftCards)
      .where(eq(giftCards.code, 'GC-1001'))
    expect(card.balance).toBe(7_000)
  })

  it('refuses to settle a visit that has not happened', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    await sellGiftCard(fixture.ctx, {
      code: 'GC-1001',
      amountCents: 5_000,
      issuedOn: '2026-03-01',
    })
    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })

    await expect(
      redeemGiftCard(fixture.ctx, {
        code: 'GC-1001',
        appointmentId: appointment.id,
        redeemedOn: '2026-04-01',
      }),
    ).rejects.toBeInstanceOf(AppointmentError)
  })

  it('refuses to sell the same card code twice', async () => {
    const fixture = await salon()

    await sellGiftCard(fixture.ctx, {
      code: 'GC-1001',
      amountCents: 5_000,
      issuedOn: '2026-03-01',
    })

    await expect(
      sellGiftCard(fixture.ctx, {
        code: 'gc-1001',
        amountCents: 9_900,
        issuedOn: '2026-03-02',
      }),
    ).rejects.toBeInstanceOf(AppointmentError)
  })
})

describe('what the books say afterwards (Phase 29)', () => {
  it('reconciles the cards against the balance sheet', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor' })

    await sellGiftCard(fixture.ctx, { code: 'A', amountCents: 5_000, issuedOn: '2026-03-01' })
    await sellGiftCard(fixture.ctx, { code: 'B', amountCents: 2_500, issuedOn: '2026-03-02' })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 2_000,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })
    await redeemGiftCard(fixture.ctx, {
      code: 'A',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    const position = await giftCardPosition(fixture.ctx)

    expect(position.issuedCents).toBe(7_500)
    expect(position.outstandingCents).toBe(5_500)
    expect(position.ledgerCents).toBe(5_500)
    expect(position.agrees).toBe(true)
    expect(position.cardsIssued).toBe(2)
    expect(position.cardsWithBalance).toBe(2)
  })

  it('catches a hand-written entry against the gift card account', async () => {
    const fixture = await salon()
    await sellGiftCard(fixture.ctx, { code: 'A', amountCents: 5_000, issuedOn: '2026-03-01' })

    // Somebody journals straight at 2590 without touching a card. This is
    // exactly what the reconciliation is for: the two sides are maintained by
    // different code, so only one of them moved.
    const outstanding = await accountByNumber(
      fixture.companyId,
      APPOINTMENT_ACCOUNTS.giftCardsOutstanding,
    )
    const bank = await accountByNumber(fixture.companyId, '1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-15',
      memo: 'Refunded a card in cash, badly',
      lines: [
        { chartAccountId: outstanding!.id, debitCents: 1_000 },
        { chartAccountId: bank!.id, creditCents: 1_000 },
      ],
    })

    const position = await giftCardPosition(fixture.ctx)
    expect(position.outstandingCents).toBe(5_000)
    expect(position.ledgerCents).toBe(4_000)
    expect(position.differenceCents).toBe(1_000)
    expect(position.agrees).toBe(false)
  })

  it('says what each practitioner is owed, and what has been paid out', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })
    const rae = await addPractitioner(fixture.ctx, { name: 'Rae Lindqvist', commissionBp: 5_000 })

    for (const [practitionerId, hour, price] of [
      [sam.id, 10, 6_500],
      [sam.id, 11, 4_000],
      [rae.id, 10, 8_000],
    ] as const) {
      const appointment = await book(fixture.ctx, {
        practitionerId,
        startsAt: APRIL(hour),
        endsAt: APRIL(hour + 1),
        priceCents: price,
      })
      await completeAppointment(fixture.ctx, {
        appointmentId: appointment.id,
        completedOn: '2026-04-01',
      })
    }

    const before = await payoutPosition(fixture.ctx)
    // Sam: 45% of £105. Rae: 50% of £80.
    expect(before.earnedCents).toBe(4_725 + 4_000)
    expect(before.ledgerCents).toBe(8_725)
    expect(before.agrees).toBe(true)
    expect(before.perPractitioner[0].name).toBe('Sam Okafor')
    expect(before.perPractitioner[0].earnedCents).toBe(4_725)
    expect(before.perPractitioner[0].appointments).toBe(2)

    // Payday. Deliberately an ordinary journal entry and no part of this
    // module: money has to be able to leave 2320 by a door this file does not
    // control, or the reconciliation is comparing a figure with itself.
    const owed = await accountByNumber(fixture.companyId, APPOINTMENT_ACCOUNTS.practitionerPayable)
    const bank = await accountByNumber(fixture.companyId, '1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-30',
      memo: 'Paid Sam for April',
      lines: [
        { chartAccountId: owed!.id, debitCents: 4_725 },
        { chartAccountId: bank!.id, creditCents: 4_725 },
      ],
    })

    const after = await payoutPosition(fixture.ctx)
    expect(after.earnedCents).toBe(8_725)
    expect(after.ledgerCents).toBe(4_000)
    expect(after.paidOutCents).toBe(4_725)
    // Disagreement here is the point of the number, not a fault.
    expect(after.agrees).toBe(false)
  })

  it('keeps the forward book out of revenue', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

    const delivered = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: delivered.id,
      completedOn: '2026-04-01',
    })

    // Three more in the diary, unseen.
    for (const hour of [12, 13, 14]) {
      await book(fixture.ctx, {
        practitionerId: sam.id,
        startsAt: APRIL(hour),
        endsAt: APRIL(hour + 1),
        priceCents: 10_000,
      })
    }

    const summary = await diarySummary(fixture.ctx)
    expect(summary.deliveredCents).toBe(6_500)
    expect(summary.bookedCents).toBe(30_000)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    // £65, not £365. A diary is not a sales ledger.
    expect(pl.revenue.totalCents).toBe(6_500)
  })

  it('posts a delivered visit as one balanced entry', async () => {
    const fixture = await salon()
    const sam = await addPractitioner(fixture.ctx, {
      name: 'Sam Okafor',
      commissionBp: 4_500,
      productCommissionBp: 1_000,
    })

    const appointment = await book(fixture.ctx, {
      practitionerId: sam.id,
      startsAt: APRIL(10),
      endsAt: APRIL(11),
      priceCents: 6_500,
      productCents: 2_000,
    })
    await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    const entries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.source, 'appointment'),
        ),
      )
    expect(entries).toHaveLength(1)

    const lines = await db
      .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entries[0].id))

    // Receivable, service, retail, the share as a cost, the share as a debt.
    expect(lines).toHaveLength(5)

    const debits = lines.reduce((sum, line) => sum + line.debit, 0)
    const credits = lines.reduce((sum, line) => sum + line.credit, 0)
    expect(debits).toBe(credits)
    expect(debits).toBe(8_500 + 3_125)
  })
})
