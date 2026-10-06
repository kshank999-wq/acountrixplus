import { and, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import {
  invoiceLines,
  invoices,
  opportunities,
  organizations,
  proposalItems,
  proposals,
  serviceItems,
  users,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { basisPoints } from '@/lib/ratio'
import { OPEN_STAGES, weightedValueCents } from './pipeline'

/**
 * Proposal analytics and the sales dashboard (spec §9).
 *
 * Every figure is derived from opportunities and proposals at read time. Rates
 * are returned as basis points rather than floats so a percentage is an exact
 * integer, consistent with how money is handled everywhere else.
 */

export type DateRange = { startDate?: string; endDate?: string }

/** A ratio in basis points: 6250 is 62.50%. Returns 0 when there is no base. */
// Moved to `lib/ratio` in Phase 7 so client components can use them without
// pulling the database driver into the browser bundle. Re-exported here
// because the whole CRM already imports them from this module.
export { basisPoints, formatBasisPoints } from '@/lib/ratio'

export type WinLossSummary = {
  wonCount: number
  lostCount: number
  dormantCount: number
  openCount: number

  wonValueCents: number
  lostValueCents: number
  openValueCents: number
  /** Open value weighted by each opportunity's probability. */
  forecastValueCents: number

  /** Won ÷ (won + lost), in basis points. */
  winRateByCountBp: number
  winRateByValueBp: number

  averageWonValueCents: number
  /**
   * Mean days from an opportunity being created to it being closed.
   *
   * **Renamed in Phase 168, and the old name was the defect.** This was
   * `averageDaysToDecision` and the dashboard labelled it *"Days to
   * decision"* — which reads as how long the client took to answer, and is in
   * fact how long the whole deal took from first inquiry. A deal that sat as a
   * lead for three months and was answered in a day counted as ninety-odd days
   * of "decision".
   *
   * §9's *"average time to decision"* is the other interval, and it is
   * `ProposalStats.averageDaysToDecision` — proposal sent to proposal decided.
   * Both are worth having and they are not the same question, so neither may
   * carry a name that could mean the other.
   */
  averageDaysToClose: number
}

/**
 * Headline win/loss figures (spec §9).
 *
 * Win rate excludes dormant opportunities from the denominator: a deal that
 * went quiet was never decided, and counting it as a loss understates the rate
 * against deals that actually reached a decision. Dormant is reported on its
 * own so it stays visible.
 */
export async function winLossSummary(
  ctx: ActorContext,
  range: DateRange = {},
): Promise<WinLossSummary> {
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      stage: opportunities.stage,
      expectedValueCents: opportunities.expectedValueCents,
      probability: opportunities.probability,
      createdAt: opportunities.createdAt,
      closedAt: opportunities.closedAt,
    })
    .from(opportunities)
    .where(scoped(ctx, opportunities, ...rangeConditions(range)))

  const won = rows.filter((r) => r.stage === 'won')
  const lost = rows.filter((r) => r.stage === 'lost')
  const dormant = rows.filter((r) => r.stage === 'dormant')
  const open = rows.filter((r) => (OPEN_STAGES as string[]).includes(r.stage))

  const wonValueCents = sum(won.map((r) => r.expectedValueCents))
  const lostValueCents = sum(lost.map((r) => r.expectedValueCents))
  const openValueCents = sum(open.map((r) => r.expectedValueCents))
  const forecastValueCents = sum(
    open.map((r) => weightedValueCents(r.expectedValueCents, r.probability)),
  )

  const decided = [...won, ...lost]
  const decidedDays = decided
    .filter((r) => r.closedAt)
    .map((r) => daysBetween(r.createdAt, r.closedAt!))

  return {
    wonCount: won.length,
    lostCount: lost.length,
    dormantCount: dormant.length,
    openCount: open.length,

    wonValueCents,
    lostValueCents,
    openValueCents,
    forecastValueCents,

    winRateByCountBp: basisPoints(won.length, won.length + lost.length),
    winRateByValueBp: basisPoints(wonValueCents, wonValueCents + lostValueCents),

    averageWonValueCents: won.length === 0 ? 0 : Math.round(wonValueCents / won.length),
    averageDaysToClose:
      decidedDays.length === 0 ? 0 : Math.round(sum(decidedDays) / decidedDays.length),
  }
}

