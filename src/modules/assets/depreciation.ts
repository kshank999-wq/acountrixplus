/**
 * Depreciation schedules (spec §13: "Fixed asset register/depreciation
 * support can be a later professional module if not in MVP").
 *
 * Pure arithmetic — no database, no clock, no company. Everything here can be
 * checked against a worked example on paper, which matters more for
 * depreciation than for most calculations because the answer is a *policy*
 * choice rather than an observation. Nobody can look up what a truck's
 * depreciation "really" was; they can only check that the method was applied
 * consistently.
 *
 * ## The total is authoritative, the periodic amount is derived
 *
 * The same discipline as inventory lot value in ADR 0014. An asset costing
 * $10,000 with a $1,000 salvage over 3 years depreciates $9,000 — exactly, to
 * the cent, no matter how the 36 monthly amounts round. So the schedule is
 * built by tracking what is *left* to depreciate and letting the final period
 * take the remainder, rather than by computing a per-period figure and hoping
 * 36 of them add up.
 *
 * $9,000 / 36 = $250.00 divides cleanly. $10,000 / 36 does not: 36 × $277.78
 * is $10,000.08. Deriving each period independently leaves eight cents of an
 * asset on the balance sheet forever, and a fully depreciated asset with a
 * residue is exactly the kind of thing that survives ten years of closes and
 * then has to be explained.
 */

/** How the depreciable base is spread over the asset's life. */
export type DepreciationMethod =
  /** Equal amounts every period. What most small companies use for most things. */
  | 'straight_line'
  /** A fixed percentage of the *remaining* book value, front-loading the cost. */
  | 'declining_balance'
  /**
   * Declining balance until straight line on what is left gives more, then
   * straight line. Without the switch, declining balance never reaches
   * salvage — it approaches it and stops, which is why tax systems that use
   * declining balance nearly all specify the crossover.
   */
  | 'declining_balance_switch'

/**
 * How much depreciation the period an asset is bought and the period it is
 * sold each get. This is a convention, not a measurement: nobody claims a
 * truck bought on the 28th wore out as much that month as one bought on the
 * 2nd, only that a rule was applied.
 */
export type DepreciationConvention =
  /** The month it goes into service is a whole month. */
  | 'full_month'
  /** Half a month in the first month and half in the last. */
  | 'mid_month'
  /** Six months in the first year regardless of when it arrived. */
  | 'half_year'

export type ScheduleInput = {
  /** What was paid, in cents. */
  costCents: number
  /** What it is expected to be worth at the end. Often zero. */
  salvageValueCents: number
  /** Life in whole months. Three years is 36. */
  lifeMonths: number
  method: DepreciationMethod
  convention: DepreciationConvention
  /**
   * The first day of the month the asset went into service. Depreciation
   * starts when the asset is *used*, not when it was paid for — an oven
   * sitting in a crate depreciates nothing.
   */
  inServiceMonth: string
  /**
   * Multiple of the straight-line rate for the declining-balance methods.
   * 2.0 is double-declining; 1.5 is the other common one. Ignored for
   * straight line.
   */
  decliningFactor?: number
}

export type SchedulePeriod = {
  /** First day of the month, `YYYY-MM-01`. */
  periodStart: string
  /** Last day of the month, `YYYY-MM-DD`. */
  periodEnd: string
  /** Depreciation charged in this month, in cents. Never negative. */
  amountCents: number
  /** Cumulative depreciation through the end of this month. */
  accumulatedCents: number
  /** Cost less accumulated depreciation at the end of this month. */
  bookValueCents: number
}

/** Raised when an asset's terms cannot produce a schedule. */
export class InvalidScheduleError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'InvalidScheduleError'
  }
}

/**
 * The amount that will be written off over the asset's life.
 *
 * Clamped at zero: an asset whose salvage estimate exceeds its cost
 * depreciates nothing rather than appreciating, which is a different
 * accounting event entirely and not one this module performs.
 */
export function depreciableBaseCents(costCents: number, salvageValueCents: number): number {
  return Math.max(0, costCents - salvageValueCents)
}

/** `2026-03-17` → `2026-03-01`. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** `2026-02-01` → `2026-02-28`. Handles leap years. */
export function monthEnd(date: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${date.slice(0, 7)}-${String(last).padStart(2, '0')}`
}

/** Advances a `YYYY-MM-01` string by n months. */
export function addMonths(monthStartDate: string, months: number): string {
  const year = Number(monthStartDate.slice(0, 4))
  const month = Number(monthStartDate.slice(5, 7))
  const total = (year * 12 + (month - 1)) + months
  const nextYear = Math.floor(total / 12)
  const nextMonth = (total % 12) + 1
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`
}

