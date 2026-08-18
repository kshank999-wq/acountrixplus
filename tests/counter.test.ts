import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customers, invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { setModuleEnabled } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { createInvoice } from '@/modules/receivables/service'
import { tenderFor, TenderError } from '@/modules/counter/tender'
import { payableInvoice, takePayment } from '@/modules/counter/service'
import { addPractitioner, book, completeAppointment } from '@/modules/appointments/service'

/**
 * Money at the counter (spec §13, Phase 32).
 *
 * Five claims under test:
 *
 *  1. **Change is not a transaction** — what is recorded is what was kept.
 *  2. **You cannot give change on a card.**
 *  3. **Cash at the counter is not in the bank**; it lands in Undeposited Funds.
 *  4. **One bill, several tenders, one settlement** — and each tender is its
 *     own payment, because each turns into a different thing later.
 *  5. **Taking the money leaves the control accounts agreeing.**
 */

const APRIL = (hour: number) => new Date(Date.UTC(2026, 3, 1, hour, 0))

async function shop(): Promise<Fixture> {
  const fixture = await createCompanyFixture({ name: 'Fenwick Row', industry: 'personal_care' })
  await setModuleEnabled(fixture.ctx, 'appointments', true)
  return fixture
}

/** A $36.50 bill owed by a named customer. */
async function aBill(fixture: Fixture, totalCents = 3_650) {
  const [client] = await db
    .insert(customers)
    .values({ companyId: fixture.companyId, name: 'Priya Raman' })
    .returning()

  const revenue = await accountByNumber(fixture.companyId, '4000')

  const invoice = await createInvoice(fixture.ctx, {
    customerId: client.id,
    issueDate: '2026-04-01',
    lines: [
      { chartAccountId: revenue!.id, description: 'A haircut', unitPriceCents: totalCents },
    ],
  })

  return { client, invoice }
}

describe('what a handful of tenders settles (Phase 32)', () => {
  it('keeps what was kept, and hands the rest back', () => {
    // $50 offered against a $36.50 bill.
    const settlement = tenderFor(3_650, [{ kind: 'cash', amountCents: 5_000 }])

    expect(settlement.appliedCents).toBe(3_650)
    expect(settlement.changeCents).toBe(1_350)
    expect(settlement.stillDueCents).toBe(0)
    expect(settlement.settled).toBe(true)

    // One applied line, for what was kept. The $50 in and $13.50 out are not
    // two events — recording them would overstate the day's takings.
    expect(settlement.applied).toEqual([
      { kind: 'cash', amountCents: 3_650, reference: null },
    ])
  })

  it('refuses to give change on a card', () => {
    expect(() => tenderFor(3_650, [{ kind: 'card', amountCents: 5_000 }])).toThrow(TenderError)

    try {
      tenderFor(3_650, [{ kind: 'card', amountCents: 5_000 }])
    } catch (error) {
      // The message has to be usable by somebody at a terminal.
      expect((error as Error).message).toContain('13.50')
      expect((error as Error).message).toContain('36.50')
    }
  })

  it('applies non-cash first so the cash carries the change', () => {
    // $20 cash and $16.50 on a card against $36.50. If cash went first the
    // card would be over-charged and cash handed back — taking money off a
    // card in order to give it back in notes.
    const settlement = tenderFor(3_650, [
      { kind: 'cash', amountCents: 2_000 },
      { kind: 'card', amountCents: 1_650, reference: '4242' },
    ])

    expect(settlement.applied[0]).toEqual({
      kind: 'card',
      amountCents: 1_650,
      reference: '4242',
    })
    expect(settlement.applied[1]).toEqual({ kind: 'cash', amountCents: 2_000, reference: null })
    expect(settlement.changeCents).toBe(0)
    expect(settlement.settled).toBe(true)
  })

  it('gives change out of the cash when the card covers part of it', () => {
    // $20 on a card and $20 cash against $36.50: the card takes its $20, the
    // cash covers $16.50, and $3.50 goes back.
    const settlement = tenderFor(3_650, [
      { kind: 'card', amountCents: 2_000 },
      { kind: 'cash', amountCents: 2_000 },
    ])

    expect(settlement.appliedCents).toBe(3_650)
    expect(settlement.changeCents).toBe(350)
    expect(settlement.applied.find((row) => row.kind === 'cash')?.amountCents).toBe(1_650)
  })

  it('leaves the rest owing when the tenders do not cover the bill', () => {
    const settlement = tenderFor(3_650, [{ kind: 'cash', amountCents: 2_000 }])

    expect(settlement.appliedCents).toBe(2_000)
    expect(settlement.stillDueCents).toBe(1_650)
    expect(settlement.changeCents).toBe(0)
    expect(settlement.settled).toBe(false)
  })

  it('collapses several notes into one payment', () => {
    // Two twenties and a ten. The books record fifty; which notes they were is
    // the till's business.
    const settlement = tenderFor(4_500, [
      { kind: 'cash', amountCents: 2_000 },
      { kind: 'cash', amountCents: 2_000 },
      { kind: 'cash', amountCents: 1_000 },
    ])

    expect(settlement.applied).toHaveLength(1)
    expect(settlement.applied[0].amountCents).toBe(4_500)
    expect(settlement.changeCents).toBe(500)
  })

  it('refuses an empty offer and a tender of nothing', () => {
    expect(() => tenderFor(3_650, [])).toThrow(TenderError)
    expect(() => tenderFor(3_650, [{ kind: 'cash', amountCents: 0 }])).toThrow(TenderError)
  })

  it('treats every non-cash kind the same way', () => {
    for (const kind of ['card', 'gift_card', 'bank_transfer', 'cheque', 'other'] as const) {
      expect(() => tenderFor(1_000, [{ kind, amountCents: 1_500 }])).toThrow(TenderError)
      expect(tenderFor(1_000, [{ kind, amountCents: 1_000 }]).settled).toBe(true)
    }
  })

  it('refuses a figure the ledger cannot hold rather than quietly zeroing it', () => {
    // A non-finite tender is nonsense, and the honest response is to refuse it.
    // Treating it as a payment of zero would settle nothing and say nothing,
    // which is the same outcome as a bug.
    expect(() =>
      tenderFor(3_650, [{ kind: 'cash', amountCents: Number.POSITIVE_INFINITY }]),
    ).toThrow(TenderError)
    expect(() => tenderFor(3_650, [{ kind: 'card', amountCents: Number.NaN }])).toThrow(TenderError)

    // A nonsense *bill* is a zero bill, so cash offered against it is all
    // change — nothing is taken, which is the safe direction to fail.
    const settlement = tenderFor(Number.NaN, [{ kind: 'cash', amountCents: 5_000 }])
    expect(settlement.appliedCents).toBe(0)
    expect(settlement.changeCents).toBe(5_000)
  })
})