export type BreakdownRow = {
  key: string
  label: string
  wonCount: number
  lostCount: number
  openCount: number
  wonValueCents: number
  winRateBp: number
}

/**
 * Performance grouped by a dimension (spec §9: by salesperson, source,
 * industry, and so on).
 *
 * Grouping happens in code rather than SQL because the label for each key
 * comes from a different table per dimension, and the row counts here are
 * small enough that a second pass costs nothing.
 */
/**
 * The dimensions a breakdown can group by (spec §9).
 *
 * `month` and `quarter` are Phase 168's answer to §9's *"performance by time
 * period"*, and they group on **`created_at`** like every other dimension here
 * — a cohort, not a calendar of outcomes.
 *
 * That choice needs stating because the other reading is tempting and wrong.
 * Keyed on the close date, a period's win rate would mix deals that arrived
 * years apart, and an open deal would have no period at all — so the open
 * column would be empty and the rate would look like a complete picture of a
 * period while describing only its decided half. Keyed on creation, a row says
 * *"of the deals that arrived in this period, this is how they have turned
 * out"*, which is a claim the open column belongs in.
 *
 * It also matches `rangeConditions`, which already filters on `created_at`. A
 * filter and a grouping that disagreed about which date they meant would be two
 * answers to one question inside one function.
 */
export type BreakdownDimension = 'owner' | 'source' | 'industry' | 'region' | 'month' | 'quarter'

export async function breakdownBy(
  ctx: ActorContext,
  dimension: BreakdownDimension,
  range: DateRange = {},
): Promise<BreakdownRow[]> {
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      stage: opportunities.stage,
      expectedValueCents: opportunities.expectedValueCents,
      ownerId: opportunities.ownerId,
      ownerName: users.name,
      source: opportunities.source,
      industry: organizations.industry,
      region: organizations.region,
      createdAt: opportunities.createdAt,
    })
    .from(opportunities)
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .leftJoin(users, eq(users.id, opportunities.ownerId))
    .where(scoped(ctx, opportunities, ...rangeConditions(range)))

  const groups = new Map<string, BreakdownRow>()

  for (const row of rows) {
    const { key, label } = groupKey(dimension, row)

    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label,
        wonCount: 0,
        lostCount: 0,
        openCount: 0,
        wonValueCents: 0,
        winRateBp: 0,
      }
      groups.set(key, group)
    }

    if (row.stage === 'won') {
      group.wonCount++
      group.wonValueCents += row.expectedValueCents
    } else if (row.stage === 'lost') {
      group.lostCount++
    } else if ((OPEN_STAGES as string[]).includes(row.stage)) {
      group.openCount++
    }
  }

  const result = [...groups.values()]
  for (const group of result) {
    group.winRateBp = basisPoints(group.wonCount, group.wonCount + group.lostCount)
  }

  return result.sort((a, b) => b.wonValueCents - a.wonValueCents)
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * The key is sortable and the label is readable, which is why they differ.
 *
 * `2026-04` sorts; *"April 2026"* reads. A single string cannot do both, and
 * the breakdown is sorted by won value rather than by key — so a caller that
 * wants chronological order sorts on `key`, and it works because the key is
 * zero-padded. UTC throughout, for the reason every other date in this
 * codebase is: a company's month boundary is not the server's.
 */
function periodKey(dimension: 'month' | 'quarter', at: Date): { key: string; label: string } {
  const year = at.getUTCFullYear()
  const month = at.getUTCMonth()

  if (dimension === 'quarter') {
    const quarter = Math.floor(month / 3) + 1
    return { key: `${year}-Q${quarter}`, label: `Q${quarter} ${year}` }
  }

  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    label: `${MONTH_NAMES[month]} ${year}`,
  }
}

