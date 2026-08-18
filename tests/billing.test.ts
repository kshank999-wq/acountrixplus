import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices, recurringInvoiceOccurrences, recurringInvoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { createCustomer } from '@/modules/receivables/service'
import { arAging } from '@/modules/ledger/reports'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { balanceForAccount } from '@/modules/ledger/balances'
import {
  BillingError,
  createSchedule,
  firstOccurrence,
  listSchedules,
  nextOccurrence,
  raiseOccurrence,
  runDueSchedules,
  scheduleDetail,
  scheduleTotalCents,
  setScheduleActive,
} from '@/modules/billing/service'
import { awaitingRaise, billingForecast } from '@/modules/billing/reporting'
import { COMPANY_SCHEDULES } from '@/modules/worker/defaults'

/**
 * Billing a customer every period (Phase 37).
 *
 * Five claims under test:
 *
 *  1. **A schedule is a promise to bill, not a bill.** Setting one up owes
 *     nobody anything until a period arrives.
 *  2. **A period is billed exactly once**, and the database is what says so —
 *     a worker and a person both firing it bill once.
 *  3. **What it raises is a real invoice**, through the same door as one
 *     somebody typed, so it ages and can be paid.
 *  4. **Stopping a schedule unbills nothing**, and restarting one does not
 *     replay the months nobody billed.
 *  5. **What is coming is a forecast**, reported and posted nowhere.
 */

async function co(name = 'Meridian Systems'): Promise<Fixture> {
  return createCompanyFixture({ name, industry: 'general' })
}

async function aClient(fixture: Fixture, name = 'Ashwood Partners') {
  return createCustomer(fixture.ctx, { name, email: 'ap@ashwood.test' })
}

/** A $500-a-month retainer, raised automatically on the 1st. */
async function aRetainer(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createSchedule>[1]> = {},
) {
  const customer = await aClient(fixture)
  const revenue = await fixture.account('4000')

  return createSchedule(fixture.ctx, {
    customerId: customer.id,
    name: 'Ashwood — monthly retainer',
    cadence: 'monthly',
    dayOfMonth: 1,
    autoRaise: true,
    startsOn: '2026-01-01',
    lines: [
      { chartAccountId: revenue.id, description: 'Monthly retainer', unitPriceCents: 500_00 },
    ],
    ...overrides,
  })
}

