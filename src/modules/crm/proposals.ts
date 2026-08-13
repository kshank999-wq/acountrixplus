import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  opportunities,
  organizations,
  proposalItems,
  proposalVersions,
  proposalViews,
  proposals,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { logActivity } from './opportunities'
import { PIPELINE_STAGES, STAGE_PROBABILITY, stageIndex } from './pipeline'

/**
 * Proposal lifecycle (spec §7 commercial structure, §9 statuses).
 *
 * Phase 3 covers pricing, statuses, versioning, and view tracking. The visual
 * designer is Phase 4; it will attach layout to these records rather than
 * replacing them, which is why the narrative sections are plain text for now.
 */

export type ProposalStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'won'
  | 'lost'
  | 'expired'
  | 'no_decision'

export type ProposalItemInput = {
  description: string
  quantityMilli?: number
  unitPriceCents: number
  isOptional?: boolean
  isSelected?: boolean
  chartAccountId?: string | null
}

/** Extended amount for a line, rounded half-up to the nearest cent. */
export function itemAmountCents(quantityMilli: number, unitPriceCents: number): number {
  return Math.round((quantityMilli * unitPriceCents) / 1000)
}

/**
 * Proposal totals.
 *
 * Optional items count only when selected (spec §7), so the total always
 * reflects what the client would actually owe.
 */
export function computeTotals(
  items: Array<{ amountCents: number; isOptional: boolean; isSelected: boolean }>,
  opts: { discountCents?: number; taxCents?: number } = {},
) {
  const subtotalCents = items
    .filter((item) => !item.isOptional || item.isSelected)
    .reduce((sum, item) => sum + item.amountCents, 0)

  const discountCents = opts.discountCents ?? 0
  const taxCents = opts.taxCents ?? 0

  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  }
}

/** 32 random bytes: the client link must not be guessable from another. */
function newPublicToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * The probability an opportunity should carry at `stage`, honouring a manual
 * override. Expressed in SQL so a stage advance and its probability move in
 * one statement.
 */
function stageProbabilitySql(stage: keyof typeof STAGE_PROBABILITY) {
  return sql<number>`CASE WHEN ${opportunities.probabilityOverridden}
                          THEN ${opportunities.probability}
                          ELSE ${STAGE_PROBABILITY[stage]} END`
}

export async function createProposal(
  ctx: ActorContext,
  input: {
    opportunityId: string
    title: string
    items: ProposalItemInput[]
    discountCents?: number
    taxCents?: number
    executiveSummary?: string
    scope?: string
    exclusions?: string
    terms?: string
    expiresOn?: string
    number?: string
  },
) {
  requirePermission(ctx, 'proposals:manage')

  const [opportunity] = await db
    .select()
    .from(opportunities)
    .where(scoped(ctx, opportunities, eq(opportunities.id, input.opportunityId)))
    .limit(1)

  if (!opportunity) throw new Error('Opportunity not found')
  if (input.items.length === 0) throw new Error('A proposal needs at least one line item.')

  const items = input.items.map((item, index) => {
    const quantityMilli = item.quantityMilli ?? 1000
    return {
      description: item.description,
      quantityMilli,
      unitPriceCents: item.unitPriceCents,
      amountCents: itemAmountCents(quantityMilli, item.unitPriceCents),
      isOptional: item.isOptional ?? false,
      isSelected: item.isSelected ?? true,
      chartAccountId: item.chartAccountId ?? null,
      sortOrder: index,
    }
  })

  const totals = computeTotals(items, input)

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextProposalNumber(ctx, tx))

    const [proposal] = await tx
      .insert(proposals)
      .values({
        companyId: ctx.companyId,
        opportunityId: input.opportunityId,
        number,
        title: input.title,
        status: 'draft',
        ...totals,
        executiveSummary: input.executiveSummary ?? null,
        scope: input.scope ?? null,
        exclusions: input.exclusions ?? null,
        terms: input.terms ?? null,
        publicToken: newPublicToken(),
        expiresOn: input.expiresOn ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(proposalItems).values(
      items.map((item) => ({ companyId: ctx.companyId, proposalId: proposal.id, ...item })),
    )

    await logActivity(
      ctx,
      input.opportunityId,
      { kind: 'proposal_created', summary: `Proposal ${number} drafted` },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'proposal.create',
        entityType: 'proposal',
        entityId: proposal.id,
        after: { number, title: input.title, totalCents: totals.totalCents },
      },
      tx,
    )

    return proposal
  })
}

