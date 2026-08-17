import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  fundReleases,
  funds,
  journalEntries,
  journalLineDimensions,
  journalLines,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { fundDimensionId } from './service'
import { netAssetClassOf, type NetAssetClass, type Restriction } from './restriction'

/**
 * What each fund still has, and what the two columns of net assets add up to
 * (spec §5, "program reporting").
 *
 * ## Rows are the authority
 *
 * Every figure here is derived from journal lines at the moment it is asked
 * for. There is no `balance_cents` on `funds` and there is deliberately no
 * cache. Phase 20 kept a `reference_count` beside the rows it counted, the two
 * disagreed, and the lesson was written down: **rows are the authority, never a
 * cached count.** A charity whose fund balances are a stored number is a
 * charity that will one day tell a donor a figure its own ledger contradicts.
 *
 * ## And there is no per-fund profit and loss here
 *
 * That is Phase 16's dimensional report, and a fund is a dimension value. A
 * second implementation would drift from the first, and the first is the one an
 * accountant already trusts.
 */

export type FundBalance = {
  fundId: string
  code: string
  name: string
  restriction: Restriction
  netAssetClass: NetAssetClass
  purpose: string | null
  expiresOn: string | null
  /** Revenue credited to this fund, all time to the as-of date. */
  receivedCents: number
  /** Expenditure charged against it. */
  spentCents: number
  /** Restriction satisfied and moved to the unrestricted column. */
  releasedCents: number
  /**
   * What is left to spend: given, less released.
   *
   * Not "given less spent". Spending is what *earns* a release, and until the
   * release is posted the money is still restricted — so a fund spent but not
   * yet run shows the money still sitting there, because it is still sitting
   * there. `unreleasedCents` is what says so.
   */
  availableCents: number
  /** Release earned by spending but not yet posted. */
  unreleasedCents: number
  /** Spending this fund never had the money for. */
  shortfallCents: number
}

/**
 * Every fund, with what it has taken in, spent and released.
 *
 * `asOf` is a parameter. A balance that reads the clock cannot be asked what
 * the roof appeal held at the year end, which is the only date a trustee
 * actually cares about.
 */
export async function fundBalances(
  ctx: ActorContext,
  opts: { asOf: string; includeInactive?: boolean },
): Promise<FundBalance[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(funds)
    .where(scoped(ctx, funds, opts.includeInactive ? undefined : eq(funds.isActive, true)))
    .orderBy(asc(funds.code))

  if (rows.length === 0) return []

  const dimensionId = await fundDimensionId(ctx)
  if (!dimensionId) {
    return rows.map((row) => emptyBalance(row))
  }

  const ids = rows.map((row) => row.id)
  // Exclusive upper bound, so `asOf` itself is included.
  const through = nextDay(opts.asOf)

  const [activity, released] = await Promise.all([
    activityByFund(ctx, dimensionId, ids, through),
    releasedTotals(ctx, ids, through),
  ])

  return rows.map((row) => {
    const moves = activity.get(row.id) ?? { receivedCents: 0, spentCents: 0 }
    const releasedCents = released.get(row.id)?.releasedCents ?? 0
    const shortfallCents = released.get(row.id)?.shortfallCents ?? 0

    const availableCents = moves.receivedCents - releasedCents

    // What a run would still post: spending that has earned a release and not
    // had one, capped at what the fund actually has. An endowment earns none.
    const restriction = row.restriction as Restriction
    const unreleasedCents =
      restriction === 'restricted'
        ? Math.max(0, Math.min(availableCents, moves.spentCents - releasedCents))
        : 0

    return {
      fundId: row.id,
      code: row.code,
      name: row.name,
      restriction,
      netAssetClass: netAssetClassOf(restriction),
      purpose: row.purpose,
      expiresOn: row.expiresOn,
      receivedCents: moves.receivedCents,
      spentCents: moves.spentCents,
      releasedCents,
      availableCents,
      unreleasedCents,
      shortfallCents,
    }
  })
}