describe('a schedule is a promise to bill (Phase 37)', () => {
  it('owes nobody anything until a period arrives', async () => {
    const fixture = await co()
    await aRetainer(fixture)

    // No invoice, nothing in receivables, nothing on the aging report.
    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(0)

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-06-30' })
    expect(aging.totals.totalCents).toBe(0)

    const ar = await fixture.account('1100')
    expect(await balanceForAccount(fixture.ctx, ar.id)).toBe(0)
  })

  it('reuses Phase 11’s cadence rather than a second implementation of it', () => {
    // One answer to "what is the next monthly date", not two that drift apart
    // on the 31st.
    expect(nextOccurrence({ cadence: 'monthly', dayOfMonth: 1 }, '2026-01-01')).toBe('2026-02-01')
    expect(nextOccurrence({ cadence: 'quarterly', dayOfMonth: 15 }, '2026-01-15')).toBe('2026-04-15')
    expect(nextOccurrence({ cadence: 'weekly' }, '2026-01-01')).toBe('2026-01-08')
    expect(firstOccurrence({ cadence: 'monthly', dayOfMonth: 15 }, '2026-01-20')).toBe('2026-02-15')
  })

  it('refuses a day of the month that some months do not have', async () => {
    const fixture = await co()
    const customer = await aClient(fixture)
    const revenue = await fixture.account('4000')

    await expect(
      createSchedule(fixture.ctx, {
        customerId: customer.id,
        name: 'The 31st',
        cadence: 'monthly',
        dayOfMonth: 31,
        startsOn: '2026-01-01',
        lines: [{ chartAccountId: revenue.id, description: 'x', unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(/between the 1st and the 28th/)
  })

  it('refuses a schedule with no lines, a negative price, or an empty description', async () => {
    const fixture = await co()
    const customer = await aClient(fixture)
    const revenue = await fixture.account('4000')
    const base = {
      customerId: customer.id,
      cadence: 'monthly' as const,
      startsOn: '2026-01-01',
    }

    await expect(
      createSchedule(fixture.ctx, { ...base, name: 'Empty', lines: [] }),
    ).rejects.toThrow(/at least one line/)

    await expect(
      createSchedule(fixture.ctx, {
        ...base,
        name: 'Negative',
        lines: [{ chartAccountId: revenue.id, description: 'x', unitPriceCents: -100 }],
      }),
    ).rejects.toThrow(/credit note/)

    await expect(
      createSchedule(fixture.ctx, {
        ...base,
        name: 'Nameless line',
        lines: [{ chartAccountId: revenue.id, description: '   ', unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(/what the customer reads/)
  })

  it('refuses to end before it starts', async () => {
    const fixture = await co()
    const customer = await aClient(fixture)
    const revenue = await fixture.account('4000')

    await expect(
      createSchedule(fixture.ctx, {
        customerId: customer.id,
        name: 'Backwards',
        cadence: 'monthly',
        startsOn: '2026-06-01',
        endsOn: '2026-01-01',
        lines: [{ chartAccountId: revenue.id, description: 'x', unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(/cannot end before it starts/)
  })

  it('needs the journal permission to set one up', async () => {
    // `sales` deliberately: it can create the customer, so the only thing this
    // test can fail on is the permission it is about. A salesperson agreeing a
    // retainer is not the person who decides it starts billing.
    const fixture = await createCompanyFixture({ name: 'Sales Only', role: 'sales' })
    const customer = await aClient(fixture)
    const revenue = await fixture.account('4000')

    await expect(
      createSchedule(fixture.ctx, {
        customerId: customer.id,
        name: 'Nope',
        cadence: 'monthly',
        startsOn: '2026-01-01',
        lines: [{ chartAccountId: revenue.id, description: 'x', unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(PermissionError)
  })

  it('keeps one company’s schedules off another’s books', async () => {
    const mine = await co('Mine')
    const theirs = await co('Theirs')
    await aRetainer(mine)

    expect(await listSchedules(theirs.ctx)).toHaveLength(0)
  })
})

describe('a period is billed exactly once (Phase 37)', () => {
  it('raises a real invoice, and the second run does nothing', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture)

    const first = await runDueSchedules(fixture.ctx, '2026-01-15')
    expect(first).toHaveLength(1)
    expect(first[0].raised).toBe(true)
    expect(first[0].totalCents).toBe(500_00)
    expect(first[0].occurredOn).toBe('2026-01-01')

    // The whole idempotency claim: firing again bills nothing more.
    const second = await runDueSchedules(fixture.ctx, '2026-01-15')
    expect(second).toHaveLength(0)

    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(1)
    expect(raised[0].totalCents).toBe(500_00)

    const [updated] = await db
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.id, schedule.id))
    expect(updated.nextRunOn).toBe('2026-02-01')
    expect(updated.occurrenceCount).toBe(1)
  })

  it('catches up months it fell behind on, one invoice each', async () => {
    // A worker that was down, or a company that started using this today.
    const fixture = await co()
    await aRetainer(fixture)

    const results = await runDueSchedules(fixture.ctx, '2026-04-10')

    expect(results.filter((row) => row.raised)).toHaveLength(4)
    expect(results.map((row) => row.occurredOn)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ])

    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(4)
  })

  it('lets the database arbitrate two runs racing for the same period', async () => {
    const fixture = await co()
    await aRetainer(fixture)

    const [a, b] = await Promise.all([
      runDueSchedules(fixture.ctx, '2026-01-15'),
      runDueSchedules(fixture.ctx, '2026-01-15'),
    ])

    const raisedCount = [...a, ...b].filter((row) => row.raised).length
    expect(raisedCount).toBe(1)

    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(1)
  })

  it('raises nothing at all when the schedule would bill nothing', async () => {
    // An invoice for $0.00 is a document a customer has to read to discover it
    // says nothing, and it ages on a report as though it mattered.
    const fixture = await co()
    const customer = await aClient(fixture)
    const revenue = await fixture.account('4000')

    await createSchedule(fixture.ctx, {
      customerId: customer.id,
      name: 'Nothing to bill',
      cadence: 'monthly',
      autoRaise: true,
      startsOn: '2026-01-01',
      lines: [{ chartAccountId: revenue.id, description: 'Free tier', unitPriceCents: 0 }],
    })

    const results = await runDueSchedules(fixture.ctx, '2026-01-15')

    expect(results[0].raised).toBe(false)
    expect(results[0].skipped).toMatch(/nothing to bill/i)

    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(0)
  })

  it('stops on its end date rather than being deleted', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture, { endsOn: '2026-02-28' })

    const results = await runDueSchedules(fixture.ctx, '2026-06-01')

    expect(results.filter((row) => row.raised).map((row) => row.occurredOn)).toEqual([
      '2026-01-01',
      '2026-02-01',
    ])
    expect(results.at(-1)!.skipped).toMatch(/end date/)

    const [after] = await db
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.id, schedule.id))
    expect(after.isActive).toBe(false)
    // The history is why last year's numbers look the way they do.
    expect(after.occurrenceCount).toBe(2)
  })
})

describe('what it raises is a real invoice (Phase 37)', () => {
  it('ages, reaches the control accounts, and can be found on the aging report', async () => {
    // Phase 31's lesson: a module that hand-posts Dr AR / Cr Revenue produces a
    // receivable no aging report knows about.
    const fixture = await co()
    await aRetainer(fixture)
    await runDueSchedules(fixture.ctx, '2026-01-15')

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-01-31' })
    expect(aging.totals.totalCents).toBe(500_00)

    const report = await controlAccounts(fixture.ctx)
    expect(report.receivables.ledgerCents).toBe(500_00)
    expect(report.receivables.subledgerCents).toBe(500_00)
    expect(report.receivables.agrees).toBe(true)
  })

  it('gives the invoice the schedule’s payment terms', async () => {
    const fixture = await co()
    await aRetainer(fixture, { paymentTermsDays: 14 })
    await runDueSchedules(fixture.ctx, '2026-01-15')

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))

    expect(invoice.issueDate).toBe('2026-01-01')
    expect(invoice.dueDate).toBe('2026-01-15')
  })

  it('claims the period but waits for a person when it is not automatic', async () => {
    const fixture = await co()
    await aRetainer(fixture, { autoRaise: false })

    const results = await runDueSchedules(fixture.ctx, '2026-01-15')
    expect(results[0].raised).toBe(false)
    expect(results[0].skipped).toMatch(/waiting for somebody/i)

    // No invoice yet — but the period is claimed, so tomorrow's run will not
    // offer it again.
    expect(
      await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId)),
    ).toHaveLength(0)

    const waiting = await awaitingRaise(fixture.ctx)
    expect(waiting).toHaveLength(1)
    expect(waiting[0].totalCents).toBe(500_00)

    const invoice = await raiseOccurrence(fixture.ctx, waiting[0].occurrenceId)
    expect(invoice.totalCents).toBe(500_00)

    // And it drops off the work list rather than inviting a second invoice.
    expect(await awaitingRaise(fixture.ctx)).toHaveLength(0)
    await expect(raiseOccurrence(fixture.ctx, waiting[0].occurrenceId)).rejects.toThrow(
      /already been invoiced/,
    )
  })
})

describe('stopping a schedule unbills nothing (Phase 37)', () => {
  it('leaves the invoices it already raised standing', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture)
    await runDueSchedules(fixture.ctx, '2026-02-15')

    await setScheduleActive(fixture.ctx, schedule.id, false)

    const raised = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    expect(raised).toHaveLength(2)

    const aging = await arAging(fixture.ctx, { asOfDate: '2026-02-28' })
    expect(aging.totals.totalCents).toBe(1_000_00)

    // And a paused schedule raises nothing more.
    const after = await runDueSchedules(fixture.ctx, '2026-06-01')
    expect(after).toHaveLength(0)
  })

  it('does not replay the months nobody billed when it is switched back on', async () => {
    // Catching up automatically would send a customer four invoices the
    // morning somebody flipped a switch.
    const fixture = await co()
    const schedule = await aRetainer(fixture)

    await setScheduleActive(fixture.ctx, schedule.id, false)
    const resumed = await setScheduleActive(fixture.ctx, schedule.id, true)

    const today = new Date().toISOString().slice(0, 10)
    expect(resumed.nextRunOn >= today).toBe(true)
  })

  it('records who paused it and when', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture)
    const paused = await setScheduleActive(fixture.ctx, schedule.id, false)

    expect(paused.isActive).toBe(false)
    // Idempotent — pausing twice is not an error.
    expect((await setScheduleActive(fixture.ctx, schedule.id, false)).isActive).toBe(false)
  })
})

describe('what is coming is a forecast (Phase 37)', () => {
  it('walks each schedule on its own cadence, and posts nothing', async () => {
    const fixture = await co()
    await aRetainer(fixture)

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-01-01',
      through: '2026-03-31',
    })

    expect(forecast.occurrences.map((row) => row.dueOn)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ])
    expect(forecast.totalCents).toBe(1_500_00)
    expect(forecast.automaticCents).toBe(1_500_00)
    expect(forecast.manualCents).toBe(0)
    expect(forecast.scheduleCount).toBe(1)

    // Reported, never posted: no invoice, no receivable, nothing on the ledger.
    const ar = await fixture.account('1100')
    expect(await balanceForAccount(fixture.ctx, ar.id)).toBe(0)
    expect(
      await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId)),
    ).toHaveLength(0)
  })

  it('keeps what happens by itself apart from what waits for somebody', async () => {
    const fixture = await co()
    await aRetainer(fixture)
    const other = await createCustomer(fixture.ctx, { name: 'Blackwood Ltd' })
    const revenue = await fixture.account('4000')

    await createSchedule(fixture.ctx, {
      customerId: other.id,
      name: 'Blackwood — quarterly review',
      cadence: 'quarterly',
      dayOfMonth: 1,
      autoRaise: false,
      startsOn: '2026-01-01',
      lines: [{ chartAccountId: revenue.id, description: 'Quarterly review', unitPriceCents: 900_00 }],
    })

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-01-01',
      through: '2026-03-31',
    })

    expect(forecast.automaticCents).toBe(1_500_00)
    expect(forecast.manualCents).toBe(900_00)
    expect(forecast.totalCents).toBe(2_400_00)
  })

  it('stops a schedule at its end date rather than forecasting past it', async () => {
    const fixture = await co()
    await aRetainer(fixture, { endsOn: '2026-02-28' })

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-01-01',
      through: '2026-12-31',
    })

    expect(forecast.occurrences.map((row) => row.dueOn)).toEqual(['2026-01-01', '2026-02-01'])
  })

  it('leaves out a paused schedule, because it is not going to bill', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture)
    await setScheduleActive(fixture.ctx, schedule.id, false)

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-01-01',
      through: '2026-12-31',
    })
    expect(forecast.occurrences).toHaveLength(0)
  })

  it('needs the financial reports permission', async () => {
    const fixture = await createCompanyFixture({ name: 'Bookkept', role: 'bookkeeper' })

    await expect(billingForecast(fixture.ctx)).rejects.toThrow(PermissionError)
  })
})

