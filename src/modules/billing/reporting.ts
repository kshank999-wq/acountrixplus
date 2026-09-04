import { asc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  customers,
  recurringInvoiceLines,
  recurringInvoiceOccurrences,
  recurringInvoices,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { nextOccurrence } from '@/modules/ledger/recurring'
import { forecastTotals, type ForecastTotals } from './currency'
import { scheduleTotalCents } from './service'

/**
 * What the active schedules are going to bill (spec §13).
 *
 * ## Reported, never posted
 *
 * This is the same rule Phase 35 set for currency exposure and Phase 36 for a
 * budget, and it matters most here because the number looks so much like a
 * receivable. It is not one. Nobody has been invoiced, nothing is owed, no
 * customer has agreed that December happened yet — and a business that counted
 * this as an asset would be booking revenue for work it has not done.
 *
 * So it is a forecast: what *will* be raised, if nothing changes and every
 * schedule runs. Schedules get cancelled, prices change and customers leave,
 * which is exactly why this is a screen rather than a journal entry.
 */

export type ForecastOccurrence = {
  scheduleId: string
  name: string
  customerName: string
  dueOn: string
  totalCents: number
  /** What the schedule bills in (Phase 126). */
  currency: string
  autoRaise: boolean
  /** Already due when the window opened, and still not billed. */
  overdue: boolean
}

export type Forecast = {
  from: string
  through: string
  occurrences: ForecastOccurrence[]
  /**
   * The totals, one set per currency (Phase 126).
   *
   * It was four flat figures until a schedule could be foreign. `overdueCents`
   * is the interesting one in each set: a period that has passed and has not
   * been billed is not a forecast, it is a thing somebody has forgotten.
   * Browser verification found this report hiding one — the window began today
   * and an overdue quarter simply was not listed.
   */
  totals: ForecastTotals[]
  /** Distinct schedules across every currency; each total has its own count. */
  scheduleCount: number
}

/** How far ahead a forecast will walk, per schedule. */
const MAX_HORIZON = 200

/**
 * The occurrences every active schedule would produce between two dates.
 *
 * Walks each schedule's own cadence forward rather than assuming twelve months
 * — a weekly arrangement and an annual one are both real, and a forecast that
 * multiplied a monthly figure by the months in the range would be wrong for
 * both.
 */
export async function billingForecast(
  ctx: ActorContext,
  opts: { from?: string; through?: string } = {},
): Promise<Forecast> {
  requirePermission(ctx, 'reports:financial')

  const today = new Date().toISOString().slice(0, 10)
  const from = opts.from ?? today
  const through = opts.through ?? addMonths(from, 3)

  const schedules = await db
    .select({
      id: recurringInvoices.id,
      name: recurringInvoices.name,
      customerName: customers.name,
      cadence: recurringInvoices.cadence,
      dayOfMonth: recurringInvoices.dayOfMonth,
      autoRaise: recurringInvoices.autoRaise,
      nextRunOn: recurringInvoices.nextRunOn,
      endsOn: recurringInvoices.endsOn,
      currency: recurringInvoices.currency,
    })
    .from(recurringInvoices)
    .innerJoin(customers, eq(customers.id, recurringInvoices.customerId))
    .where(scoped(ctx, recurringInvoices, eq(recurringInvoices.isActive, true)))
    .orderBy(asc(recurringInvoices.nextRunOn))

  const lines = await db
    .select({
      recurringInvoiceId: recurringInvoiceLines.recurringInvoiceId,
      quantityMilli: recurringInvoiceLines.quantityMilli,
      unitPriceCents: recurringInvoiceLines.unitPriceCents,
    })
    .from(recurringInvoiceLines)
    .where(scoped(ctx, recurringInvoiceLines))

  const totalBySchedule = new Map<string, number>()
  for (const line of lines) {
    const rows = totalBySchedule.get(line.recurringInvoiceId) ?? 0
    totalBySchedule.set(
      line.recurringInvoiceId,
      rows + scheduleTotalCents([{ quantityMilli: line.quantityMilli, unitPriceCents: line.unitPriceCents }]),
    )
  }

  const occurrences: ForecastOccurrence[] = []

  for (const schedule of schedules) {
    const totalCents = totalBySchedule.get(schedule.id) ?? 0
    // A schedule with no lines bills nothing, and a forecast that listed it at
    // zero would pad the count with rows that mean nothing.
    if (totalCents === 0) continue

    let due = schedule.nextRunOn
    let walked = 0

    while (due <= through && walked < MAX_HORIZON) {
      if (schedule.endsOn && due > schedule.endsOn) break

      // No lower bound. The walk starts at `nextRunOn`, which is by definition
      // a period this schedule has not billed — so anything before `from` is
      // overdue rather than out of scope, and leaving it out would hide the
      // one case somebody most needs to see.
      occurrences.push({
        scheduleId: schedule.id,
        name: schedule.name,
        customerName: schedule.customerName,
        dueOn: due,
        totalCents,
        currency: schedule.currency,
        autoRaise: schedule.autoRaise,
        overdue: due < from,
      })

      due = nextOccurrence(
        { cadence: schedule.cadence, dayOfMonth: schedule.dayOfMonth },
        due,
      )
      walked += 1
    }
  }

  occurrences.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name))

  return {
    from,
    through,
    occurrences,
    // Grouped rather than added (Phase 126). A euro retainer and a dollar one
    // are both real; a report that added them would be the only wrong number
    // that phase introduced.
    totals: forecastTotals(occurrences),
    scheduleCount: new Set(occurrences.map((row) => row.scheduleId)).size,
  }
}