/**
 * The share of a full month's depreciation each month of the life receives.
 *
 * Returned as a weight rather than an amount so the caller can normalize:
 * conventions change *how the base is distributed*, never how much of it there
 * is. A half-year convention that also reduced the total would be writing off
 * less than the asset cost, which no convention does.
 *
 * The extra months a convention pushes into are real: an asset on a mid-month
 * convention with a 36-month life depreciates across 37 calendar months, half
 * at each end. Truncating that tail is how a schedule ends up not summing to
 * the base.
 */
export function conventionWeights(
  lifeMonths: number,
  convention: DepreciationConvention,
): number[] {
  if (convention === 'full_month') {
    return Array.from({ length: lifeMonths }, () => 1)
  }

  if (convention === 'mid_month') {
    // Half at the front, half at the back, whole months in between.
    const weights = Array.from({ length: lifeMonths + 1 }, () => 1)
    weights[0] = 0.5
    weights[weights.length - 1] = 0.5
    return weights
  }

  // Half-year: the first twelve months carry six months' worth between them,
  // and everything the convention held back is pushed into a tail beyond the
  // nominal life. An asset with a life shorter than a year gets half its life
  // at the front instead, which keeps the rule meaningful rather than
  // producing a negative tail.
  //
  // The tail is sized by weight, not by month count. Deferring six months of
  // depreciation and then repaying it over six months at *half* rate returns
  // only three — the first year would be right and every later one wrong, and
  // the shortfall would land on the final period as a lump.
  const front = Math.min(6, lifeMonths / 2)
  const frontMonths = Math.min(12, lifeMonths)
  const weights: number[] = []

  for (let i = 0; i < frontMonths; i += 1) weights.push(front / frontMonths)

  let owed = lifeMonths - front
  while (owed > 1e-9) {
    const weight = Math.min(1, owed)
    weights.push(weight)
    owed -= weight
  }

  return weights
}

/**
 * Builds the full month-by-month schedule.
 *
 * Two properties hold for every input, and `tests/assets.test.ts` asserts both
 * across a matrix of methods, conventions and awkward costs:
 *
 *   1. `Σ amountCents === depreciableBaseCents(cost, salvage)` — exactly.
 *   2. The final `bookValueCents === salvageValueCents` — exactly.
 *
 * Neither is approximately true. They are the whole point: an asset that does
 * not fully depreciate, or that depreciates past its salvage value, is a
 * defect somebody discovers years later.
 */
export function depreciationSchedule(input: ScheduleInput): SchedulePeriod[] {
  const {
    costCents,
    salvageValueCents,
    lifeMonths,
    method,
    convention,
    inServiceMonth,
  } = input

  if (!Number.isInteger(costCents) || costCents < 0) {
    throw new InvalidScheduleError('An asset’s cost must be a whole number of cents.')
  }
  if (!Number.isInteger(salvageValueCents) || salvageValueCents < 0) {
    throw new InvalidScheduleError('Salvage value must be a whole number of cents.')
  }
  if (!Number.isInteger(lifeMonths) || lifeMonths < 1) {
    throw new InvalidScheduleError('An asset needs a useful life of at least one month.')
  }

  const base = depreciableBaseCents(costCents, salvageValueCents)
  if (base === 0) return []

  const factor = input.decliningFactor ?? 2
  if (method !== 'straight_line' && factor <= 0) {
    throw new InvalidScheduleError('The declining-balance factor must be greater than zero.')
  }

  const weights = conventionWeights(lifeMonths, convention)
  const rawAmounts =
    method === 'straight_line'
      ? straightLineAmounts(base, weights)
      : decliningAmounts(base, weights, lifeMonths, factor, method === 'declining_balance_switch')

  return materialize(rawAmounts, base, costCents, salvageValueCents, monthStart(inServiceMonth))
}

/** Equal share of the base per weighted month. */
function straightLineAmounts(base: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0)
  return weights.map((w) => (base * w) / totalWeight)
}

/**
 * A fixed percentage of remaining book value, applied monthly.
 *
 * The rate is the straight-line rate times the factor: a 5-year asset at
 * double-declining takes 2/60 of what is left each month. Because that is a
 * proportion of a shrinking number it never reaches zero, which is what the
 * switch exists to fix — once spreading the remainder evenly over the months
 * left beats the declining figure, it takes over and the asset lands exactly
 * on salvage.
 *
 * Without the switch the schedule still lands exactly on salvage, because
 * `materialize` gives the final period whatever is left. That last period is
 * then visibly larger than its neighbours, which is the honest depiction of
 * what declining balance without a crossover actually does.
 */