/**
 * Marks a proposal as sent and snapshots it (spec §7).
 *
 * The snapshot is what makes the client-facing link trustworthy: once someone
 * has been shown a price, editing the proposal produces a new version rather
 * than silently changing what they were quoted. It also moves the opportunity
 * to `proposal_sent`, so the pipeline reflects reality without a second step.
 */
export async function sendProposal(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)
  if (proposal.status === 'won' || proposal.status === 'lost') {
    throw new Error('That proposal has already been decided.')
  }

  const items = await db
    .select()
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(asc(proposalItems.sortOrder))

  return db.transaction(async (tx) => {
    const [{ nextVersion }] = await tx
      .select({ nextVersion: sql<number>`coalesce(max(${proposalVersions.versionNumber}), 0) + 1` })
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposalId))

    await tx.insert(proposalVersions).values({
      companyId: ctx.companyId,
      proposalId,
      versionNumber: nextVersion,
      snapshot: {
        title: proposal.title,
        number: proposal.number,
        executiveSummary: proposal.executiveSummary,
        scope: proposal.scope,
        exclusions: proposal.exclusions,
        terms: proposal.terms,
        subtotalCents: proposal.subtotalCents,
        discountCents: proposal.discountCents,
        taxCents: proposal.taxCents,
        totalCents: proposal.totalCents,
        expiresOn: proposal.expiresOn,
        items: items.map((item) => ({
          description: item.description,
          quantityMilli: item.quantityMilli,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          isOptional: item.isOptional,
          isSelected: item.isSelected,
        })),
      },
      totalCents: proposal.totalCents,
      sentBy: ctx.userId,
    })

    const [updated] = await tx
      .update(proposals)
      .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, ctx.companyId)))
      .returning()

    // Keep the pipeline honest without making the user do it twice — but only
    // ever forwards. Resending a revised proposal to a deal already in
    // negotiation must not drag it back to "proposal sent", which would both
    // misstate where the deal is and reset its forecast weight.
    const earlierStages = PIPELINE_STAGES.slice(0, stageIndex('proposal_sent')).map((s) => s.key)

    await tx
      .update(opportunities)
      .set({
        stage: 'proposal_sent',
        // Follows the stage, unless a hand-set probability says otherwise —
        // the same rule `changeStage` applies.
        probability: stageProbabilitySql('proposal_sent'),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(opportunities.id, proposal.opportunityId),
          eq(opportunities.companyId, ctx.companyId),
          inArray(opportunities.stage, earlierStages),
        ),
      )

    await logActivity(
      ctx,
      proposal.opportunityId,
      {
        kind: 'proposal_sent',
        summary: `Proposal ${proposal.number} sent (version ${nextVersion})`,
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'proposal.send',
        entityType: 'proposal',
        entityId: proposalId,
        before: { status: proposal.status },
        after: { status: 'sent', version: nextVersion, totalCents: proposal.totalCents },
      },
      tx,
    )

    return { proposal: updated, versionNumber: nextVersion }
  })
}

/**
 * Records a client view of the proposal link (spec §9).
 *
 * Called from the public route, so it takes no actor: the viewer is the
 * client, not a user of the system. It only ever appends a view and advances
 * `sent` to `viewed` — it cannot change pricing or status beyond that.
 */
export async function recordView(
  publicToken: string,
  meta: { ipPrefix?: string | null; userAgent?: string | null },
) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal) return null

  await db.transaction(async (tx) => {
    await tx.insert(proposalViews).values({
      companyId: proposal.companyId,
      proposalId: proposal.id,
      ipPrefix: meta.ipPrefix ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })

    await tx
      .update(proposals)
      .set({
        // Only 'sent' advances; a decided proposal keeps its outcome.
        status: proposal.status === 'sent' ? 'viewed' : proposal.status,
        firstViewedAt: proposal.firstViewedAt ?? new Date(),
        lastViewedAt: new Date(),
        viewCount: proposal.viewCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, proposal.id))

    if (proposal.status === 'sent') {
      await tx
        .update(opportunities)
        .set({
          stage: 'viewed',
          probability: stageProbabilitySql('viewed'),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(opportunities.id, proposal.opportunityId),
            eq(opportunities.companyId, proposal.companyId),
            // Forward only: a deal already past "viewed" stays where it is.
            eq(opportunities.stage, 'proposal_sent'),
          ),
        )
    }
  })

  return proposal
}