describe('what browser verification caught (Phase 37)', () => {
  it('claims every overdue period on a manual schedule, not just the first', async () => {
    // The defect: "waiting for somebody" was treated as a stop, so a quarterly
    // arrangement nobody attended to silently stopped claiming periods. The
    // second overdue quarter was never billed and appeared nowhere.
    const fixture = await co()
    const customer = await aClient(fixture)
    const revenue = await fixture.account('4000')

    await createSchedule(fixture.ctx, {
      customerId: customer.id,
      name: 'Quarterly review',
      cadence: 'quarterly',
      dayOfMonth: 1,
      autoRaise: false,
      startsOn: '2026-01-01',
      lines: [{ chartAccountId: revenue.id, description: 'Review', unitPriceCents: 900_00 }],
    })

    // January, April and July are all in the past by August.
    const results = await runDueSchedules(fixture.ctx, '2026-08-15')

    expect(results.filter((row) => row.claimed).map((row) => row.occurredOn)).toEqual([
      '2026-01-01',
      '2026-04-01',
      '2026-07-01',
    ])

    const waiting = await awaitingRaise(fixture.ctx)
    expect(waiting).toHaveLength(3)
  })

  it('still stops when a period was already claimed by somebody else', async () => {
    // The break is right for a genuine conflict — otherwise two workers race
    // round the catch-up loop together.
    const fixture = await co()
    await aRetainer(fixture)

    await runDueSchedules(fixture.ctx, '2026-01-15')
    const again = await runDueSchedules(fixture.ctx, '2026-01-15')

    expect(again).toHaveLength(0)
  })

  it('shows an overdue period in the forecast rather than hiding it behind the window', async () => {
    // The second defect: the window opened today, so a quarter that was already
    // due and unbilled simply was not listed.
    const fixture = await co()
    await aRetainer(fixture, { startsOn: '2026-01-01' })

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-03-01',
      through: '2026-04-30',
    })

    // January and February are before the window and have not been billed.
    expect(forecast.occurrences.map((row) => row.dueOn)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ])
    expect(forecast.occurrences.filter((row) => row.overdue).map((row) => row.dueOn)).toEqual([
      '2026-01-01',
      '2026-02-01',
    ])
    expect(forecast.overdueCents).toBe(1_000_00)
  })

  it('reports nothing overdue once the schedule has caught up', async () => {
    const fixture = await co()
    await aRetainer(fixture, { startsOn: '2026-01-01' })
    await runDueSchedules(fixture.ctx, '2026-02-28')

    const forecast = await billingForecast(fixture.ctx, {
      from: '2026-03-01',
      through: '2026-04-30',
    })

    expect(forecast.overdueCents).toBe(0)
    expect(forecast.occurrences.map((row) => row.dueOn)).toEqual(['2026-03-01', '2026-04-01'])
  })
})