function emptyBalance(row: typeof funds.$inferSelect): FundBalance {
  const restriction = row.restriction as Restriction
  return {
    fundId: row.id,
    code: row.code,
    name: row.name,
    restriction,
    netAssetClass: netAssetClassOf(restriction),
    purpose: row.purpose,
    expiresOn: row.expiresOn,
    receivedCents: 0,
    spentCents: 0,
    releasedCents: 0,
    availableCents: 0,
    unreleasedCents: 0,
    shortfallCents: 0,
  }
}

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * Revenue and expenditure per fund in one query.
 *
 * One pass over the lines rather than two, with the sign decided per account
 * type. The release pair is excluded from revenue for the reason it is
 * excluded in the run: it nets to zero across the columns, and counting it as
 * a receipt would let a fund release the same money twice.
 */
async function activityByFund(
  ctx: ActorContext,
  dimensionId: string,
  fundIds: string[],
  through: string,
): Promise<Map<string, { receivedCents: number; spentCents: number }>> {
  const rows = await db
    .select({
      fundId: funds.id,
      receivedCents: sql<string>`
        sum(
          case
            when ${chartAccounts.type} in ('revenue', 'other_income')
             and ${chartAccounts.number} not in (
               ${INDUSTRY_ACCOUNTS.releasedFromRestriction},
               ${INDUSTRY_ACCOUNTS.releasedToUnrestricted}
             )
            then ${journalLines.creditCents} - ${journalLines.debitCents}
            else 0
          end
        )`,
      spentCents: sql<string>`
        sum(
          case
            when ${chartAccounts.type} in ('expense', 'cogs', 'other_expense')
            then ${journalLines.debitCents} - ${journalLines.creditCents}
            else 0
          end
        )`,
    })
    .from(journalLines)
    .innerJoin(
      journalLineDimensions,
      and(
        eq(journalLineDimensions.journalLineId, journalLines.id),
        eq(journalLineDimensions.dimensionId, dimensionId),
      ),
    )
    .innerJoin(funds, eq(funds.dimensionValueId, journalLineDimensions.dimensionValueId))
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lt(journalEntries.entryDate, through),
        inArray(funds.id, fundIds),
      ),
    )
    .groupBy(funds.id)

  return new Map(
    rows.map((row) => [
      row.fundId,
      {
        receivedCents: Number(row.receivedCents ?? 0),
        spentCents: Number(row.spentCents ?? 0),
      },
    ]),
  )
}

async function releasedTotals(
  ctx: ActorContext,
  fundIds: string[],
  through: string,
): Promise<Map<string, { releasedCents: number; shortfallCents: number }>> {
  const rows = await db
    .select({
      fundId: fundReleases.fundId,
      releasedCents: sql<string>`sum(${fundReleases.releasedCents})`,
      shortfallCents: sql<string>`sum(${fundReleases.shortfallCents})`,
    })
    .from(fundReleases)
    .where(
      scoped(
        ctx,
        fundReleases,
        and(inArray(fundReleases.fundId, fundIds), lt(fundReleases.periodStart, through)),
      ),
    )
    .groupBy(fundReleases.fundId)

  return new Map(
    rows.map((row) => [
      row.fundId,
      {
        releasedCents: Number(row.releasedCents ?? 0),
        shortfallCents: Number(row.shortfallCents ?? 0),
      },
    ]),
  )
}

export type NetAssetsReport = {
  asOf: string
  withoutRestrictionCents: number
  withRestrictionCents: number
  totalCents: number
  /** The restricted column, fund by fund. */
  restrictedFunds: FundBalance[]
  /**
   * Every penny of contribution and grant revenue the ledger holds, whether or
   * not anybody said which fund it was for.
   */
  contributionRevenueCents: number
  /**
   * Contribution and grant revenue carrying no fund at all.
   *
   * This is the check, and it is a real one because the two sides are computed
   * from genuinely different things: the total is every line posted to the
   * contribution accounts, and the tagged figure is the subset joined through
   * `journal_line_dimensions`. Comparing the fund balances to a total derived
   * from the same fund balances would reconcile perfectly and prove nothing —
   * which is the trap the property module's deposit check was written to avoid.
   *
   * A non-zero number here is a donation nobody can state the purpose of. It is
   * not necessarily an error — a charity really does receive unrestricted money
   * with no appeal attached — but it is money outside every figure on this
   * page, and a page that did not say so would be quietly understating what it
   * was asked to report on.
   */
  untaggedContributionCents: number
  /** True when every contribution the ledger holds belongs to a named fund. */
  agrees: boolean
  /** Funds spent beyond what was given for them. */
  overspent: FundBalance[]
  /** Release the run still owes across every fund. */
  unreleasedCents: number
}