function groupKey(
  dimension: BreakdownDimension,
  row: {
    ownerId: string | null
    ownerName: string | null
    source: string | null
    industry: string | null
    region: string | null
    createdAt: Date
  },
): { key: string; label: string } {
  switch (dimension) {
    case 'owner':
      return { key: row.ownerId ?? 'unassigned', label: row.ownerName ?? 'Unassigned' }
    case 'source':
      return { key: row.source ?? 'unknown', label: row.source ?? 'Unknown source' }
    case 'industry':
      return { key: row.industry ?? 'unknown', label: row.industry ?? 'Unspecified industry' }
    case 'region':
      return { key: row.region ?? 'unknown', label: row.region ?? 'Unspecified region' }
    case 'month':
    case 'quarter':
      return periodKey(dimension, row.createdAt)
  }
}

export type LossReasonRow = {
  reason: string
  count: number
  valueCents: number
  shareBp: number
}

/** Why deals were lost (spec §9: lost-opportunity dashboard). */
export async function lossReasons(
  ctx: ActorContext,
  range: DateRange = {},
): Promise<{ rows: LossReasonRow[]; totalCount: number; reEngageableCount: number }> {
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      lossReason: opportunities.lossReason,
      expectedValueCents: opportunities.expectedValueCents,
      marketingEligible: opportunities.marketingEligible,
    })
    .from(opportunities)
    .where(
      scoped(
        ctx,
        opportunities,
        inArray(opportunities.stage, ['lost', 'dormant']),
        ...rangeConditions(range),
      ),
    )

  const grouped = new Map<string, { count: number; valueCents: number }>()
  for (const row of rows) {
    const reason = row.lossReason ?? 'other'
    const entry = grouped.get(reason) ?? { count: 0, valueCents: 0 }
    entry.count++
    entry.valueCents += row.expectedValueCents
    grouped.set(reason, entry)
  }

  const totalCount = rows.length

  return {
    rows: [...grouped.entries()]
      .map(([reason, entry]) => ({
        reason,
        count: entry.count,
        valueCents: entry.valueCents,
        shareBp: basisPoints(entry.count, totalCount),
      }))
      .sort((a, b) => b.count - a.count),
    totalCount,
    // Spec §9: which lost deals may be handed to marketing nurture.
    reEngageableCount: rows.filter((r) => r.marketingEligible).length,
  }
}

export type ProposalStats = {
  byStatus: Record<string, { count: number; valueCents: number }>
  totalCount: number
  totalValueCents: number
  /** Sent proposals that were opened at least once, in basis points. */
  viewRateBp: number

  /**
   * §9's **average proposal size**.
   *
   * Distinct from `WinLossSummary.averageWonValueCents`, which is the mean
   * `expected_value_cents` of a won *opportunity* — a figure somebody guessed
   * when the deal was created. This is the mean total of a priced document with
   * line items behind it. The two can differ by a lot, and the gap between them
   * is itself informative: it says how well the business estimates.
   *
   * Drafts are included, because a draft is a proposal somebody has priced. The
   * `byStatus` map is there for anybody who wants it narrower.
   */
  averageValueCents: number

  /**
   * §9's **average time to decision**: proposal sent to proposal decided.
   *
   * The audit said this needed *"a fact nothing currently records per
   * proposal"*. Measured, both ends have been recorded since Phase 3 —
   * `sent_at` by `sendProposal`, `decided_at` by `decideProposal` and by the
   * public acceptance path. Nothing computed it, which is a different problem
   * from nothing recording it.
   *
   * Counted only over proposals with **both** timestamps, so the denominator is
   * proposals that actually went out and came back. `decidedCount` is returned
   * beside it rather than left implicit, because a mean over three proposals
   * and a mean over three hundred are different claims and the figure alone
   * cannot tell them apart.
   */
  averageDaysToDecision: number
  decidedCount: number
}