describe('taking the money (Phase 32)', () => {
  it('settles the bill and leaves the cash in the drawer, not the bank', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    const result = await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 5_000 }],
    })

    expect(result.settlement.appliedCents).toBe(3_650)
    expect(result.settlement.changeCents).toBe(1_350)
    expect(result.paymentIds).toHaveLength(1)

    const [after] = await db
      .select({ balance: invoices.balanceCents, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
    expect(after.balance).toBe(0)
    expect(after.status).toBe('paid')

    // The notes are in a drawer. Saying they are in the bank makes the next
    // bank reconciliation unsolvable.
    const undeposited = await accountByNumber(fixture.companyId, '1200')
    const bank = await accountByNumber(fixture.companyId, '1000')
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(3_650)
    expect(await balanceForAccount(fixture.ctx, bank!.id)).toBe(0)

    // And the $13.50 handed back is nowhere, because it was never taken.
    const ar = await accountByNumber(fixture.companyId, '1100')
    expect(await balanceForAccount(fixture.ctx, ar!.id)).toBe(0)
  })

  it('records each tender as its own payment', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    const result = await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [
        { kind: 'cash', amountCents: 2_000 },
        { kind: 'card', amountCents: 1_650, reference: '4242' },
      ],
    })

    // Two payments, because the card one appears on a merchant statement and
    // the cash one goes in a deposit slip — a bank reconciliation has to match
    // each against the thing it turns into.
    expect(result.paymentIds).toHaveLength(2)

    const { payments } = await import('@/db/schema')
    const rows = await db
      .select({ amount: payments.amountCents, reference: payments.reference })
      .from(payments)
      .where(eq(payments.companyId, fixture.companyId))

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([1_650, 2_000])
    expect(rows.some((row) => row.reference === '4242')).toBe(true)
  })

  it('banks it directly when somebody says where', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    const { financialAccounts } = await import('@/db/schema')
    const bankAccount = await accountByNumber(fixture.companyId, '1000')
    const [account] = await db
      .insert(financialAccounts)
      .values({
        companyId: fixture.companyId,
        chartAccountId: bankAccount!.id,
        name: 'Current account',
        mask: '0001',
        kind: 'checking',
        providerAccountId: 'seed-counter-test',
      })
      .returning()

    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'bank_transfer', amountCents: 3_650 }],
      financialAccountId: account.id,
    })

    // A transfer really did land in the bank, so it does not pretend to sit in
    // a drawer.
    const undeposited = await accountByNumber(fixture.companyId, '1200')
    expect(await balanceForAccount(fixture.ctx, bankAccount!.id)).toBe(3_650)
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(0)
  })

  it('takes part of a bill and leaves the rest owing', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    const result = await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 2_000 }],
    })

    expect(result.settlement.stillDueCents).toBe(1_650)

    const [after] = await db
      .select({ balance: invoices.balanceCents, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
    expect(after.balance).toBe(1_650)
    expect(after.status).toBe('partial')

    // And the rest can be taken later.
    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-02',
      tenders: [{ kind: 'card', amountCents: 1_650 }],
    })

    const [settled] = await db
      .select({ balance: invoices.balanceCents })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
    expect(settled.balance).toBe(0)
  })

  it('refuses to take money for a bill that is already settled', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    await takePayment(fixture.ctx, {
      invoiceId: invoice.id,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 3_650 }],
    })

    await expect(
      takePayment(fixture.ctx, {
        invoiceId: invoice.id,
        receivedOn: '2026-04-01',
        tenders: [{ kind: 'cash', amountCents: 3_650 }],
      }),
    ).rejects.toBeInstanceOf(TenderError)
  })

  it('refuses a card charged for more than the bill, and takes nothing', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    await expect(
      takePayment(fixture.ctx, {
        invoiceId: invoice.id,
        receivedOn: '2026-04-01',
        tenders: [{ kind: 'card', amountCents: 5_000 }],
      }),
    ).rejects.toBeInstanceOf(TenderError)

    // Nothing was recorded — the refusal happens before any posting.
    const [after] = await db
      .select({ balance: invoices.balanceCents })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))
    expect(after.balance).toBe(3_650)

    const undeposited = await accountByNumber(fixture.companyId, '1200')
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(0)
  })

  it('needs the journal permission', async () => {
    const fixture = await shop()
    const { invoice } = await aBill(fixture)

    await expect(
      takePayment(
        { ...fixture.ctx, role: 'readonly' },
        {
          invoiceId: invoice.id,
          receivedOn: '2026-04-01',
          tenders: [{ kind: 'cash', amountCents: 3_650 }],
        },
      ),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it("keeps one shop's till out of another's", async () => {
    const a = await shop()
    const b = await shop()
    const { invoice } = await aBill(a)

    await expect(
      takePayment(b.ctx, {
        invoiceId: invoice.id,
        receivedOn: '2026-04-01',
        tenders: [{ kind: 'cash', amountCents: 3_650 }],
      }),
    ).rejects.toBeInstanceOf(TenderError)

    expect(await payableInvoice(b.ctx, invoice.id)).toBeNull()
    expect((await payableInvoice(a.ctx, invoice.id))?.balanceCents).toBe(3_650)
  })
})

describe('the counter closes the loop (Phase 32)', () => {
  it('takes payment for a visit, end to end, with the books agreeing', async () => {
    const fixture = await shop()
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

    const done = await completeAppointment(fixture.ctx, {
      appointmentId: appointment.id,
      completedOn: '2026-04-01',
    })

    // Before: the salon is owed $65 and the control accounts say so.
    const before = await controlAccounts(fixture.ctx)
    expect(before.receivables.ledgerCents).toBe(6_500)
    expect(before.receivables.agrees).toBe(true)

    // The client pays with a $70 note.
    const result = await takePayment(fixture.ctx, {
      invoiceId: done.invoiceId,
      receivedOn: '2026-04-01',
      tenders: [{ kind: 'cash', amountCents: 7_000 }],
    })

    expect(result.settlement.changeCents).toBe(500)
    expect(result.settlement.settled).toBe(true)

    // After: nothing owed, both sides still agree, and the money is in the
    // drawer. This is what three ADRs were asking for.
    const after = await controlAccounts(fixture.ctx)
    expect(after.receivables.ledgerCents).toBe(0)
    expect(after.receivables.subledgerCents).toBe(0)
    expect(after.receivables.agrees).toBe(true)

    const undeposited = await accountByNumber(fixture.companyId, '1200')
    expect(await balanceForAccount(fixture.ctx, undeposited!.id)).toBe(6_500)

    // And the practitioner is still owed their share — taking the client's
    // money does not pay the stylist.
    const owed = await accountByNumber(fixture.companyId, '2320')
    expect(await balanceForAccount(fixture.ctx, owed!.id)).toBe(2_925)
  })
})
