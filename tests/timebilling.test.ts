import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { projects, timeEntries } from '@/db/schema'
import { createCompanyFixture, addUserWithRole, type Fixture } from './helpers'
import {
  amountForMinutes,
  billableAmountCents,
  formatMinutes,
  minutesToQuantityMilli,
  parseDuration,
  resolveRate,
  utilization,
} from '@/modules/timebilling/rates'
import {
  approveTime,
  logTime,
  rateForEntry,
  recordBillableExpense,
  setPersonRate,
  setProjectRate,
  submitTime,
  timesheet,
  unbilledWork,
  updateTime,
  utilizationReport,
  writeOffTime,
} from '@/modules/timebilling/service'
import {
  AlreadyBilledError,
  billWork,
  groupTimeIntoLines,
  listRetainers,
  previewBilling,
  receiveRetainer,
  applyRetainer,
} from '@/modules/timebilling/billing'
import { createCustomer } from '@/modules/receivables/service'
import { trialBalance } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'
import { setModuleEnabled } from '@/modules/industry/modules'

/**
 * Time and expense billing (spec §5, Professional Services).
 *
 * The claim under test: **an hour is billed once, or not at all.** The rate
 * block is the arithmetic it depends on; the rest are ways it could fail.
 */

async function firmFixture(): Promise<
  Fixture & { projectId: string; customerId: string }
> {
  const fixture = await createCompanyFixture({ industry: 'professional_services' })
  await setModuleEnabled(fixture.ctx, 'time_billing', true)

  const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

  const [project] = await db
    .insert(projects)
    .values({
      companyId: fixture.companyId,
      code: 'HARBOR-01',
      name: 'Harborview restructuring',
    })
    .returning()

  return { ...fixture, projectId: project.id, customerId: customer.id }
}