/** Proposal counts and value by status (spec §9). */
export async function proposalStats(
  ctx: ActorContext,
  range: DateRange = {},
): Promise<ProposalStats> {
  requirePermission(ctx, 'proposals:view')

  const conditions: (SQL | undefined)[] = [
    range.startDate ? gte(proposals.createdAt, new Date(range.startDate)) : undefined,
    range.endDate ? lte(proposals.createdAt, new Date(`${range.endDate}T23:59:59Z`)) : undefined,
  ]

  const rows = await db
    .select({
      status: proposals.status,
      totalCents: proposals.totalCents,
      viewCount: proposals.viewCount,
      sentAt: proposals.sentAt,
      decidedAt: proposals.decidedAt,
    })
    .from(proposals)
    .where(scoped(ctx, proposals, ...conditions))

  const byStatus: Record<string, { count: number; valueCents: number }> = {}
  for (const row of rows) {
    const entry = byStatus[row.status] ?? { count: 0, valueCents: 0 }
    entry.count++
    entry.valueCents += row.totalCents
    byStatus[row.status] = entry
  }

  // Only proposals that actually reached a client can be viewed.
  const reachedClient = rows.filter((r) => r.status !== 'draft')
  const opened = reachedClient.filter((r) => r.viewCount > 0)

  /*
    Both ends required. A proposal with a decision and no `sent_at` would be one
    somebody marked won without sending — possible, and not an interval.
  */
  const decidedDays = rows
    .filter((r) => r.sentAt !== null && r.decidedAt !== null)
    .map((r) => daysBetween(r.sentAt!, r.decidedAt!))

  const totalValueCents = sum(rows.map((r) => r.totalCents))

  return {
    byStatus,
    totalCount: rows.length,
    totalValueCents,
    viewRateBp: basisPoints(opened.length, reachedClient.length),
    averageValueCents: rows.length === 0 ? 0 : Math.round(totalValueCents / rows.length),
    averageDaysToDecision:
      decidedDays.length === 0 ? 0 : Math.round(sum(decidedDays) / decidedDays.length),
    decidedCount: decidedDays.length,
  }
}

export type ServiceBreakdownRow = {
  /** The service item's id, or `'uncatalogued'`. */
  key: string
  label: string
  /** The catalogue code, when there is one. */
  code: string | null
  /** Proposal **lines**, not deals. */
  lineCount: number
  wonLineCount: number
  lostLineCount: number
  openLineCount: number
  wonValueCents: number
  lostValueCents: number
  openValueCents: number
  /** Won line value ÷ decided line value, in basis points. */
  winRateByValueBp: number
}

/**
 * Performance by service or product (spec §9), and **not** a `breakdownBy`
 * dimension.
 *
 * `breakdownBy` groups *opportunities*: its `wonCount` is a number of deals.
 * A service lives on a proposal **line**, and one proposal can carry six
 * products, so grouping by service changes the grain. Returning a `BreakdownRow`
 * from it would put line counts in a field every other caller reads as deals —
 * a false declaration of the kind Phases 110 and 125 found, and the reason this
 * has its own row type with `lineCount` in the name of every count.
 *
 * ## The uncatalogued group is reported, never dropped
 *
 * `item_id` is nullable because a line typed by hand is a real line.
 * Those lines are grouped under `'uncatalogued'` and shown, because a breakdown
 * that quietly omitted them would have a total that disagrees with
 * `proposalStats.totalValueCents` — and the person reading it would have no way
 * to know which figure to trust.
 *
 * Expect that group to hold everything at first. Nothing recorded the catalogue
 * item before Phase 168 and there was no honest way to backfill it, so the row
 * labelled *"Not from the catalogue"* is the measurement, not a gap in the
 * report.
 *
 * ## A line is attributed to its proposal's outcome
 *
 * Won and lost follow the proposal's status, not the opportunity's. A proposal
 * is the offer that named the product; if the deal was later won on a second,
 * different proposal, this product was in the one that lost. Optional lines the
 * client declined are excluded from value, because an unselected line was
 * offered and not bought.
 */
