import { addMonths, monthEnd, monthStart } from '@/modules/assets/depreciation'

/**
 * When rent is owed and how much (spec §5 "rents").
 *
 * A pure core, with no database and no clock, for the same reason
 * `depreciationSchedule` is one: proration is arithmetic somebody will
 * eventually dispute, and arithmetic that can be called with a hundred awkward
 * inputs in a test is arithmetic that can be defended.
 */

export type RentPeriod = {
  /** `YYYY-MM-01`. */
  periodStart: string
  /** Last day of the same month. */
  periodEnd: string
  /** 28, 29, 30 or 31. */
  days: number
}

/** The monthly period containing a date. */
export function rentPeriodFor(date: string): RentPeriod {
  const periodStart = monthStart(date)
  const periodEnd = monthEnd(periodStart)
  return { periodStart, periodEnd, days: Number(periodEnd.slice(8, 10)) }
}

/** Periods from `from` up to and including the one containing `through`. */
export function rentPeriodsBetween(from: string, through: string): RentPeriod[] {
  const periods: RentPeriod[] = []
  let cursor = monthStart(from)
  const last = monthStart(through)

  while (cursor <= last) {
    periods.push(rentPeriodFor(cursor))
    cursor = addMonths(cursor, 1)
  }

  return periods
}

/**
 * The day rent falls due within a period.
 *
 * `dueDay` is capped at 28 by the schema, so this never has to decide what
 * "the 31st" means in February — a decision that silently moves a due date by
 * three days twice a year and makes a late-fee report indefensible.
 */
export function rentDueDate(periodStart: string, dueDay: number): string {
  return `${periodStart.slice(0, 7)}-${String(dueDay).padStart(2, '0')}`
}

export type LeaseTerm = {
  startsOn: string
  endsOn: string | null
  rentCents: number
}

export type RentCharge = {
  periodStart: string
  periodEnd: string
  amountCents: number
  /** Days the tenancy actually covered. Equal to `periodDays` when whole. */
  chargedDays: number
  periodDays: number
  prorated: boolean
}

/**
 * What one lease owes for one period, or null when it owes nothing.
 *
 * A tenancy that starts on the 15th pays for the 15th onwards, and one that
 * ends on the 10th pays to the 10th inclusive — a tenant who has the keys on
 * the 10th had them that day. Rounding is to the nearest cent, and the
 * landlord's favour is not the tie-breaker: `Math.round` is, because a rule
 * that always rounds up collects a few cents more than the lease says over a
 * year and somebody eventually notices.
 *
 * A whole period is never prorated, so the common case returns exactly the
 * rent on the lease and no arithmetic can drift it.
 */
export function rentFor(lease: LeaseTerm, period: RentPeriod): RentCharge | null {
  const from = lease.startsOn > period.periodStart ? lease.startsOn : period.periodStart
  const to =
    lease.endsOn && lease.endsOn < period.periodEnd ? lease.endsOn : period.periodEnd

  if (from > to) return null

  const chargedDays = dayOf(to) - dayOf(from) + 1
  const whole = chargedDays === period.days

  const amountCents = whole
    ? lease.rentCents
    : Math.round((lease.rentCents * chargedDays) / period.days)

  // A proration that rounds to nothing is not a charge. Billing $0.00 would
  // produce an invoice the ledger refuses and a row nobody can explain.
  if (amountCents <= 0) return null

  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    amountCents,
    chargedDays,
    periodDays: period.days,
    prorated: !whole,
  }
}

function dayOf(date: string): number {
  return Number(date.slice(8, 10))
}
