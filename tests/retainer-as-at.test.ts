import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { financialAccounts, retainerApplications } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { setModuleEnabled } from '@/modules/industry/modules'
import { checkByKey } from '@/modules/integrity/register'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import {
  applyRetainer,
  receiveRetainer,
  refundRetainer,
  retainerPosition,
} from '@/modules/timebilling/billing'
import { heldAcrossAt, heldByAt, type RetainerLife } from '@/modules/timebilling/retainer-position'

/**
 * Client money, stated as at a date (Phase 112).
 *
 * ADR 0111 named `timebilling.retainers` as the clearest remaining candidate.
 * Verified by reading the code and then measuring the development books, where
 * the held figure never moved:
 *
 * ```
 * 2026-07-31  held 320000  ledger 320000  agrees
 * 2026-06-15  held 320000  ledger 500000  DIFFERS
 * 2026-04-30  held 320000  ledger      0  DIFFERS
 * ```
 *
 * It is a **fault**, so $5,000 of client money read as broken books in May and
 * $3,200 read as held a month before the client had sent anything.
 *
 * The repair needed a column. A draw works out what actually left the
 * liability, posts it, and wrote only the client-currency amount onto the
 * application row — and it is *not* derivable after the fact, because
 * `relieveFunctional` gives the final draw the whole remaining functional
 * balance so nothing is left holding a stranded cent. That makes a draw's
 * functional amount depend on the balance at that moment, which is the history
 * being reconstructed.
 */

describe('one retainer through its whole life', () => {
  const life = (over: Partial<RetainerLife> = {}): RetainerLife => ({
    receivedOn: '2026-05-01',
    openingCents: 500_000,
    draws: [],
    returns: [],
    ...over,
  })

  it('holds nothing before the money arrived', () => {
    expect(heldByAt(life(), '2026-04-30')).toBe(0)
  })

  it('holds the whole amount from the day it arrived', () => {
    // Inclusive: `receiveRetainer` posts with `entryDate: receivedOn`, so the
    // ledger as at that day already carries the liability.
    expect(heldByAt(life(), '2026-05-01')).toBe(500_000)
  })

  it('comes down on the day of a draw, not the day after', () => {
    const drawn = life({ draws: [{ on: '2026-06-20', carriedCents: 180_000 }] })

    expect(heldByAt(drawn, '2026-06-19')).toBe(500_000)
    expect(heldByAt(drawn, '2026-06-20')).toBe(320_000)
  })

  it('comes down again when some is given back', () => {
    const both = life({
      draws: [{ on: '2026-06-20', carriedCents: 180_000 }],
      returns: [{ on: '2026-08-01', carriedCents: 320_000 }],
    })

    expect(heldByAt(both, '2026-07-31')).toBe(320_000)
    expect(heldByAt(both, '2026-08-01')).toBe(0)
  })

  it('counts the draws in whatever order they arrive', () => {
    // The rows come back in no particular order, and a date filter is not a
    // sort — asserted rather than assumed.
    const shuffled = life({
      draws: [
        { on: '2026-08-01', carriedCents: 100_000 },
        { on: '2026-05-15', carriedCents: 50_000 },
        { on: '2026-06-20', carriedCents: 30_000 },
      ],
    })

    expect(heldByAt(shuffled, '2026-06-30')).toBe(420_000)
  })
})

describe('the whole firm at a date', () => {
  it('counts only the retainers that were holding something', () => {
    // The count comes from the same walk as the total: "how much are we
    // holding" and "on how many retainers" are one question asked two ways.
    const lives: RetainerLife[] = [
      { receivedOn: '2026-01-10', openingCents: 200_000, draws: [], returns: [] },
      {
        receivedOn: '2026-02-01',
        openingCents: 100_000,
        draws: [{ on: '2026-03-01', carriedCents: 100_000 }],
        returns: [],
      },
      { receivedOn: '2026-07-01', openingCents: 400_000, draws: [], returns: [] },
    ]

    const february = heldAcrossAt(lives, '2026-02-15')
    expect(february).toEqual({ heldCents: 300_000, openCount: 2 })

    // The second ran to zero in March, and the third had not arrived.
    const april = heldAcrossAt(lives, '2026-04-30')
    expect(april).toEqual({ heldCents: 200_000, openCount: 1 })

    const august = heldAcrossAt(lives, '2026-08-31')
    expect(august).toEqual({ heldCents: 600_000, openCount: 2 })
  })

  it('holds nothing, on nothing, before any of them arrived', () => {
    const lives: RetainerLife[] = [
      { receivedOn: '2026-01-10', openingCents: 200_000, draws: [], returns: [] },
    ]

    expect(heldAcrossAt(lives, '2025-12-31')).toEqual({ heldCents: 0, openCount: 0 })
  })
})