export async function serviceBreakdown(
  ctx: ActorContext,
  range: DateRange = {},
): Promise<ServiceBreakdownRow[]> {
  requirePermission(ctx, 'proposals:view')

  const conditions: (SQL | undefined)[] = [
    range.startDate ? gte(proposals.createdAt, new Date(range.startDate)) : undefined,
    range.endDate ? lte(proposals.createdAt, new Date(`${range.endDate}T23:59:59Z`)) : undefined,
  ]

  const rows = await db
    .select({
      itemId: proposalItems.itemId,
      serviceName: serviceItems.name,
      serviceCode: serviceItems.code,
      lineDescription: proposalItems.description,
      amountCents: proposalItems.amountCents,
      isOptional: proposalItems.isOptional,
      isSelected: proposalItems.isSelected,
      status: proposals.status,
    })
    .from(proposalItems)
    .innerJoin(proposals, eq(proposals.id, proposalItems.proposalId))
    /*
      Scoped on the join, not only on the driving table. `scoped(ctx, ...)`
      guards `proposal_items`; the join to the catalogue needs its own company
      predicate, or an `item_id` carrying another tenant's uuid would put that
      tenant's product **name** on this company's report.

      Found by a test in Phase 169, which wrote the same unscoped join in
      `serviceRevenue` and asserted what came back. Phase 149/150's rule reaches
      every table in a statement, not the first one.
    */
    .leftJoin(
      serviceItems,
      and(eq(serviceItems.id, proposalItems.itemId), eq(serviceItems.companyId, ctx.companyId)),
    )
    .where(scoped(ctx, proposalItems, ...conditions))

  const groups = new Map<string, ServiceBreakdownRow>()

  for (const row of rows) {
    // A declined optional line was offered and not bought, so it is neither won
    // nor open. Counted in `lineCount` so the offer is still visible.
    const counted = !(row.isOptional && !row.isSelected)
    const key = row.itemId ?? 'uncatalogued'

    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: row.itemId
          ? // Non-null and not joined. With the Phase 169 foreign key in place
            // a deleted item nulls the column, so this can now only be an id
            // belonging to another company — which is a defect, and the label
            // says so rather than calling it deleted.
            (row.serviceName ?? 'Not in this company’s catalogue')
          : 'Not from the catalogue',
        code: row.serviceCode ?? null,
        lineCount: 0,
        wonLineCount: 0,
        lostLineCount: 0,
        openLineCount: 0,
        wonValueCents: 0,
        lostValueCents: 0,
        openValueCents: 0,
        winRateByValueBp: 0,
      }
      groups.set(key, group)
    }

    group.lineCount++
    if (!counted) continue

    if (row.status === 'won') {
      group.wonLineCount++
      group.wonValueCents += row.amountCents
    } else if (row.status === 'lost' || row.status === 'expired' || row.status === 'no_decision') {
      /*
        Three statuses, one column. `expired` and `no_decision` are decisions
        the client never gave, and leaving them out of the denominator would
        report the win rate against only the proposals somebody chased to an
        answer — which flatters it exactly where a business is weakest.

        This is deliberately the opposite call from `winLossSummary`, which
        excludes `dormant` opportunities. The reason differs with the grain: a
        dormant *deal* may still be alive, while an expired *proposal* is an
        offer that ran out. Said here rather than left as an inconsistency for
        somebody to find.
      */
      group.lostLineCount++
      group.lostValueCents += row.amountCents
    } else {
      group.openLineCount++
      group.openValueCents += row.amountCents
    }
  }

  // Lines whose catalogue item was deleted lose their name on the join; the
  // first row to arrive names the group, so a later null must not overwrite it.
  for (const group of groups.values()) {
    group.winRateByValueBp = basisPoints(
      group.wonValueCents,
      group.wonValueCents + group.lostValueCents,
    )
  }

  return [...groups.values()].sort(
    (a, b) => b.wonValueCents - a.wonValueCents || a.label.localeCompare(b.label),
  )
}

export type ServiceRevenueRow = {
  /** The service item's id, or `'uncatalogued'`. */
  key: string
  label: string
  code: string | null
  lineCount: number
  /** Invoiced in the functional currency, voids excluded. */
  invoicedCents: number
  /** Share of all invoiced line value in the window, in basis points. */
  shareBp: number
}

/**
 * Revenue by service or product, **realised** (spec §9).
 *
 * The other half of `serviceBreakdown`, and the half a business acts on at year
 * end. That one reports what was *offered* and how often it was accepted; this
 * reports what was actually invoiced.
 *
 * ## Which column this reads, and why that is the finding
 *
 * `invoice_lines.item_id` — which has referenced the catalogue since **Phase
 * 14**. ADR 0168 nominated adding `service_item_id` to `invoice_lines` "which
 * turns the same question on realised revenue rather than on offers", and the
 * column it asked for was already there under the other name. Nothing had ever
 * grouped by it: Phase 14 added it to relieve inventory, and relieving
 * inventory is all it was used for.
 *
 * So this capability needed no column and no screen. It needed somebody to
 * notice that the data had been sitting there for a hundred and fifty phases.
 *
 * ## Functional currency, not the invoice's own
 *
 * A line's `amount_cents` is in whatever the customer was billed in, so adding
 * those across invoices in three currencies produces a number that is not money
 * (Phase 129). The share is taken of `functional_total_cents` apportioned by
 * line, which is the invoice's own rate applied to its own lines — never a
 * today-rate on an old invoice.
 */