describe('what an hour is worth', () => {
  it('takes the most specific rate that exists', () => {
    expect(
      resolveRate({
        entryRateCents: 20_000,
        projectPersonRateCents: 17_500,
        projectRateCents: 15_000,
        personRateCents: 18_000,
        itemRateCents: 12_000,
      }),
    ).toEqual({ rateCents: 20_000, source: 'entry' })

    expect(
      resolveRate({ projectPersonRateCents: 17_500, personRateCents: 18_000 }),
    ).toEqual({ rateCents: 17_500, source: 'project_person' })

    expect(resolveRate({ personRateCents: 18_000, itemRateCents: 12_000 })).toEqual({
      rateCents: 18_000,
      source: 'person',
    })

    expect(resolveRate({})).toEqual({ rateCents: 0, source: 'none' })
  })

  it('treats zero as a rate and null as the absence of one', () => {
    // A pro-bono hour billed at nothing is a decision somebody made. `||`
    // would fall through and charge for it.
    expect(resolveRate({ entryRateCents: 0, personRateCents: 18_000 })).toEqual({
      rateCents: 0,
      source: 'entry',
    })
    expect(resolveRate({ entryRateCents: null, personRateCents: 18_000 })).toEqual({
      rateCents: 18_000,
      source: 'person',
    })
  })

  it('computes money from minutes, not from displayed hours', () => {
    // Ten minutes at $90/hour is $15.00. Via a rounded 0.167 hours it is
    // $15.03, and forty of those on one invoice is a client query.
    expect(amountForMinutes(10, 9_000)).toBe(1_500)
    expect(minutesToQuantityMilli(10)).toBe(167)
    expect(Math.round((minutesToQuantityMilli(10) * 9_000) / 1000)).toBe(1_503)

    expect(amountForMinutes(90, 15_000)).toBe(22_500)
    expect(amountForMinutes(0, 15_000)).toBe(0)
  })

  it('parses what people actually type into a timesheet', () => {
    for (const input of ['1.5', '1:30', '90m', '1h30', '1h 30m', '1h30m']) {
      expect(parseDuration(input)).toBe(90)
    }
    expect(parseDuration('2')).toBe(120)
    expect(parseDuration('45m')).toBe(45)
    expect(parseDuration('2h')).toBe(120)
    expect(parseDuration('0:15')).toBe(15)

    // Nonsense returns null so the form can say so rather than logging a
    // number nobody meant.
    expect(parseDuration('lunch')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })

  it('formats a duration the way people read it', () => {
    expect(formatMinutes(90)).toBe('1h 30m')
    expect(formatMinutes(120)).toBe('2h')
    expect(formatMinutes(45)).toBe('45m')
  })

  it('marks an expense up in basis points, zero included', () => {
    expect(billableAmountCents(10_000, 0)).toBe(10_000)
    expect(billableAmountCents(10_000, 1_500)).toBe(11_500)
    expect(billableAmountCents(3_333, 1_000)).toBe(3_666)
  })

  it('measures utilization against time recorded', () => {
    const rows = utilization([
      { personId: 'a', personName: 'Ada', minutes: 300, isBillable: true },
      { personId: 'a', personName: 'Ada', minutes: 100, isBillable: false },
      { personId: 'b', personName: 'Bo', minutes: 120, isBillable: false },
    ])

    // 300 of 400 recorded, not 300 of a notional week — somebody who took
    // leave should not read as 60% utilized.
    expect(rows[0]).toMatchObject({ personName: 'Ada', utilizationBasisPoints: 7_500 })
    expect(rows[1]).toMatchObject({ personName: 'Bo', utilizationBasisPoints: 0 })
  })
})

describe('recording time', () => {
  it('posts nothing to the ledger', async () => {
    const fixture = await firmFixture()

    await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 210,
      description: 'Reviewed the group structure',
    })

    // Unbilled time is not revenue, and booking profit on your own labour
    // before anybody is billed is what flatters a firm into insolvency.
    const balances = await trialBalance(fixture.ctx, { endDate: '2026-04-30' })
    expect(balances.rows).toHaveLength(0)
  })

  it('insists on a description', async () => {
    const fixture = await firmFixture()

    await expect(
      logTime(fixture.ctx, { workedOn: '2026-04-06', minutes: 60, description: '   ' }),
    ).rejects.toThrow(/Say what the time was for/)
  })

  it('refuses more than a day', async () => {
    const fixture = await firmFixture()

    // Usually a value meant as hours, entered as minutes.
    await expect(
      logTime(fixture.ctx, { workedOn: '2026-04-06', minutes: 4_800, description: 'Long day' }),
    ).rejects.toThrow(/more than a day/)
  })

  it('moves through draft, submitted, approved', async () => {
    const fixture = await firmFixture()

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 120,
      description: 'Drafting',
    })
    expect(entry.status).toBe('draft')

    expect(await submitTime(fixture.ctx, [entry.id])).toBe(1)
    expect(await approveTime(fixture.ctx, [entry.id])).toBe(1)

    const rows = await timesheet(fixture.ctx)
    expect(rows[0].status).toBe('approved')
  })

  it('will not let billed time be edited', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 120,
      description: 'Drafting',
    })
    await approveTime(fixture.ctx, [entry.id])
    await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    // An invoice has gone to a client. Editing the hours behind it would make
    // the timesheet and the document disagree about what was charged for.
    await expect(
      updateTime(fixture.ctx, entry.id, { minutes: 60 }),
    ).rejects.toThrow(/credit note/)
  })

  it('keeps written-off time, with a reason', async () => {
    const fixture = await firmFixture()

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 180,
      description: 'Re-doing the model after a spec change',
    })

    await expect(writeOffTime(fixture.ctx, [entry.id], '  ')).rejects.toThrow(/Say why/)

    expect(await writeOffTime(fixture.ctx, [entry.id], 'Over-run, not the client’s fault')).toBe(1)

    // Kept, not deleted: an hour given away is a fact about the engagement's
    // profitability, and deleting it makes every job look better than it was.
    const rows = await timesheet(fixture.ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('written_off')
  })
})