function decliningAmounts(
  base: number,
  weights: number[],
  lifeMonths: number,
  factor: number,
  switchToStraightLine: boolean,
): number[] {
  const monthlyRate = factor / lifeMonths
  const amounts: number[] = []
  let remaining = base

  for (let i = 0; i < weights.length; i += 1) {
    const weight = weights[i]
    const declining = remaining * monthlyRate * weight

    // Straight line over the months that are actually left, at this month's
    // weight — comparing a weighted figure against an unweighted one would
    // trigger the switch a month early under a mid-month convention.
    const weightLeft = weights.slice(i).reduce((sum, w) => sum + w, 0)
    const straight = weightLeft > 0 ? (remaining / weightLeft) * weight : remaining

    const amount = switchToStraightLine ? Math.max(declining, straight) : declining
    const capped = Math.min(amount, remaining)

    amounts.push(capped)
    remaining -= capped
  }

  return amounts
}

/**
 * Rounds a sequence of exact amounts to whole cents without losing any.
 *
 * Each period takes the rounded running total minus what has already been
 * charged, so rounding error never accumulates — it is corrected on the very
 * next period rather than at the end. The last period then takes whatever
 * remains, which closes the residue that the declining-balance methods leave
 * by construction.
 */
function materialize(
  rawAmounts: number[],
  base: number,
  costCents: number,
  salvageValueCents: number,
  firstMonth: string,
): SchedulePeriod[] {
  const periods: SchedulePeriod[] = []
  let accumulated = 0
  let exactSoFar = 0

  for (let i = 0; i < rawAmounts.length; i += 1) {
    exactSoFar += rawAmounts[i]

    const isLast = i === rawAmounts.length - 1
    const target = isLast ? base : Math.round(exactSoFar)
    const amount = Math.min(target, base) - accumulated

    // A weight can round to nothing in a long schedule — three cents over ten
    // years is three periods that charge a cent and 117 that charge nothing.
    // A zero-cent period is noise on a report and a journal entry for no
    // money, so it is dropped.
    //
    // The final period is dropped on the same terms. It exists to take the
    // remainder, and when the rounding has already handed out the whole base
    // there is no remainder to take. Keeping it "because it is the last one"
    // was worth one zero-amount row on every schedule too small to fill its
    // life, and `amountCents > 0` is a property the posting code relies on:
    // `depreciation_entries` has a CHECK that would reject the row.
    if (amount <= 0) continue

    accumulated += amount
    const start = addMonths(firstMonth, i)

    periods.push({
      periodStart: start,
      periodEnd: monthEnd(start),
      amountCents: amount,
      accumulatedCents: accumulated,
      bookValueCents: costCents - accumulated,
    })
  }

  // Defensive: the loop above makes this true by construction, and an
  // assertion beats discovering it on a balance sheet.
  const last = periods[periods.length - 1]
  if (last && last.bookValueCents !== salvageValueCents) {
    throw new InvalidScheduleError(
      `Schedule ends at ${last.bookValueCents} rather than the salvage value ${salvageValueCents}.`,
    )
  }

  return periods
}

/**
 * Depreciation for one month, taken from the schedule rather than recomputed.
 *
 * Posting reads the schedule so that what is charged in March is the same
 * figure the schedule showed for March. Recomputing at post time is how a
 * register and its postings come to disagree after somebody edits the salvage
 * estimate — the same reason ADR 0015 has one rate function for the preview
 * and the invoice.
 */
export function amountForPeriod(
  schedule: SchedulePeriod[],
  periodEnd: string,
): SchedulePeriod | null {
  return schedule.find((period) => period.periodEnd === periodEnd) ?? null
}

/**
 * Every period of the schedule up to and including a date.
 *
 * This is what "catch up" means for an asset registered late: a truck bought
 * in January and entered in the books in June owes five months of
 * depreciation, and they are charged as five entries dated to their own
 * months, not one lump in June. The months are when the truck was wearing out.
 */
export function periodsThrough(
  schedule: SchedulePeriod[],
  throughDate: string,
): SchedulePeriod[] {
  return schedule.filter((period) => period.periodEnd <= throughDate)
}

export type DisposalOutcome = {
  /** Cost less depreciation actually charged, at the moment of sale. */
  bookValueCents: number
  /** Positive is a gain, negative is a loss. */
  gainLossCents: number
}

/**
 * What selling or scrapping an asset does to the books.
 *
 * Gain or loss is proceeds less book value, and book value uses the
 * depreciation *actually charged*, never the schedule's expectation. An asset
 * sold in month 20 of a 60-month life whose depreciation was last run in month
 * 14 has six months uncharged; treating it as if the schedule had been kept up
 * to date would report a loss the ledger never recorded. The service charges
 * the arrears first and then disposes, so the two agree.
 */
export function disposalOutcome(
  costCents: number,
  accumulatedCents: number,
  proceedsCents: number,
): DisposalOutcome {
  const bookValueCents = costCents - accumulatedCents
  return { bookValueCents, gainLossCents: proceedsCents - bookValueCents }
}
