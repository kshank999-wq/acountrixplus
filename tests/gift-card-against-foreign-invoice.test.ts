import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, invoices, journalEntries, journalLines } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { setModuleEnabled } from '@/modules/industry/modules'
import {
  addPractitioner,
  book,
  completeAppointment,
  redeemGiftCard,
  sellGiftCard,
} from '@/modules/appointments/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'

/**
 * A gift card against the invoice it settles (Phase 142 → 151).
 *
 * ## It was a stub, and Phase 151 found that out by unskipping it
 *
 * This file was written skipped, as the acceptance test for `affords` →
 * `redeemGiftCard`. It created an invoice, asserted two ids were truthy, and
 * **never called `redeemGiftCard` at all** — so "unskip it and it says whether
 * it worked" was not true of this entry. ADR 0139's rule is that a test which
 * cannot fail for the right reason is fiction, and a skipped test is where that
 * is easiest to get away with: nothing ever runs it to find out.
 *
 * ## The euro invoice it was named for cannot happen
 *
 * `redeemGiftCard` reaches its invoice through `appointment.invoiceId`, and an
 * appointment gets one from `completeAppointment`, which calls `createInvoice`
 * with no currency. An appointment invoice is therefore always in the company's
 * own money, and the register's measured scenario — "a $600 card against a
 * €1,000 invoice carried at 1.10" — is not reachable through the only path that
 * gets there.
 *
 * The wiring was kept anyway and the file renamed in spirit rather than in
 * name: `affords` asks the right question whatever the currencies are, the
 * domestic answer is identical, and the day an appointment can be invoiced in
 * euros this is already right. What is *not* kept is the claim that it repairs
 * a live defect.
 *
 * ## What it asserts now
 *
 * The path, really run: the ledger and the subledger move together, the card
 * empties by what the ledger says it gave up, and both columns of a cleared
 * invoice reach zero.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Fenwick Row', industry: 'personal_care' })
  await setModuleEnabled(fixture.ctx, 'appointments', true)
})

const APRIL = (hour: number) => new Date(Date.UTC(2026, 3, 1, hour, 0))

async function visitWorth(priceCents: number) {
  const sam = await addPractitioner(fixture.ctx, { name: 'Sam Okafor', commissionBp: 4_500 })

  const appointment = await book(fixture.ctx, {
    practitionerId: sam.id,
    startsAt: APRIL(10),
    endsAt: APRIL(11),
    priceCents,
  })

  await completeAppointment(fixture.ctx, {
    appointmentId: appointment.id,
    completedOn: '2026-04-01',
  })

  return appointment
}

async function linesOn(number: string) {
  const [account] = await db
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, number)))

  return db
    .select({ debitCents: journalLines.debitCents, creditCents: journalLines.creditCents })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, fixture.companyId),
        eq(journalEntries.sourceType, 'gift_card_redemption'),
        eq(journalLines.chartAccountId, account.id),
      ),
    )
}

describe('a card that clears the invoice', () => {
  it('takes both columns to zero together', async () => {
    // The property `affords` exists to protect: the face balance and the
    // functional twin reach zero on the same redemption. `relieveFunctional`
    // returns the *carried* figure when the balance lands on zero rather than a
    // fresh conversion, which is what makes that possible.
    await sellGiftCard(fixture.ctx, { code: 'GC-1', amountCents: 6_500, issuedOn: '2026-03-01' })
    const appointment = await visitWorth(6_500)

    const redemption = await redeemGiftCard(fixture.ctx, {
      code: 'GC-1',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    expect(redemption.applied).toBe(true)
    expect(redemption.appliedCents).toBe(6_500)
    expect(redemption.remainingBalanceCents).toBe(0)
    expect(redemption.stillDueCents).toBe(0)

    const [row] = await db
      .select({
        balanceCents: invoices.balanceCents,
        functionalBalanceCents: invoices.functionalBalanceCents,
      })
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))

    expect(row.balanceCents).toBe(0)
    expect(row.functionalBalanceCents).toBe(0)
  })

  it('credits receivables what left the card', async () => {
    await sellGiftCard(fixture.ctx, { code: 'GC-2', amountCents: 6_500, issuedOn: '2026-03-01' })
    const appointment = await visitWorth(6_500)

    await redeemGiftCard(fixture.ctx, {
      code: 'GC-2',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    // 1100, which is what `APPOINTMENT_ACCOUNTS.receivable` names — the stub
    // this replaced asked for 1200 and would have found nothing had it ever
    // run the redemption it was written for.
    const receivable = await linesOn('1100')
    expect(receivable.length).toBe(1)
    expect(receivable[0].creditCents).toBe(6_500)
  })

  it('leaves the control account agreeing with the subledger', async () => {
    // The check that would have reported the defect nightly had it been
    // reachable: the ledger's receivable against the sum of open invoices.
    await sellGiftCard(fixture.ctx, { code: 'GC-3', amountCents: 6_500, issuedOn: '2026-03-01' })
    const appointment = await visitWorth(6_500)

    await redeemGiftCard(fixture.ctx, {
      code: 'GC-3',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    const verdict = await controlAccounts(fixture.ctx)
    expect(verdict.receivables.differenceCents).toBe(0)
    expect(verdict.agrees).toBe(true)
  })
})

describe('a card that does not clear it', () => {
  it('empties the card and leaves the rest owing', async () => {
    await sellGiftCard(fixture.ctx, { code: 'GC-4', amountCents: 5_000, issuedOn: '2026-03-01' })
    const appointment = await visitWorth(6_500)

    const redemption = await redeemGiftCard(fixture.ctx, {
      code: 'GC-4',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    expect(redemption.appliedCents).toBe(5_000)
    expect(redemption.remainingBalanceCents).toBe(0)
    expect(redemption.stillDueCents).toBe(1_500)
  })

  it('leaves what is left on a card bigger than the bill', async () => {
    // The case that caught the first version of this wiring: nesting `affords`
    // inside `redeemFor` counted the card's remainder from the face amount it
    // was handed, so a $100 card meeting a $65 visit reported nothing left.
    await sellGiftCard(fixture.ctx, { code: 'GC-5', amountCents: 10_000, issuedOn: '2026-03-01' })
    const appointment = await visitWorth(6_500)

    const redemption = await redeemGiftCard(fixture.ctx, {
      code: 'GC-5',
      appointmentId: appointment.id,
      redeemedOn: '2026-04-01',
    })

    expect(redemption.appliedCents).toBe(6_500)
    expect(redemption.remainingBalanceCents).toBe(3_500)
    expect(redemption.stillDueCents).toBe(0)
  })
})