describe('an hour is billed once, or not at all', () => {
  async function approvedHours(fixture: Awaited<ReturnType<typeof firmFixture>>) {
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const ids: string[] = []
    for (const [workedOn, minutes] of [
      ['2026-04-06', 210],
      ['2026-04-07', 90],
      ['2026-04-08', 120],
    ] as const) {
      const entry = await logTime(fixture.ctx, {
        projectId: fixture.projectId,
        workedOn,
        minutes,
        description: 'Restructuring advice',
      })
      ids.push(entry.id)
    }

    await approveTime(fixture.ctx, ids)
    return ids
  }

  it('charges the client once when two people bill at the same moment', async () => {
    const fixture = await firmFixture()
    await approvedHours(fixture)

    // Both prepare an invoice from the same unbilled rows. Only one update
    // finds them still approved and unbilled; the loser rolls back entire.
    const results = await Promise.allSettled([
      billWork(fixture.ctx, {
        projectId: fixture.projectId,
        customerId: fixture.customerId,
        issueDate: '2026-04-30',
      }),
      billWork(fixture.ctx, {
        projectId: fixture.projectId,
        customerId: fixture.customerId,
        issueDate: '2026-04-30',
      }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    // And nothing of the loser survives — no half-invoice, no orphan lines.
    const { listInvoices } = await import('@/modules/receivables/service')
    expect(await listInvoices(fixture.ctx)).toHaveLength(1)

    const rows = await timesheet(fixture.ctx)
    expect(rows.every((row) => row.status === 'billed')).toBe(true)
  })

  it('bills nothing twice on a second attempt', async () => {
    const fixture = await firmFixture()
    await approvedHours(fixture)

    await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    await expect(
      billWork(fixture.ctx, {
        projectId: fixture.projectId,
        customerId: fixture.customerId,
        issueDate: '2026-05-31',
      }),
    ).rejects.toThrow(/no approved, unbilled work/)
  })

  it('reports what it billed, and the invoice foots to it', async () => {
    const fixture = await firmFixture()
    await approvedHours(fixture)

    const preview = await previewBilling(fixture.ctx, { projectId: fixture.projectId })
    // 420 minutes at $150 = 7 hours = $1,050.
    expect(preview.timeCents).toBe(105_000)

    const result = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    expect(result.invoice.totalCents).toBe(105_000)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
    expect(pl.revenue.totalCents).toBe(105_000)
  })

  it('leaves unapproved and non-billable time alone', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const approved = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 60,
      description: 'Billable and approved',
    })
    await approveTime(fixture.ctx, [approved.id])

    // Never approved.
    await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-07',
      minutes: 60,
      description: 'Still a draft',
    })

    // Approved but explicitly not billable.
    const internal = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-08',
      minutes: 60,
      description: 'Internal file note',
      isBillable: false,
    })
    await approveTime(fixture.ctx, [internal.id])

    const result = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    expect(result.invoice.totalCents).toBe(15_000)
    expect(result.time).toHaveLength(1)
  })

  it('honours a cut-off date', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const ids: string[] = []
    for (const workedOn of ['2026-04-28', '2026-05-02']) {
      const entry = await logTime(fixture.ctx, {
        projectId: fixture.projectId,
        workedOn,
        minutes: 60,
        description: 'Advice',
      })
      ids.push(entry.id)
    }
    await approveTime(fixture.ctx, ids)

    const result = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
      throughDate: '2026-04-30',
    })

    expect(result.time).toHaveLength(1)
    // May's hour is still there for next month.
    const unbilled = await unbilledWork(fixture.ctx)
    expect(unbilled[0].timeMinutes).toBe(60)
  })

  it('freezes the rate it was billed at', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 60,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])
    await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    // A rate rise next quarter must not restate an invoice already sent.
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 20_000 })

    const [stored] = await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.companyId, fixture.companyId), eq(timeEntries.id, entry.id)))

    expect(stored.rateCents).toBe(15_000)
    expect(stored.amountCents).toBe(15_000)
  })
})