describe('client money against the ledger, at a date', () => {
  let fixture: Fixture
  let bankId: string
  let customerId: string
  let revenueId: string

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Harbour Row Advisers' })
    await setModuleEnabled(fixture.ctx, 'time_billing', true)

    const [bank] = await db
      .select()
      .from(financialAccounts)
      .where(eq(financialAccounts.companyId, fixture.companyId))
      .limit(1)
    bankId = bank.id
    customerId = (await createCustomer(fixture.ctx, { name: 'Ashwood Partners' })).id
    revenueId = (await fixture.account('4100')).id
  })

  const anInvoice = async (cents: number, issueDate: string) =>
    createInvoice(fixture.ctx, {
      customerId,
      issueDate,
      dueDate: issueDate,
      lines: [{ chartAccountId: revenueId, description: 'Stage 1', unitPriceCents: cents }],
    })

  it('walks both sides back together', async () => {
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId,
      receivedOn: '2026-05-01',
      amountCents: 500_000,
      financialAccountId: bankId,
    })
    const invoice = await anInvoice(180_000, '2026-06-20')
    await applyRetainer(fixture.ctx, {
      retainerId: retainer.id,
      invoiceId: invoice.id,
      appliedOn: '2026-06-20',
    })

    // Before this phase the held figure was 320000 at every one of these.
    for (const [asOf, expected] of [
      ['2026-04-30', 0],
      ['2026-05-01', 500_000],
      ['2026-06-19', 500_000],
      ['2026-06-20', 320_000],
      ['2026-09-03', 320_000],
    ] as const) {
      const position = await retainerPosition(fixture.ctx, { asOf })
      expect(position.heldCents, asOf).toBe(expected)
      expect(position.ledgerCents, asOf).toBe(expected)
    }
  })

  it('counts the open retainers as at the date too', async () => {
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId,
      receivedOn: '2026-05-01',
      amountCents: 500_000,
      financialAccountId: bankId,
    })
    const invoice = await anInvoice(500_000, '2026-06-20')
    await applyRetainer(fixture.ctx, {
      retainerId: retainer.id,
      invoiceId: invoice.id,
      appliedOn: '2026-06-20',
    })

    expect((await retainerPosition(fixture.ctx, { asOf: '2026-04-30' })).openCount).toBe(0)
    expect((await retainerPosition(fixture.ctx, { asOf: '2026-06-19' })).openCount).toBe(1)
    // Drawn to nothing: still a row, holding nothing.
    expect((await retainerPosition(fixture.ctx, { asOf: '2026-06-20' })).openCount).toBe(0)
  })

  it('puts money given back where the ledger puts it', async () => {
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId,
      receivedOn: '2026-05-01',
      amountCents: 500_000,
      financialAccountId: bankId,
    })
    await refundRetainer(fixture.ctx, {
      retainerId: retainer.id,
      amountCents: 200_000,
      financialAccountId: bankId,
      refundedOn: '2026-07-15',
    })

    const before = await retainerPosition(fixture.ctx, { asOf: '2026-07-14' })
    const after = await retainerPosition(fixture.ctx, { asOf: '2026-07-15' })

    expect(before.heldCents).toBe(500_000)
    expect(before.ledgerCents).toBe(500_000)
    expect(after.heldCents).toBe(300_000)
    expect(after.ledgerCents).toBe(300_000)
  })

  it('answers the same undated as it does for today', async () => {
    // The nightly run passes today; nothing about it changes.
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId,
      receivedOn: '2026-05-01',
      amountCents: 500_000,
      financialAccountId: bankId,
    })
    const invoice = await anInvoice(180_000, '2026-06-20')
    await applyRetainer(fixture.ctx, {
      retainerId: retainer.id,
      invoiceId: invoice.id,
      appliedOn: '2026-06-20',
    })

    const undated = await retainerPosition(fixture.ctx)
    const today = await retainerPosition(fixture.ctx, { asOf: '2026-09-03' })

    expect(undated.heldCents).toBe(today.heldCents)
    expect(undated.openCount).toBe(today.openCount)
  })

  it('keeps the functional figure a draw works out', async () => {
    // The column this phase added. Without it the row says only what the
    // client's currency did, and the money the liability gave up is gone.
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId,
      receivedOn: '2026-05-01',
      amountCents: 500_000,
      financialAccountId: bankId,
    })
    const invoice = await anInvoice(180_000, '2026-06-20')
    await applyRetainer(fixture.ctx, {
      retainerId: retainer.id,
      invoiceId: invoice.id,
      appliedOn: '2026-06-20',
    })

    const [row] = await db
      .select()
      .from(retainerApplications)
      .where(eq(retainerApplications.retainerId, retainer.id))

    expect(row.amountCents).toBe(180_000)
    expect(row.carriedCents).toBe(180_000)
  })

  it('keeps a euro draw at the rate the liability is carried at', async () => {
    // The case that makes the column necessary rather than merely tidy: the
    // amount and the carried figure are two different numbers.
    await putRate(fixture.ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-05-01',
      rateMillionths: 1_100_000,
    })
    const retainer = await receiveRetainer(fixture.ctx, {
      customerId,
      receivedOn: '2026-05-01',
      amountCents: 100_000,
      currency: 'EUR',
      financialAccountId: bankId,
    })

    // €1,000 at 1.10 is $1,100 on the books from the day it arrived.
    expect((await retainerPosition(fixture.ctx, { asOf: '2026-05-01' })).heldCents).toBe(110_000)
    expect((await retainerPosition(fixture.ctx, { asOf: '2026-04-30' })).heldCents).toBe(0)
  })

  it('reaches any date, and says what makes that possible', () => {
    const check = checkByKey('timebilling.retainers')!

    expect(check.asAt.reach).toBe('any_date')
    expect(check.asAt.because).toContain('carried_cents')
    expect(check.asAt.because).toContain('refunded_on')
  })
})
