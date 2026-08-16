/**
 * What an hour is worth (spec §5, Professional Services: "time/expense
 * billing").
 *
 * ## Why this is a pure module
 *
 * Rate resolution is a pile of fallbacks, and a pile of fallbacks is where
 * "why was this billed at $150 when her rate is $175" comes from. Written as a
 * function that takes every candidate and returns both the answer *and where
 * it came from*, it can be tested exhaustively and explained in the UI without
 * anyone reading the code.
 *
 * ## Minutes, not fractional hours
 *
 * Time is recorded in whole minutes because that is what people enter and it
 * is exact. Hours are derived for display, and — the part that matters — the
 * **money is computed from the minutes**, never from the displayed hours.
 *
 * Ten minutes at $90/hour is $15.00. Via a rounded 0.167 hours it is $15.03.
 * Do that forty times on one invoice and a client asks why the total does not
 * match the lines.
 */

/** Where a rate came from, so the UI can say so. */
export type RateSource =
  | 'entry'
  | 'project_person'
  | 'project'
  | 'person'
  | 'item'
  | 'none'

export const RATE_SOURCE_LABELS: Record<RateSource, string> = {
  entry: 'Typed on this entry',
  project_person: 'This person, on this engagement',
  project: 'The engagement’s standard rate',
  person: 'This person’s standard rate',
  item: 'The service’s list price',
  none: 'No rate found',
}

export type RateCandidates = {
  /** Typed directly on the time entry. Beats everything. */
  entryRateCents?: number | null
  /** An override for this person on this engagement. */
  projectPersonRateCents?: number | null
  /** The engagement's blended rate. */
  projectRateCents?: number | null
  /** The person's standard rate. */
  personRateCents?: number | null
  /** The catalogue item's list price. */
  itemRateCents?: number | null
}

export type ResolvedRate = { rateCents: number; source: RateSource }

/**
 * The first rate that exists, most specific first.
 *
 * The order is the whole design, and it is the order people describe out loud:
 * *what I typed*, beats *what we agreed for me on this job*, beats *what we
 * agreed for this job*, beats *my usual rate*, beats *the list price*.
 *
 * **Zero is a rate**, and `null` is the absence of one. A pro-bono hour billed
 * at nothing is a decision somebody made, and `??` respects it where `||`
 * would silently fall through to the next candidate and bill for it.
 */
export function resolveRate(candidates: RateCandidates): ResolvedRate {
  const order: Array<[RateSource, number | null | undefined]> = [
    ['entry', candidates.entryRateCents],
    ['project_person', candidates.projectPersonRateCents],
    ['project', candidates.projectRateCents],
    ['person', candidates.personRateCents],
    ['item', candidates.itemRateCents],
  ]

  for (const [source, value] of order) {
    if (value !== null && value !== undefined) return { rateCents: value, source }
  }

  return { rateCents: 0, source: 'none' }
}

/**
 * What a stretch of time is worth, in cents.
 *
 * Rounded exactly once, from minutes. See the header for why the obvious
 * detour through fractional hours produces invoices whose lines do not add up
 * to their own total.
 */
export function amountForMinutes(minutes: number, rateCents: number): number {
  return Math.round((minutes * rateCents) / 60)
}

/** Minutes as thousandths of an hour, for an invoice line's quantity. */
export function minutesToQuantityMilli(minutes: number): number {
  return Math.round((minutes * 1000) / 60)
}

/** Minutes as a readable duration: 90 becomes "1h 30m". */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : ''
  const absolute = Math.abs(minutes)
  const hours = Math.floor(absolute / 60)
  const rest = absolute % 60

  if (hours === 0) return `${sign}${rest}m`
  if (rest === 0) return `${sign}${hours}h`
  return `${sign}${hours}h ${rest}m`
}

/**
 * Parses what somebody types into a timesheet.
 *
 * All of `1.5`, `1:30`, `90m`, `1h30`, and `1h 30m` mean ninety minutes, and
 * people use every one of them. Returning null rather than guessing on
 * nonsense, so the form can say so instead of silently logging a number
 * nobody meant.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase()
  if (!text) return null

  // 1:30
  const clock = /^(\d+):([0-5]?\d)$/.exec(text)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])

  // 1h30m, 1h 30, 45m, 2h
  const composite = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m?)?$/.exec(text)
  if (composite && (composite[1] || composite[2])) {
    const hours = composite[1] ? Number(composite[1]) : 0
    const rest = composite[2] ? Number(composite[2]) : 0
    // A bare number with no unit is hours, not minutes: somebody typing "2"
    // into a timesheet means two hours.
    if (!composite[1] && composite[2] && !/m/.test(text)) {
      return Math.round(Number(composite[2]) * 60)
    }
    return Math.round(hours * 60) + rest
  }

  // 1.5 — decimal hours.
  const decimal = /^(\d+(?:\.\d+)?)$/.exec(text)
  if (decimal) return Math.round(Number(decimal[1]) * 60)

  return null
}

/**
 * What a reimbursable cost is billed at.
 *
 * Markup in basis points, the same unit as every other ratio in this codebase.
 * A cost passed through at exactly what it cost is a markup of zero, not the
 * absence of one — so the parameter is required and there is no default that
 * quietly adds a margin nobody agreed.
 */
export function billableAmountCents(costCents: number, markupBasisPoints: number): number {
  return costCents + Math.round((costCents * markupBasisPoints) / 10_000)
}

export type UtilizationRow = {
  personId: string
  personName: string
  billableMinutes: number
  nonBillableMinutes: number
  totalMinutes: number
  /** Billable as a share of recorded time, in basis points. Null when nothing was recorded. */
  utilizationBasisPoints: number | null
}

/**
 * Utilization from recorded minutes.
 *
 * The denominator is **time recorded**, not a notional working week. A firm
 * that measures against 40 hours reports 60% for somebody who took a week off,
 * which says nothing about how they spent the time they worked. Capacity
 * planning wants the other denominator, and that is a different report with a
 * different name.
 */
export function utilization(
  rows: Array<{ personId: string; personName: string; minutes: number; isBillable: boolean }>,
): UtilizationRow[] {
  const byPerson = new Map<string, UtilizationRow>()

  for (const row of rows) {
    let entry = byPerson.get(row.personId)
    if (!entry) {
      entry = {
        personId: row.personId,
        personName: row.personName,
        billableMinutes: 0,
        nonBillableMinutes: 0,
        totalMinutes: 0,
        utilizationBasisPoints: null,
      }
      byPerson.set(row.personId, entry)
    }

    if (row.isBillable) entry.billableMinutes += row.minutes
    else entry.nonBillableMinutes += row.minutes
    entry.totalMinutes += row.minutes
  }

  for (const entry of byPerson.values()) {
    entry.utilizationBasisPoints =
      entry.totalMinutes === 0
        ? null
        : Math.round((entry.billableMinutes * 10_000) / entry.totalMinutes)
  }

  return [...byPerson.values()].sort((a, b) => a.personName.localeCompare(b.personName))
}
