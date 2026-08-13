import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { opportunities, organizations, proposals, users } from '@/db/schema'
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
  /** Mean days from creation to close, across decided opportunities. */
  averageDaysToDecision: number
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
    averageDaysToDecision:
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
export async function breakdownBy(
  ctx: ActorContext,
  dimension: 'owner' | 'source' | 'industry' | 'region',
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

function groupKey(
  dimension: 'owner' | 'source' | 'industry' | 'region',
  row: {
    ownerId: string | null
    ownerName: string | null
    source: string | null
    industry: string | null
    region: string | null
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

  return {
    byStatus,
    totalCount: rows.length,
    totalValueCents: sum(rows.map((r) => r.totalCents)),
    viewRateBp: basisPoints(opened.length, reachedClient.length),
  }
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
