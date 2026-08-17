/**
 * What a donor's restriction means, in arithmetic (spec §5, "Nonprofit —
 * funds/restrictions, grants, donors, program reporting").
 *
 * A pure core, with no database and no clock, for the same reason
 * `depreciationSchedule` and `rentFor` are ones: this is the arithmetic
 * somebody will eventually dispute, usually a board member reading a report
 * six months later, and arithmetic that can be called with a hundred awkward
 * inputs in a test is arithmetic that can be defended.
 *
 * ## The claim
 *
 * **A restriction is the donor's, not the charity's.** Money given for the roof
 * cannot become money for salaries because the salaries account is empty. The
 * charity may spend it *on the roof*, and the moment it does, the restriction
 * on that much of it is satisfied and no longer constrains anything.
 *
 * Everything in this file is that sentence with numbers attached.
 */

/**
 * How a fund is restricted.
 *
 * The three-way split is the one the balance sheet uses. `unrestricted` and
 * `restricted` are the two columns of net assets a nonprofit reports;
 * `perpetual` is an endowment, whose *principal* is never releasable at all —
 * only its income is, and that income belongs to a different fund.
 */
export type Restriction = 'unrestricted' | 'restricted' | 'perpetual'

/** Which column of net assets a fund's money sits in. */
export type NetAssetClass = 'without_donor_restrictions' | 'with_donor_restrictions'

export function netAssetClassOf(restriction: Restriction): NetAssetClass {
  return restriction === 'unrestricted'
    ? 'without_donor_restrictions'
    : 'with_donor_restrictions'
}

/**
 * Whether spending against a fund can satisfy its restriction.
 *
 * An endowment's principal cannot: a donor who gives money to be held forever
 * has not given money to be spent, and a charity that released endowment
 * principal as it spent would report a growing unrestricted balance made
 * entirely of money it is not allowed to touch.
 */
export function isReleasable(restriction: Restriction): boolean {
  return restriction === 'restricted'
}

export type Release = {
  /** Restriction satisfied by this spending. Never more than was given. */
  releaseCents: number
  /**
   * Spending this fund could not cover.
   *
   * Not an error and not zero-by-construction: a charity really can spend more
   * on a programme than was given for it, out of its general money. What it
   * cannot do is *release* restriction that was never there, so the excess
   * stays visible here rather than quietly inflating the release.
   */
  shortfallCents: number
}

/**
 * The release a period's spending earns, given what the fund had to spend.
 *
 * The whole rule, in one comparison: **you release the lesser of what was given
 * and what was spent.**
 *
 * The two directions are different mistakes and both are common. Releasing the
 * spend regardless of the balance drives a restricted fund negative, which on a
 * balance sheet reads as a donor owing the charity money. Releasing the balance
 * regardless of the spend releases restriction nobody satisfied — the charity
 * reporting that it has met a condition it has not yet met.
 */
export function releaseFor(availableCents: number, spentCents: number): Release {
  const spend = Math.max(0, spentCents)
  const available = Math.max(0, availableCents)
  const releaseCents = Math.min(available, spend)

  return { releaseCents, shortfallCents: spend - releaseCents }
}

/** One period's movement on a fund, as read off the ledger. */
export type FundMovement = {
  /** `YYYY-MM-01`. */
  periodStart: string
  /** Contributions, grants and pledges recognised in the period. */
  receivedCents: number
  /** Expenditure tagged to this fund in the period. */
  spentCents: number
  /** Restriction already released for this period, if it has been run. */
  releasedCents: number
}

export type RollforwardPeriod = FundMovement & {
  openingCents: number
  /** What the release run would post for this period, had it not already. */
  releasableCents: number
  shortfallCents: number
  closingCents: number
}

export type Rollforward = {
  periods: RollforwardPeriod[]
  openingCents: number
  receivedCents: number
  releasedCents: number
  closingCents: number
  /**
   * Spending this fund never had the money for, across every period.
   *
   * The number a board should be shown and an auditor will ask about. It is
   * *not* recoverable by spending less next month: a shortfall in March is
   * general money already gone, and April's donations restore April.
   */
  shortfallCents: number
  /** Release the run still owes, because a period was spent but never run. */
  unreleasedCents: number
}

/**
 * A fund's balance over time, period by period.
 *
 * Ordering matters and is the reason this takes a list rather than totals: a
 * fund that received £10,000 in March and spent £8,000 in February did not have
 * £8,000 to spend in February. Netting the year would say it did.
 *
 * `movements` must be in period order and must not repeat a period. Both are
 * the caller's job because the caller builds them from a `GROUP BY` that
 * guarantees each — asserting it here would be checking the database's
 * arithmetic rather than this file's.
 */
export function fundRollforward(openingCents: number, movements: FundMovement[]): Rollforward {
  let balance = openingCents
  let received = 0
  let released = 0
  let shortfall = 0
  let unreleased = 0

  const periods: RollforwardPeriod[] = []

  for (const movement of movements) {
    const opening = balance

    // Received first: money given in a period is available to be spent in that
    // same period, which is how a charity that fundraises for an appeal and
    // spends it the same month actually behaves.
    balance += movement.receivedCents

    const { releaseCents, shortfallCents } = releaseFor(balance, movement.spentCents)

    // What the run *did* release is what leaves the fund. A period whose
    // release has not been run yet still shows the money sitting there,
    // because it is sitting there — the entry has not been posted.
    balance -= movement.releasedCents

    periods.push({
      ...movement,
      openingCents: opening,
      releasableCents: releaseCents,
      shortfallCents,
      closingCents: balance,
    })

    received += movement.receivedCents
    released += movement.releasedCents
    shortfall += shortfallCents
    unreleased += Math.max(0, releaseCents - movement.releasedCents)
  }

  return {
    periods,
    openingCents,
    receivedCents: received,
    releasedCents: released,
    closingCents: balance,
    shortfallCents: shortfall,
    unreleasedCents: unreleased,
  }
}
