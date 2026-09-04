import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer } from '@/modules/receivables/service'
import {
  createSchedule,
  listSchedules,
  runDueSchedules,
  scheduleDetail,
} from '@/modules/billing/service'
import { billingForecast } from '@/modules/billing/reporting'
import { forecastTotals, occurrenceCurrency } from '@/modules/billing/currency'
import { putRate } from '@/modules/fx/service'

/**
 * A recurring schedule bills in a currency (Phase 126).
 *
 * `createInvoice` has taken one since Phase 64 and the composer offers the
 * choice, but `raiseInvoiceFor` never passed it and `recurring_invoices` had no
 * column to pass. So a European customer on a monthly retainer got dollar
 * invoices — the one invoice path in the system that could not be foreign.
 */

let fixture: Fixture
let revenueId: string
let customerId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Retainers Co' })
  revenueId = (await fixture.account('4000')).id
  customerId = (await createCustomer(fixture.ctx, { name: 'Bremen Handel GmbH' })).id

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: 1_100_000,
    source: 'manual',
  })
})

async function aSchedule(
  currency?: string,
  overrides: { name?: string; unitPriceCents?: number; autoRaise?: boolean } = {},
) {
  return createSchedule(fixture.ctx, {
    customerId,
    name: overrides.name ?? 'Monthly retainer',
    cadence: 'monthly',
    dayOfMonth: 1,
    autoRaise: overrides.autoRaise ?? true,
    startsOn: '2026-06-01',
    ...(currency ? { currency } : {}),
    lines: [
      {
        chartAccountId: revenueId,
        description: 'Retainer',
        quantityMilli: 1000,
        unitPriceCents: overrides.unitPriceCents ?? 400_000,
      },
    ],
  })
}

describe('what a schedule bills in', () => {
  it('takes the company’s own currency when nobody says otherwise', async () => {
    const schedule = await aSchedule()
    expect(schedule.currency).toBe('USD')
  })

  it('can be told to bill in the customer’s', async () => {
    const schedule = await aSchedule('EUR')
    expect(schedule.currency).toBe('EUR')
  })

  /** The defect in one assertion: this invoice was USD before Phase 126. */
  it('raises an invoice in that currency, not the company’s', async () => {
    await aSchedule('EUR')

    const results = await runDueSchedules(fixture.ctx, '2026-06-01')
    const raised = results.filter((row) => row.raised)
    expect(raised).toHaveLength(1)

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, raised[0].invoiceId!))

    expect(invoice.currency).toBe('EUR')
    // €4,000 at 1.10 — the face amount is what the customer owes, the
    // functional one is what the books carry (Phase 116's pair).
    expect(invoice.totalCents).toBe(400_000)
    expect(invoice.functionalTotalCents).toBe(440_000)
  })

  it('records the currency on the occurrence, which stored none before', async () => {
    const schedule = await aSchedule('EUR')
    await runDueSchedules(fixture.ctx, '2026-06-01')

    const detail = await scheduleDetail(fixture.ctx, schedule.id)
    expect(detail.history).not.toHaveLength(0)
    expect(detail.history[0].currency).toBe('EUR')
  })
})

describe('which currency an occurrence is shown in', () => {
  it('prefers the invoice actually raised over the schedule’s intention', () => {
    // A fact beats an intention: the customer holds the invoice.
    expect(occurrenceCurrency('EUR', 'USD', 'GBP')).toBe('EUR')
  })

  it('falls back to the schedule for a period nobody has raised yet', () => {
    expect(occurrenceCurrency(null, 'EUR', 'GBP')).toBe('EUR')
  })

  it('falls back to the company for a row written before Phase 126', () => {
    expect(occurrenceCurrency(null, null, 'GBP')).toBe('GBP')
  })
})

/**
 * The defect this phase would have introduced if it stopped at the write.
 *
 * The forecast added four figures across every active schedule, and every one
 * was sound while a schedule could only bill the company's own currency. Giving
 * it a currency is what breaks them — so they are grouped in the same commit.
 */
describe('a forecast that cannot add two currencies', () => {
  it('gives a business billing in one currency the single set it always had', () => {
    const totals = forecastTotals([
      { scheduleId: 'a', currency: 'USD', totalCents: 50_000, autoRaise: true, overdue: false },
      { scheduleId: 'b', currency: 'USD', totalCents: 90_000, autoRaise: false, overdue: true },
    ])

    expect(totals).toHaveLength(1)
    expect(totals[0]).toEqual({
      currency: 'USD',
      totalCents: 140_000,
      automaticCents: 50_000,
      manualCents: 90_000,
      overdueCents: 90_000,
      scheduleCount: 2,
    })
  })

  it('counts one schedule once however many periods it bills', () => {
    const totals = forecastTotals([
      { scheduleId: 'a', currency: 'EUR', totalCents: 400_000, autoRaise: true, overdue: false },
      { scheduleId: 'a', currency: 'EUR', totalCents: 400_000, autoRaise: true, overdue: false },
    ])

    expect(totals[0].totalCents).toBe(800_000)
    expect(totals[0].scheduleCount).toBe(1)
  })

  it('reports two currencies as two answers, never as a third number', () => {
    const totals = forecastTotals([
      { scheduleId: 'a', currency: 'USD', totalCents: 200_000, autoRaise: true, overdue: false },
      { scheduleId: 'b', currency: 'EUR', totalCents: 400_000, autoRaise: true, overdue: false },
    ])

    expect(totals.map((row) => row.currency)).toEqual(['EUR', 'USD'])
    expect(totals.map((row) => row.totalCents)).toEqual([400_000, 200_000])
    // The number a flat `reduce` would have produced, and which means nothing.
    expect(totals.some((row) => row.totalCents === 600_000)).toBe(false)
  })

  it('splits a real forecast the same way, off the database', async () => {
    await aSchedule('EUR', { name: 'Bremen retainer' })
    await aSchedule(undefined, { name: 'Domestic retainer', unitPriceCents: 200_000 })

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-06-01',
      through: '2026-06-30',
    })

    expect(forecast.totals.map((row) => [row.currency, row.totalCents])).toEqual([
      ['EUR', 400_000],
      ['USD', 200_000],
    ])
    expect(forecast.scheduleCount).toBe(2)
  })

  it('tells the arrangements list what each row is denominated in', async () => {
    await aSchedule('EUR', { name: 'Bremen retainer' })

    const [row] = await listSchedules(fixture.ctx)
    expect(row.currency).toBe('EUR')
    expect(row.perOccurrenceCents).toBe(400_000)
  })
})