/** Records the client's decision on a proposal (spec §9). */
export async function decideProposal(
  ctx: ActorContext,
  proposalId: string,
  status: 'won' | 'lost' | 'expired' | 'no_decision',
) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)
  if (proposal.status === 'draft') {
    throw new Error('Send the proposal before recording a decision on it.')
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(proposals)
      .set({ status, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, ctx.companyId)))
      .returning()

    await logActivity(
      ctx,
      proposal.opportunityId,
      { kind: 'proposal_decided', summary: `Proposal ${proposal.number} marked ${status}` },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'proposal.decide',
        entityType: 'proposal',
        entityId: proposalId,
        before: { status: proposal.status },
        after: { status },
      },
      tx,
    )

    return updated
  })
}

/** Replaces a draft proposal's line items and recomputes its totals. */
export async function updateProposalItems(
  ctx: ActorContext,
  proposalId: string,
  items: ProposalItemInput[],
  opts: { discountCents?: number; taxCents?: number } = {},
) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)
  if (items.length === 0) throw new Error('A proposal needs at least one line item.')

  const prepared = items.map((item, index) => {
    const quantityMilli = item.quantityMilli ?? 1000
    return {
      description: item.description,
      quantityMilli,
      unitPriceCents: item.unitPriceCents,
      amountCents: itemAmountCents(quantityMilli, item.unitPriceCents),
      isOptional: item.isOptional ?? false,
      isSelected: item.isSelected ?? true,
      chartAccountId: item.chartAccountId ?? null,
      sortOrder: index,
    }
  })

  const totals = computeTotals(prepared, {
    discountCents: opts.discountCents ?? proposal.discountCents,
    taxCents: opts.taxCents ?? proposal.taxCents,
  })

  return db.transaction(async (tx) => {
    await tx
      .delete(proposalItems)
      .where(
        and(
          eq(proposalItems.proposalId, proposalId),
          eq(proposalItems.companyId, ctx.companyId),
        ),
      )

    await tx.insert(proposalItems).values(
      prepared.map((item) => ({ companyId: ctx.companyId, proposalId, ...item })),
    )

    const [updated] = await tx
      .update(proposals)
      .set({ ...totals, updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, ctx.companyId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'proposal.update',
        entityType: 'proposal',
        entityId: proposalId,
        before: { totalCents: proposal.totalCents },
        after: { totalCents: totals.totalCents, lineCount: prepared.length },
      },
      tx,
    )

    return updated
  })
}

async function loadProposal(ctx: ActorContext, proposalId: string) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  if (!proposal) throw new Error('Proposal not found')
  return proposal
}

export async function getProposal(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:view')

  const proposal = await loadProposal(ctx, proposalId)
  const items = await db
    .select()
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(asc(proposalItems.sortOrder))

  const versions = await db
    .select({
      versionNumber: proposalVersions.versionNumber,
      totalCents: proposalVersions.totalCents,
      sentAt: proposalVersions.sentAt,
    })
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposalId))
    .orderBy(desc(proposalVersions.versionNumber))

  return { proposal, items, versions }
}

export async function listProposals(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'proposals:view')

  return db
    .select({
      id: proposals.id,
      number: proposals.number,
      title: proposals.title,
      status: proposals.status,
      totalCents: proposals.totalCents,
      sentAt: proposals.sentAt,
      viewCount: proposals.viewCount,
      lastViewedAt: proposals.lastViewedAt,
      expiresOn: proposals.expiresOn,
      opportunityId: proposals.opportunityId,
      organizationName: organizations.name,
    })
    .from(proposals)
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(scoped(ctx, proposals))
    .orderBy(desc(proposals.updatedAt))
    .limit(opts.limit ?? 200)
}

/** The public, read-only shape shown at the client-facing link. */
export async function proposalByToken(publicToken: string) {
  const [row] = await db
    .select({
      proposal: proposals,
      organizationName: organizations.name,
    })
    .from(proposals)
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!row) return null

  const items = await db
    .select()
    .from(proposalItems)
    .where(eq(proposalItems.proposalId, row.proposal.id))
    .orderBy(asc(proposalItems.sortOrder))

  return { ...row, items }
}

async function nextProposalNumber(ctx: ActorContext, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(proposals)
    .where(eq(proposals.companyId, ctx.companyId))

  return `PROP-${1001 + Number(row?.count ?? 0)}`
}