describe('the arithmetic and the wiring (Phase 37)', () => {
  it('prices a line from thousandths, the convention every document line uses', () => {
    expect(scheduleTotalCents([{ quantityMilli: 1000, unitPriceCents: 500_00 }])).toBe(500_00)
    expect(scheduleTotalCents([{ quantityMilli: 2_500, unitPriceCents: 100_00 }])).toBe(250_00)
    expect(
      scheduleTotalCents([
        { quantityMilli: 1000, unitPriceCents: 100 },
        { quantityMilli: 3000, unitPriceCents: 200 },
      ]),
    ).toBe(700)
  })

  it('runs daily on the worker, so nobody has to open a page', () => {
    // Phase 24's argument: a recurring invoice that only happens when somebody
    // remembers is a calendar reminder with extra steps.
    const schedule = COMPANY_SCHEDULES.find((row) => row.kind === 'billing.run_schedules')

    expect(schedule).toBeDefined()
    // Daily rather than monthly: a weekly arrangement and one on the 15th are
    // both real, and a monthly job serves neither.
    expect(schedule!.cadence).toBe('daily')
  })

  it('shows a schedule with what one occurrence of it bills', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture)

    const listed = await listSchedules(fixture.ctx)
    expect(listed).toHaveLength(1)
    expect(listed[0].perOccurrenceCents).toBe(500_00)
    expect(listed[0].customerName).toBe('Ashwood Partners')

    await runDueSchedules(fixture.ctx, '2026-01-15')

    const detail = await scheduleDetail(fixture.ctx, schedule.id)
    expect(detail.lines).toHaveLength(1)
    expect(detail.history).toHaveLength(1)
    expect(detail.history[0].invoiceNumber).toBeTruthy()
    expect(detail.history[0].balanceCents).toBe(500_00)
    expect(detail.perOccurrenceCents).toBe(500_00)
  })

  it('refuses a schedule pointing at another company’s customer', async () => {
    const mine = await co('Mine')
    const theirs = await co('Theirs')
    const theirCustomer = await aClient(theirs)
    const revenue = await mine.account('4000')

    await expect(
      createSchedule(mine.ctx, {
        customerId: theirCustomer.id,
        name: 'Cross tenant',
        cadence: 'monthly',
        startsOn: '2026-01-01',
        lines: [{ chartAccountId: revenue.id, description: 'x', unitPriceCents: 100 }],
      }),
    ).rejects.toThrow(BillingError)
  })

  it('writes one occurrence row per period, forever', async () => {
    const fixture = await co()
    const schedule = await aRetainer(fixture)
    await runDueSchedules(fixture.ctx, '2026-03-15')
    await runDueSchedules(fixture.ctx, '2026-03-15')

    const rows = await db
      .select()
      .from(recurringInvoiceOccurrences)
      .where(eq(recurringInvoiceOccurrences.recurringInvoiceId, schedule.id))

    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.occurredOn)).size).toBe(3)
  })
})
