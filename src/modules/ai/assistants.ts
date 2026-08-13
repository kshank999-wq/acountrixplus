import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactions,
  bills,
  contacts,
  customers,
  invoices,
  opportunities,
  organizations,
  proposals,
  reconciliations,
  segments,
} from '@/db/schema'
import { formatCents } from '@/lib/money'
import { formatBasisPoints } from '@/modules/crm/analytics'
import { can, scoped, type ActorContext } from '@/modules/tenancy/context'
import { ask } from './gateway'
import { companyContext, renderServices, renderTransactions } from './retrieval'
import {
  campaignDraftJsonSchema,
  campaignDraftSchema,
  insightsJsonSchema,
  insightsSchema,
  proposalDraftJsonSchema,
  proposalDraftSchema,
  reconciliationJsonSchema,
  reconciliationSchema,
} from './schemas'
import { recordSuggestion } from './suggestions'

/**
 * The remaining assistants from spec §11: reconciliation, the proposal
 * writer, the marketing assistant, and business insights.
 *
 * The bookkeeping assistant lives in its own module because it is the one
 * that can reach the ledger. These four produce text and explanations — a
 * draft that an author edits, an explanation somebody reads. None of them
 * writes to an account.
 *
 * Every one still assembles its context through the retrieval layer, so the
 * permission rules hold: an assistant cannot show you a figure you would not
 * be allowed to look up.
 */

// --- Reconciliation --------------------------------------------------------

export async function explainReconciliation(ctx: ActorContext, reconciliationId: string) {
  if (!can(ctx, 'reconciliation:view')) {
    return {
      ok: false as const,
      message: 'Your role does not include reconciliation.',
      reason: 'permission',
    }
  }

  const [session] = await db
    .select()
    .from(reconciliations)
    .where(scoped(ctx, reconciliations, eq(reconciliations.id, reconciliationId)))
    .limit(1)

  if (!session) {
    return { ok: false as const, message: 'That reconciliation was not found.', reason: 'not_found' }
  }

  // What has been cleared so far, against what the statement says.
  const [cleared] = await db
    .select({ total: sql<string>`coalesce(sum(${bankTransactions.amountCents}), 0)` })
    .from(bankTransactions)
    .where(
      scoped(ctx, bankTransactions, eq(bankTransactions.reconciliationId, reconciliationId)),
    )

  const clearedCents = Number(cleared?.total ?? 0)
  // The same arithmetic the reconciliation workspace shows: what the
  // statement says the account moved by, less what has actually been ticked.
  const differenceCents =
    session.statementEndingBalanceCents - session.beginningBalanceCents - clearedCents

  const candidates = await db
    .select({
      id: bankTransactions.id,
      postedDate: bankTransactions.postedDate,
      description: bankTransactions.description,
      merchantName: bankTransactions.merchantName,
      amountCents: bankTransactions.amountCents,
    })
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        eq(bankTransactions.financialAccountId, session.financialAccountId),
        sql`${bankTransactions.reconciliationId} IS NULL`,
      ),
    )
    .limit(60)

  const result = await ask(ctx, {
    feature: 'reconciliation_explain',
    promptKey: 'reconciliation.explain',
    values: {
      difference: formatCents(differenceCents),
      unclearedCount: String(candidates.length),
      candidates: renderTransactions(candidates),
    },
    input: { differenceCents, unclearedCount: candidates.length, candidates },
    schema: reconciliationSchema,
    jsonSchema: reconciliationJsonSchema,
    effort: 'medium',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  const known = new Set(candidates.map((row) => row.id))
  const byId = new Map(candidates.map((row) => [row.id, row]))

  return {
    ok: true as const,
    differenceCents,
    explanation: result.data.explanation,
    likelyCauses: result.data.likelyCauses,
    // Only transactions we actually supplied, resolved back to real rows so
    // the UI can offer to clear them.
    suggested: result.data.suggestedTransactionIds
      .filter((id) => known.has(id))
      .map((id) => byId.get(id)!)
      .filter(Boolean),
  }
}

// --- Proposal writer -------------------------------------------------------

export async function draftProposalSections(ctx: ActorContext, opportunityId: string) {
  if (!can(ctx, 'proposals:manage')) {
    return {
      ok: false as const,
      message: 'Your role does not include writing proposals.',
      reason: 'permission',
    }
  }

  const [row] = await db
    .select({ opportunity: opportunities, organization: organizations })
    .from(opportunities)
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(scoped(ctx, opportunities, eq(opportunities.id, opportunityId)))
    .limit(1)

  if (!row) {
    return { ok: false as const, message: 'That opportunity was not found.', reason: 'not_found' }
  }

  const company = await companyContext(ctx)

  const result = await ask(ctx, {
    feature: 'proposal_draft',
    promptKey: 'proposal.draft',
    values: {
      companyName: company?.name ?? 'our company',
      industryLine: company?.industry ? ` (${company.industry})` : '',
      clientName: row.organization.name,
      opportunityTitle: row.opportunity.title,
      expectedValue: formatCents(row.opportunity.expectedValueCents ?? 0),
      services: company ? renderServices(company.services) : '(no catalog)',
    },
    input: {
      companyName: company?.name,
      industry: company?.industry,
      clientName: row.organization.name,
      opportunityTitle: row.opportunity.title,
      expectedValueCents: row.opportunity.expectedValueCents,
      services: company?.services ?? [],
    },
    schema: proposalDraftSchema,
    jsonSchema: proposalDraftJsonSchema,
    maxOutputTokens: 4096,
    effort: 'high',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  // Recorded as a suggestion rather than written into a proposal. A draft is
  // the author's raw material; they decide what survives contact with a
  // client, and spec §11 asks for "provenance" on generated content.
  const suggestion = await recordSuggestion(ctx, {
    feature: 'proposal_draft',
    entityType: 'opportunity',
    entityId: opportunityId,
    payload: result.data,
    rationale: 'Drafted from your service catalog and this opportunity.',
    requestId: result.requestId,
  })

  return { ok: true as const, suggestionId: suggestion.id, draft: result.data }
}

/** The draft for an opportunity, for prefilling the proposal form. */
export async function proposalDraftFor(ctx: ActorContext, opportunityId: string) {
  const [row] = await db
    .select()
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.opportunityId, opportunityId)))
    .limit(1)

  return row ?? null
}