describe('grouping the lines', () => {
  const rows = [
    {
      id: '1',
      userId: 'a',
      personName: 'Ada',
      workedOn: '2026-04-06',
      minutes: 90,
      description: 'Drafting',
      serviceItemId: null,
      rateCents: 15_000,
      amountCents: 22_500,
      rateSource: 'person',
    },
    {
      id: '2',
      userId: 'b',
      personName: 'Bo',
      workedOn: '2026-04-06',
      minutes: 60,
      description: 'Review',
      serviceItemId: null,
      rateCents: 20_000,
      amountCents: 20_000,
      rateSource: 'person',
    },
  ]

  it('adds to the same total however it is grouped', () => {
    // Grouping is presentation. Amounts are summed from the entries, never
    // recomputed from the group, so the choice cannot move the total.
    for (const grouping of ['person', 'day', 'service', 'single'] as const) {
      const lines = groupTimeIntoLines(rows, grouping)
      expect(lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(42_500)
    }
  })

  it('splits by the thing it says it splits by', () => {
    expect(groupTimeIntoLines(rows, 'person')).toHaveLength(2)
    expect(groupTimeIntoLines(rows, 'day')).toHaveLength(1)
    expect(groupTimeIntoLines(rows, 'single')).toHaveLength(1)
  })

  it('keeps the detail a client would query', () => {
    const [line] = groupTimeIntoLines(rows, 'single')
    expect(line.description).toContain('Drafting')
    expect(line.description).toContain('Review')
  })
})

describe('reimbursable expenses', () => {
  it('posts nothing, because the cost is already in the books', async () => {
    const fixture = await firmFixture()
    const travel = await fixture.account('6700')

    await recordBillableExpense(fixture.ctx, {
      projectId: fixture.projectId,
      incurredOn: '2026-04-10',
      description: 'Flights to the client site',
      costCents: 48_000,
      markupBasisPoints: 1_000,
      chartAccountId: travel.id,
    })

    // It arrived as a bank transaction or a bill and was categorized like any
    // other. Posting it again here would double the expense.
    const balances = await trialBalance(fixture.ctx, { endDate: '2026-04-30' })
    expect(balances.rows).toHaveLength(0)
  })

  it('bills at cost plus the agreed markup', async () => {
    const fixture = await firmFixture()

    await recordBillableExpense(fixture.ctx, {
      projectId: fixture.projectId,
      incurredOn: '2026-04-10',
      description: 'Flights',
      costCents: 48_000,
      markupBasisPoints: 1_000,
    })

    const result = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    expect(result.invoice.totalCents).toBe(52_800)

    // Its own revenue account, so recovered costs do not read as fee income.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
    expect(pl.revenue.rows.find((row) => row.number === '4130')?.balanceCents).toBe(52_800)
  })
})

describe('retainers', () => {
  it('is a liability on arrival, not revenue', async () => {
    const fixture = await firmFixture()

    await receiveRetainer(fixture.ctx, {
      customerId: fixture.customerId,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-04-30' })

    // The commonest error in professional-services bookkeeping is recognising
    // this on arrival, which flatters the quarter by the work still owed.
    expect(balances.rows.find((row) => row.number === '2550')?.balanceCents).toBe(500_000)
    expect(balances.rows.find((row) => row.number === '1000')?.balanceCents).toBe(500_000)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    })
    expect(pl.revenue.totalCents).toBe(0)
  })

  it('draws down against an invoice without money moving', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: fixture.customerId,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 120,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])

    const result = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
      applyRetainerId: retainer.id,
    })

    // $300 of work against a $5,000 retainer.
    expect(result.retainerAppliedCents).toBe(30_000)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-04-30' })
    expect(balances.rows.find((row) => row.number === '2550')?.balanceCents).toBe(470_000)
    // The receivable is settled and no cash moved — the cash moved in April.
    expect(balances.rows.find((row) => row.number === '1100')?.balanceCents ?? 0).toBe(0)
    expect(balances.isBalanced).toBe(true)

    const [remaining] = await listRetainers(fixture.ctx)
    expect(remaining.remainingCents).toBe(470_000)
  })

  it('never draws more than is left or more than is owed', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: fixture.customerId,
      receivedOn: '2026-04-01',
      amountCents: 10_000,
      financialAccountId: fixture.financialAccountId,
    })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 120,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])

    const result = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
      applyRetainerId: retainer.id,
    })

    // $300 of work, $100 retainer: capped at what is there. Over-drawing
    // invents money the client never paid.
    expect(result.retainerAppliedCents).toBe(10_000)
    expect(result.invoice.totalCents).toBe(30_000)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-04-30' })
    expect(balances.rows.find((row) => row.number === '1100')?.balanceCents).toBe(20_000)
    expect(balances.isBalanced).toBe(true)
  })

  it('will not draw a retainer against another client’s invoice', async () => {
    const fixture = await firmFixture()
    const other = await createCustomer(fixture.ctx, { name: 'Delta Mills' })
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: other.id,
      receivedOn: '2026-04-01',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
    })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 60,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])

    const billed = await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    await expect(
      applyRetainer(fixture.ctx, {
        retainerId: retainer.id,
        invoiceId: billed.invoice.id,
        appliedOn: '2026-04-30',
      }),
    ).rejects.toThrow(/same client/)
  })

  it('is accrual revenue only as it is earned', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const retainer = await receiveRetainer(fixture.ctx, {
      customerId: fixture.customerId,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 120,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])
    await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
      applyRetainerId: retainer.id,
    })

    const year = { startDate: '2026-01-01', endDate: '2026-12-31' } as const

    // $5,000 arrived and $300 was earned. Recognising the rest would flatter
    // the quarter by the value of work still owed.
    expect((await profitAndLoss(fixture.ctx, { ...year, basis: 'accrual' })).revenue.totalCents)
      .toBe(30_000)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })
    expect(balances.rows.find((row) => row.number === '2550')?.balanceCents).toBe(470_000)
    expect(balances.isBalanced).toBe(true)
  })

  it('is not modelled on a cash basis, and the report says so', async () => {
    const fixture = await firmFixture()

    await receiveRetainer(fixture.ctx, {
      customerId: fixture.customerId,
      receivedOn: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
    })

    const year = { startDate: '2026-01-01', endDate: '2026-12-31' } as const

    // Strictly, cash basis has no unearned revenue: money received in April is
    // April's revenue. This does not do that, and the reason is Phase 12's —
    // nothing has yet said which revenue account the money is for, and
    // guessing one would put income in a bucket nobody chose.
    //
    // The limitation is reported rather than hidden. Asserted here so it stays
    // a known, named shortcoming instead of quietly becoming the behaviour
    // everyone assumes is correct.
    expect((await profitAndLoss(fixture.ctx, { ...year, basis: 'cash' })).revenue.totalCents)
      .toBe(0)

    const { cashBasisCaveats } = await import('@/modules/ledger/cash-basis')
    const caveats = await cashBasisCaveats(fixture.ctx, year)

    const named = caveats.find((caveat) => caveat.area === 'Accruals and prepayments')
    expect(named).toBeDefined()
    expect(named?.message).toContain('$5,000.00')
  })
})