/**
 * Net assets split into the two columns a nonprofit reports.
 *
 * The restricted column is the sum of the restricted and perpetual funds'
 * balances. The unrestricted column is everything else the ledger holds — which
 * is *not* computed from funds, because most of a charity's unrestricted money
 * was never given to a named appeal, and a report that only counted fund money
 * would report a solvent charity as having nothing.
 */
export async function netAssets(
  ctx: ActorContext,
  opts: { asOf: string },
): Promise<NetAssetsReport> {
  requirePermission(ctx, 'accounting:view')

  const balances = await fundBalances(ctx, { asOf: opts.asOf, includeInactive: true })

  const restrictedFunds = balances.filter(
    (fund) => fund.netAssetClass === 'with_donor_restrictions',
  )

  const withRestrictionCents = restrictedFunds.reduce(
    (sum, fund) => sum + fund.availableCents,
    0,
  )

  // Everything the books hold, from the ledger rather than from this module.
  const [totalCents, contribution] = await Promise.all([
    totalNetAssets(ctx, opts.asOf),
    contributionRevenue(ctx, opts.asOf),
  ])

  return {
    asOf: opts.asOf,
    withoutRestrictionCents: totalCents - withRestrictionCents,
    withRestrictionCents,
    totalCents,
    restrictedFunds,
    contributionRevenueCents: contribution.totalCents,
    untaggedContributionCents: contribution.untaggedCents,
    agrees: contribution.untaggedCents === 0,
    overspent: balances.filter((fund) => fund.shortfallCents > 0),
    unreleasedCents: balances.reduce((sum, fund) => sum + fund.unreleasedCents, 0),
  }
}

/**
 * Contribution and grant revenue, and how much of it names no fund.
 *
 * Two sums in one pass: everything posted to the two contribution accounts,
 * and the part of it that has a row in `journal_line_dimensions` for the Fund
 * dimension. A `left join` rather than two queries, so the difference cannot be
 * an artefact of the two running against different snapshots.
 */
async function contributionRevenue(
  ctx: ActorContext,
  asOf: string,
): Promise<{ totalCents: number; untaggedCents: number }> {
  const through = nextDay(asOf)
  const dimensionId = await fundDimensionId(ctx)

  const [row] = await db
    .select({
      totalCents: sql<string>`sum(${journalLines.creditCents} - ${journalLines.debitCents})`,
      untaggedCents: sql<string>`
        sum(
          case when ${journalLineDimensions.id} is null
          then ${journalLines.creditCents} - ${journalLines.debitCents}
          else 0 end
        )`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .leftJoin(
      journalLineDimensions,
      and(
        eq(journalLineDimensions.journalLineId, journalLines.id),
        dimensionId
          ? eq(journalLineDimensions.dimensionId, dimensionId)
          : sql`false`,
      ),
    )
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lt(journalEntries.entryDate, through),
        inArray(chartAccounts.number, [
          INDUSTRY_ACCOUNTS.contributionRevenue,
          INDUSTRY_ACCOUNTS.grantRevenue,
        ]),
      ),
    )

  return {
    totalCents: Number(row?.totalCents ?? 0),
    untaggedCents: Number(row?.untaggedCents ?? 0),
  }
}

/**
 * Net assets as the ledger sees them: assets less liabilities.
 *
 * Deliberately not read off the two equity accounts. Those only carry what a
 * year-end close put there (Phase 11), so mid-year they are last year's
 * figures — and a charity's restricted balance in August is the question
 * somebody actually asks in August.
 */
async function totalNetAssets(ctx: ActorContext, asOf: string): Promise<number> {
  const through = nextDay(asOf)

  const [row] = await db
    .select({
      cents: sql<string>`
        sum(
          case
            when ${chartAccounts.type} = 'asset'
            then ${journalLines.debitCents} - ${journalLines.creditCents}
            when ${chartAccounts.type} = 'liability'
            then ${journalLines.creditCents} - ${journalLines.debitCents}
            else 0
          end
        )`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lt(journalEntries.entryDate, through),
        inArray(chartAccounts.type, ['asset', 'liability']),
      ),
    )

  // Assets less liabilities *is* net assets, by the accounting equation — so
  // this needs no equity query and cannot disagree with the balance sheet.
  return Number(row?.cents ?? 0)
}