export type WaitingOccurrence = {
  occurrenceId: string
  scheduleId: string
  name: string
  customerName: string
  occurredOn: string
  totalCents: number
  /**
   * What the period will be billed in (Phase 126).
   *
   * The occurrence's own column, not the schedule's: an occurrence records what
   * was decided when the period was claimed, and a schedule re-denominated
   * afterwards must not restate a period already waiting on somebody's desk.
   */
  currency: string
}

/**
 * Periods that came due on a schedule somebody has to raise by hand.
 *
 * The work list for `autoRaise: false`. A period that is claimed but not
 * invoiced is the one state in this module where nothing happens on its own,
 * so it has to be visible or the arrangement quietly stops billing.
 */
export async function awaitingRaise(ctx: ActorContext): Promise<WaitingOccurrence[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      occurrenceId: recurringInvoiceOccurrences.id,
      scheduleId: recurringInvoices.id,
      name: recurringInvoices.name,
      customerName: customers.name,
      occurredOn: recurringInvoiceOccurrences.occurredOn,
      totalCents: recurringInvoiceOccurrences.totalCents,
      currency: recurringInvoiceOccurrences.currency,
    })
    .from(recurringInvoiceOccurrences)
    .innerJoin(
      recurringInvoices,
      eq(recurringInvoices.id, recurringInvoiceOccurrences.recurringInvoiceId),
    )
    .innerJoin(customers, eq(customers.id, recurringInvoices.customerId))
    .where(
      scoped(
        ctx,
        recurringInvoiceOccurrences,
        // On the *invoice* being absent, not on `wasRaised` alone: an
        // occurrence raised later by hand keeps `wasRaised` false — that flag
        // records what the schedule intended at the time — and listing it
        // again would invite billing the period twice.
        isNull(recurringInvoiceOccurrences.invoiceId),
      ),
    )
    .orderBy(asc(recurringInvoiceOccurrences.occurredOn))

  return rows
}

function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  const day = value.getUTCDate()
  const shifted = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1))
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate()
  shifted.setUTCDate(Math.min(day, lastDay))
  return shifted.toISOString().slice(0, 10)
}