// --- Marketing assistant ---------------------------------------------------

export async function draftCampaignCopy(
  ctx: ActorContext,
  input: { segmentId?: string | null; goal: string },
) {
  if (!can(ctx, 'marketing:manage')) {
    return {
      ok: false as const,
      message: 'Your role does not include marketing.',
      reason: 'permission',
    }
  }

  const company = await companyContext(ctx)

  let segmentName = 'everyone'
  let audienceSize = 0

  if (input.segmentId) {
    const [segment] = await db
      .select()
      .from(segments)
      .where(scoped(ctx, segments, eq(segments.id, input.segmentId)))
      .limit(1)

    if (segment) segmentName = segment.name
  }

  const [contactable] = await db
    .select({ count: sql<string>`count(*)` })
    .from(contacts)
    .where(scoped(ctx, contacts, eq(contacts.emailConsent, 'subscribed')))

  audienceSize = Number(contactable?.count ?? 0)

  const result = await ask(ctx, {
    feature: 'marketing_draft',
    promptKey: 'marketing.draft',
    values: {
      companyName: company?.name ?? 'our company',
      segmentName,
      audienceSize: String(audienceSize),
      goal: input.goal,
    },
    input: { companyName: company?.name, segmentName, audienceSize, goal: input.goal },
    schema: campaignDraftSchema,
    jsonSchema: campaignDraftJsonSchema,
    maxOutputTokens: 3000,
    effort: 'medium',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  const suggestion = await recordSuggestion(ctx, {
    feature: 'marketing_draft',
    entityType: 'campaign',
    entityId: input.segmentId ?? null,
    payload: result.data,
    rationale: result.data.rationale,
    requestId: result.requestId,
  })

  return { ok: true as const, suggestionId: suggestion.id, draft: result.data }
}

// --- Business insights -----------------------------------------------------

/**
 * Explains the business in plain language (spec §11).
 *
 * Assembles only what the actor may read. A role without `reports:view` gets
 * an insight built from whatever else it can see — or nothing, which is the
 * honest answer rather than a fabricated one.
 */
export async function businessInsights(ctx: ActorContext) {
  if (!can(ctx, 'reports:view')) {
    return {
      ok: false as const,
      message: 'Your role does not include financial reporting.',
      reason: 'permission',
    }
  }

  const [receivable] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoices.balanceCents}), 0)`,
      overdue: sql<string>`coalesce(sum(${invoices.balanceCents}) FILTER (WHERE ${invoices.dueDate} < CURRENT_DATE), 0)`,
    })
    .from(invoices)
    .where(scoped(ctx, invoices, sql`${invoices.status} <> 'void'`))

  const [payable] = await db
    .select({ total: sql<string>`coalesce(sum(${bills.balanceCents}), 0)` })
    .from(bills)
    .where(scoped(ctx, bills, sql`${bills.status} <> 'void'`))

  const [cash] = await db
    .select({ total: sql<string>`coalesce(sum(${bankTransactions.amountCents}), 0)` })
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions))

  // Revenue concentration: the largest client's share of invoiced revenue.
  const byCustomer = await db
    .select({
      name: customers.name,
      total: sql<string>`coalesce(sum(${invoices.totalCents}), 0)`,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(scoped(ctx, invoices, sql`${invoices.status} <> 'void'`))
    .groupBy(customers.name)
    .orderBy(sql`coalesce(sum(${invoices.totalCents}), 0) desc`)

  const invoicedTotal = byCustomer.reduce((sum, row) => sum + Number(row.total), 0)
  const topCustomer = byCustomer[0]
  const concentrationBp =
    invoicedTotal > 0 && topCustomer
      ? Math.round((Number(topCustomer.total) / invoicedTotal) * 10_000)
      : 0

  // Win rate, only if this role may see the pipeline.
  let winRateBp = 0
  if (can(ctx, 'crm:view')) {
    const [outcomes] = await db
      .select({
        won: sql<string>`count(*) FILTER (WHERE ${opportunities.stage} = 'won')`,
        closed: sql<string>`count(*) FILTER (WHERE ${opportunities.stage} IN ('won','lost','dormant'))`,
      })
      .from(opportunities)
      .where(scoped(ctx, opportunities))

    const closed = Number(outcomes?.closed ?? 0)
    winRateBp = closed === 0 ? 0 : Math.round((Number(outcomes?.won ?? 0) / closed) * 10_000)
  }

  const figures = {
    cashBalanceCents: Number(cash?.total ?? 0),
    receivableCents: Number(receivable?.total ?? 0),
    overdueReceivableCents: Number(receivable?.overdue ?? 0),
    payableCents: Number(payable?.total ?? 0),
    winRateBp,
    revenueConcentrationBp: concentrationBp,
    topCustomerName: topCustomer?.name ?? '',
  }

  const result = await ask(ctx, {
    feature: 'business_insights',
    promptKey: 'insights.business',
    values: {
      cashBalance: formatCents(figures.cashBalanceCents),
      receivable: formatCents(figures.receivableCents),
      overdueReceivable: formatCents(figures.overdueReceivableCents),
      payable: formatCents(figures.payableCents),
      winRate: winRateBp > 0 ? formatBasisPoints(winRateBp) : 'not enough closed deals',
      concentration: concentrationBp > 0 ? formatBasisPoints(concentrationBp) : 'no invoices yet',
      topCustomerLine: topCustomer ? `\nLargest client: ${topCustomer.name}` : '',
    },
    input: figures,
    schema: insightsSchema,
    jsonSchema: insightsJsonSchema,
    maxOutputTokens: 3000,
    effort: 'high',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  return { ok: true as const, insights: result.data.insights, figures }
}