describe('what has not been billed', () => {
  it('shows the value and how old it is', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    for (const workedOn of ['2026-03-02', '2026-04-20']) {
      const entry = await logTime(fixture.ctx, {
        projectId: fixture.projectId,
        workedOn,
        minutes: 120,
        description: 'Advice',
      })
      await approveTime(fixture.ctx, [entry.id])
    }

    await recordBillableExpense(fixture.ctx, {
      projectId: fixture.projectId,
      incurredOn: '2026-04-10',
      description: 'Filing fee',
      costCents: 9_000,
    })

    const [work] = await unbilledWork(fixture.ctx)

    expect(work.timeMinutes).toBe(240)
    expect(work.timeValueCents).toBe(60_000)
    expect(work.expenseValueCents).toBe(9_000)
    expect(work.totalCents).toBe(69_000)
    // The number that makes it act on: two hours from last week is nothing,
    // two hours from March means the billing is broken.
    expect(work.oldestDate).toBe('2026-03-02')
  })

  it('empties once billed', async () => {
    const fixture = await firmFixture()
    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 15_000 })

    const entry = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 120,
      description: 'Advice',
    })
    await approveTime(fixture.ctx, [entry.id])

    expect(await unbilledWork(fixture.ctx)).toHaveLength(1)

    await billWork(fixture.ctx, {
      projectId: fixture.projectId,
      customerId: fixture.customerId,
      issueDate: '2026-04-30',
    })

    expect(await unbilledWork(fixture.ctx)).toHaveLength(0)
  })

  it('counts written-off time in utilization', async () => {
    const fixture = await firmFixture()

    const billed = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-06',
      minutes: 180,
      description: 'Advice',
    })
    const given = await logTime(fixture.ctx, {
      projectId: fixture.projectId,
      workedOn: '2026-04-07',
      minutes: 60,
      description: 'Over-run',
    })

    await approveTime(fixture.ctx, [billed.id])
    await writeOffTime(fixture.ctx, [given.id], 'Goodwill')

    const rows = await utilizationReport(fixture.ctx, { from: '2026-04-01', to: '2026-04-30' })

    // Excluding written-off time would let a firm improve its utilization by
    // giving work away.
    expect(rows[0].totalMinutes).toBe(240)
    expect(rows[0].billableMinutes).toBe(240)
  })
})

