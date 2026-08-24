import type { AccountType } from '@/modules/coa/standard'
import { DomainError } from '@/modules/errors'

/**
 * What a plan says, and whether missing it is good news (spec §13).
 *
 * ## No database, no clock
 *
 * Both functions here are arithmetic and a judgement, and neither needs to know
 * where the numbers came from. Same reasoning as every other pure core in this
 * codebase: the interesting decisions are testable without a fixture, and the
 * service above can be about persistence rather than about rounding.
 */

export class BudgetError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'BudgetError'
  }
}

/** How an annual figure is distributed across the months. */
export type SpreadMethod =
  /** The same each month, to the cent. */
  | 'even'
  /** In proportion to weights the caller supplies — last year, or seasonality. */
  | 'weighted'

export type SpreadInput = {
  annualCents: number
  periods: number
  method: SpreadMethod
  /**
   * One weight per period, for `weighted`. Whole numbers only — a weight is a
   * *relative* size, and "1.5 against 1" is always expressible as "3 against
   * 2", so requiring integers costs a caller nothing and keeps every
   * multiplication below out of floating point (ADR 0002).
   *
   * Negative weights are refused. A weight of zero is a period that gets
   * nothing, which is a real answer for a business that shuts in January.
   */
  weights?: number[]
}

/**
 * Splits an annual figure across periods without losing or inventing a cent.
 *
 * ## Why the remainder is placed rather than dropped
 *
 * $10,000 across twelve months is $833.33 twelve times, which is $9,999.96.
 * The four cents have to go somewhere, and a budget whose months do not sum to
 * its own annual figure is one somebody will reconcile by hand at year end and
 * find they cannot.
 *
 * The remainder goes to the **earliest** periods, the same convention
 * `allocateCents` uses for splitting money between people (ADR 0002). Putting
 * it in December instead would make the last month of every year look
 * fractionally worse than the plan for a reason that is purely arithmetic.
 *
 * ## Negative budgets are allowed
 *
 * A contra-revenue account, or a cost recovery, is genuinely negative, and the
 * sign is carried through the split rather than refused. What is refused is a
 * figure that is not a whole number of cents, because a plan measured more
 * finely than the ledger can record is a plan that can never be met exactly.
 */
export function spreadFor(input: SpreadInput): number[] {
  const { annualCents, periods, method } = input

  if (!Number.isInteger(periods) || periods <= 0) {
    throw new BudgetError('A budget needs at least one period to spread across.')
  }
  if (!Number.isFinite(annualCents) || !Number.isInteger(annualCents)) {
    throw new BudgetError('A budget figure has to be a whole number of cents.')
  }

  if (method === 'even') {
    const sign = annualCents < 0 ? -1 : 1
    const total = Math.abs(annualCents)
    const base = Math.floor(total / periods)
    const remainder = total - base * periods

    return Array.from({ length: periods }, (_, index) =>
      sign === -1 ? -(base + (index < remainder ? 1 : 0)) : base + (index < remainder ? 1 : 0),
    )
  }

  const weights = input.weights ?? []

  if (weights.length !== periods) {
    throw new BudgetError(
      `A weighted spread needs one weight per period — ${periods} expected, ${weights.length} given.`,
    )
  }
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0) {
      throw new BudgetError(
        'Weights are whole numbers and cannot be negative. Scale them up rather than using ' +
          'a fraction — 3 against 2 says what 1.5 against 1 says.',
      )
    }
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)

  if (totalWeight === 0) {
    throw new BudgetError(
      'Every weight is zero, so there is no way to decide which period gets the money.',
    )
  }

  const sign = annualCents < 0 ? -1 : 1
  const total = Math.abs(annualCents)

  if (!Number.isSafeInteger(total * Math.max(...weights))) {
    throw new BudgetError(
      'That figure and those weights are too large to divide exactly. Use smaller weights.',
    )
  }

  // Largest-remainder, in integers throughout: `total * weight` is exact
  // (checked above), so the floor and the leftover are exact too, and no cent
  // is created or lost by the arithmetic that places them.
  //
  // The leftover goes to the periods that lost the most to rounding, rather
  // than earliest-first. Earliest-first would systematically favour January in
  // a seasonal business, which is the one thing a weighted spread exists to
  // avoid.
  const scaled = weights.map((weight) => total * weight)
  const floors = scaled.map((value) => Math.floor(value / totalWeight))
  const placed = floors.reduce((sum, value) => sum + value, 0)

  const order = scaled
    .map((value, index) => ({ index, remainder: value - floors[index] * totalWeight }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)

  const result = [...floors]
  // At most `periods - 1` cents are left over, so this never wraps past the
  // end of `order` and never gives one period two of them.
  for (let i = 0; i < total - placed; i += 1) {
    result[order[i].index] += 1
  }

  return result.map((value) => sign * value)
}