export async function serviceRevenue(
  ctx: ActorContext,
  range: DateRange = {},
): Promise<ServiceRevenueRow[]> {
  requirePermission(ctx, 'reports:view')

  const conditions: (SQL | undefined)[] = [
    range.startDate ? gte(invoices.issueDate, range.startDate) : undefined,
    range.endDate ? lte(invoices.issueDate, range.endDate) : undefined,
  ]

  const rows = await db
    .select({
      itemId: invoiceLines.itemId,
      serviceName: serviceItems.name,
      serviceCode: serviceItems.code,
      amountCents: invoiceLines.amountCents,
      /*
        The invoice's own total in both currencies, so a line can be converted
        at the rate that invoice was raised at rather than at today's. Carried
        per line rather than looked up, because one query is the point.
      */
      invoiceTotalCents: invoices.totalCents,
      invoiceFunctionalCents: invoices.functionalTotalCents,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    // Scoped on the join — see `serviceBreakdown` above for what goes wrong
    // without it.
    .leftJoin(
      serviceItems,
      and(eq(serviceItems.id, invoiceLines.itemId), eq(serviceItems.companyId, ctx.companyId)),
    )
    .where(scoped(ctx, invoiceLines, ne(invoices.status, 'void'), ...conditions))

  const groups = new Map<string, ServiceRevenueRow>()
  let total = 0

  for (const row of rows) {
    /*
      The line in functional terms: its share of the document, times the
      document's functional total. An invoice already in the functional currency
      has the two totals equal, so this is the identity and costs nothing.

      Apportioning rather than converting is deliberate. Converting each line at
      the invoice's rate and summing would round per line and could miss the
      invoice's own functional total by a cent or two — which is Phase 145's
      defect, a whole that existed before its parts.
    */
    const functionalCents =
      row.invoiceTotalCents === 0
        ? 0
        : Math.round((row.amountCents * row.invoiceFunctionalCents) / row.invoiceTotalCents)

    const key = row.itemId ?? 'uncatalogued'
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: row.itemId
          ? (row.serviceName ?? 'Not in this company’s catalogue')
          : 'Not from the catalogue',
        code: row.serviceCode ?? null,
        lineCount: 0,
        invoicedCents: 0,
        shareBp: 0,
      }
      groups.set(key, group)
    }

    group.lineCount++
    group.invoicedCents += functionalCents
    total += functionalCents
  }

  for (const group of groups.values()) {
    group.shareBp = basisPoints(group.invoicedCents, total)
  }

  return [...groups.values()].sort(
    (a, b) => b.invoicedCents - a.invoicedCents || a.label.localeCompare(b.label),
  )
}

/** Open pipeline by stage, with weighted forecast (spec §9). */
export async function pipelineValue(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')

  const rows = await db
    .select({
      stage: opportunities.stage,
      count: sql<string>`count(*)`,
      valueCents: sql<string>`coalesce(sum(${opportunities.expectedValueCents}), 0)`,
      weightedCents: sql<string>`coalesce(sum(${opportunities.expectedValueCents} * ${opportunities.probability} / 100), 0)`,
    })
    .from(opportunities)
    .where(scoped(ctx, opportunities, inArray(opportunities.stage, OPEN_STAGES)))
    .groupBy(opportunities.stage)

  return rows.map((row) => ({
    stage: row.stage,
    count: Number(row.count),
    valueCents: Number(row.valueCents),
    weightedCents: Number(row.weightedCents),
  }))
}

function rangeConditions(range: DateRange): (SQL | undefined)[] {
  return [
    range.startDate ? gte(opportunities.createdAt, new Date(range.startDate)) : undefined,
    range.endDate
      ? lte(opportunities.createdAt, new Date(`${range.endDate}T23:59:59Z`))
      : undefined,
  ]
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000))
}