describe('rates in practice', () => {
  it('prefers the engagement’s rate for that person', async () => {
    const fixture = await firmFixture()

    await setPersonRate(fixture.ctx, { userId: fixture.userId, rateCents: 20_000 })
    await setProjectRate(fixture.ctx, { projectId: fixture.projectId, rateCents: 16_000 })
    await setProjectRate(fixture.ctx, {
      projectId: fixture.projectId,
      userId: fixture.userId,
      rateCents: 14_000,
    })

    const rate = await rateForEntry(fixture.ctx, {
      userId: fixture.userId,
      projectId: fixture.projectId,
    })

    expect(rate).toEqual({ rateCents: 14_000, source: 'project_person' })
  })

  it('falls back to the engagement’s blended rate for somebody with none', async () => {
    const fixture = await firmFixture()
    const colleague = await addUserWithRole(fixture, 'manager')

    await setProjectRate(fixture.ctx, { projectId: fixture.projectId, rateCents: 16_000 })

    const rate = await rateForEntry(fixture.ctx, {
      userId: colleague.userId,
      projectId: fixture.projectId,
    })

    expect(rate).toEqual({ rateCents: 16_000, source: 'project' })
  })
})

describe('the guards', () => {
  it('refuses when the module is switched off', async () => {
    const fixture = await createCompanyFixture({ industry: 'general' })

    await expect(
      logTime(fixture.ctx, { workedOn: '2026-04-06', minutes: 60, description: 'Advice' }),
    ).rejects.toThrow(/not switched on/)
  })

  it('keeps one firm’s timesheet out of another’s', async () => {
    const one = await firmFixture()
    const two = await firmFixture()

    await logTime(one.ctx, {
      projectId: one.projectId,
      workedOn: '2026-04-06',
      minutes: 60,
      description: 'Only in one',
    })

    expect(await timesheet(two.ctx)).toHaveLength(0)
  })

  it('names the error when somebody else got there first', () => {
    const error = new AlreadyBilledError(3, 1)
    expect(error.message).toContain('2 of those entries')
    expect(error.message).toContain('Nothing has been charged')
  })
})