/**
 * Whether a difference between plan and actual is good news.
 *
 * ## The claim this function exists to make
 *
 * A report that shows revenue $500 under plan and expenses $500 under plan as
 * the same number — "-$500" in both rows — is telling somebody nothing. One is
 * a business that sold less than it hoped; the other is a business that spent
 * less than it feared. Reading a column of signed differences and working out
 * which is which, row by row, is exactly the work software should be doing.
 *
 * So the direction is decided by **what the account is for**:
 *
 * ```
 *   Revenue, other income      more than plan  → favourable
 *   Expense, cost of sales     less than plan  → favourable
 * ```
 *
 * This is the same lesson as `balanceForAccount` returning the *normal*
 * balance: the sign of a number about an account is meaningless without knowing
 * which side of the books it lives on, and the place to resolve that is once,
 * here, rather than at every call site.
 *
 * ## Variance is reported as a magnitude and a verdict, not a signed number
 *
 * `varianceCents` is always what it says — actual less budget, in the account's
 * normal direction — and `favourable` is the separate judgement. Folding the
 * two together into a signed "good is positive" figure would produce a report
 * whose totals cannot be added up, because a favourable revenue variance and a
 * favourable expense variance move net income the same way but the underlying
 * figures move opposite ways.
 */
export type Variance = {
  budgetCents: number
  actualCents: number
  /** Actual less budget, in the account's normal direction. */
  varianceCents: number
  /** True when the difference helps the result. */
  favourable: boolean
  /**
   * How far off, in basis points of the plan. `null` when there is nothing to
   * be a percentage of — spending $400 against a plan of nothing is infinitely
   * over, which is not a number anybody can use.
   */
  basisPoints: number | null
}

/** Accounts whose more is better. Everything else on the P&L is the other way. */
const INCOME_TYPES = new Set<AccountType>(['revenue', 'other_income'])

export function varianceFor(input: {
  budgetCents: number
  actualCents: number
  type: AccountType
}): Variance {
  const { budgetCents, actualCents, type } = input

  if (!Number.isInteger(budgetCents) || !Number.isInteger(actualCents)) {
    throw new BudgetError('Budget and actual both have to be whole numbers of cents.')
  }

  const varianceCents = actualCents - budgetCents
  const isIncome = INCOME_TYPES.has(type)

  return {
    budgetCents,
    actualCents,
    varianceCents,
    // Exactly on plan is favourable rather than adverse. It is not *news*, and
    // a screen that paints a perfectly met budget red is one nobody trusts.
    favourable: isIncome ? varianceCents >= 0 : varianceCents <= 0,
    basisPoints:
      budgetCents === 0 ? null : Math.round((varianceCents * 10_000) / Math.abs(budgetCents)),
  }
}

/** The months of a fiscal year, as 1–12. Named so nothing indexes off by one. */
export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const
export type Month = (typeof MONTHS)[number]

/**
 * The first and last day of a month, as the dates a report range wants.
 *
 * Built by hand rather than through `Date`, because a `Date` here would be
 * constructed in the server's timezone and a budget month that starts on the
 * 31st of the previous month at 8pm is a bug nobody finds until December.
 */
export function monthRange(year: number, month: Month): { startDate: string; endDate: string } {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new BudgetError(`${year} is not a fiscal year.`)
  }

  const mm = String(month).padStart(2, '0')
  // Day 0 of the next month is the last day of this one, which handles
  // February and leap years without a table.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()

  return {
    startDate: `${year}-${mm}-01`,
    endDate: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  }
}
