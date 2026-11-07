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
import { cashFlowStatement } from '@/modules/ledger/cash-flow'
import {
  calendarMonth,
  comparativeProfitAndLoss,
  comparisonWindows,
  varianceBasisPoints,
} from '@/modules/ledger/comparative'
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
export async function businessInsights(ctx: ActorContext, at: Date = new Date()) {
  if (!can(ctx, 'reports:view')) {
    return {
      ok: false as const,
      message: 'Your role does not include financial reporting.',
      reason: 'permission',
    }
  }

  const [receivable] = await db
    .select({
      // Home currency, so a euro invoice does not get added to a dollar one
      // (Phase 35).
      total: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}), 0)`,
      overdue: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}) FILTER (WHERE ${invoices.dueDate} < CURRENT_DATE), 0)`,
    })
    .from(invoices)
    .where(scoped(ctx, invoices, sql`${invoices.status} <> 'void'`))

  const [payable] = await db
    .select({ total: sql<string>`coalesce(sum(${bills.functionalBalanceCents}), 0)` })
    .from(bills)
    .where(scoped(ctx, bills, sql`${bills.status} <> 'void'`))

  /**
   * Cash, in the company's own money (Phase 129).
   *
   * This summed `amount_cents` across every account, and an account can be
   * foreign — so on multi-currency books the figure handed to the assistant was
   * euros added to dollars, and it advised the business on that. The same
   * defect Phase 122 fixed two queries above for invoices and bills; the cash
   * line survived because `bank_transactions` had no functional twin to switch
   * to until this phase gave it one.
   *
   * Summing the twin means only what has **posted** counts, which is the
   * honest reading: a transaction still in the inbox has been converted by
   * nobody, so there is no rate at which it could join a total.
   */
  const [cash] = await db
    .select({ total: sql<string>`coalesce(sum(${bankTransactions.functionalAmountCents}), 0)` })
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions))

  /**
   * Revenue concentration: the largest client's share of invoiced revenue.
   *
   * On the **functional** total since Phase 122. This added `total_cents`
   * across currencies and divided, so on multi-currency books the share it
   * advised a business on was arithmetic over incomparable things — a euro
   * invoice counting the same as a dollar one of the same face value.
   */
  const byCustomer = await db
    .select({
      name: customers.name,
      total: sql<string>`coalesce(sum(${invoices.functionalTotalCents}), 0)`,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(scoped(ctx, invoices, sql`${invoices.status} <> 'void'`))
    .groupBy(customers.name)
    .orderBy(sql`coalesce(sum(${invoices.functionalTotalCents}), 0) desc`)

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

  /*
    Expenses, cash movement, and the period before this one (Phase 195).

    §11's Business Insights row names six things to explain, and two of them —
    *"expense changes"* and *"cash-flow trends"* — had no figure behind them.
    There was no expense figure at all, and for cash a single balance, which
    is a position rather than a trend. The prompt's own first rule is that
    *"every insight must be traceable to a figure you were given"*, so it did
    the right thing with what it had: it stayed silent on both, and the silence
    looked like a quiet month rather than a missing input.

    Nothing new is computed here. `comparativeProfitAndLoss` has run two
    columns of a real P&L since §13's comparative periods were built, and
    `cashFlowStatement` has stated where cash started and finished since Phase
    33. These are the calls that were never made.

    Gated on `reports:financial`, the same way the win rate above is gated on
    `crm:view` — a role that may not read the accounts does not get them back
    narrated. Both reads require that permission themselves, so the gate is
    also what keeps this from throwing.
  */
  let expenseCents = 0
  let priorExpenseCents = 0
  let revenueCents = 0
  let priorRevenueCents = 0
  let expenseVarianceBp: number | null = null
  let openingCashCents = 0
  let closingCashCents = 0
  let netCashChangeCents = 0
  let comparedTo = ''
  let periodLabel = ''

  if (can(ctx, 'reports:financial')) {
    const month = calendarMonth(at)
    const periods = comparisonWindows(month, 'prior_period')
    const pnl = await comparativeProfitAndLoss(ctx, { periods })

    const expenses = pnl.operatingExpenses.totalsCents
    const revenue = pnl.revenue.totalsCents

    expenseCents = expenses[0] ?? 0
    priorExpenseCents = expenses[1] ?? 0
    revenueCents = revenue[0] ?? 0
    priorRevenueCents = revenue[1] ?? 0
    expenseVarianceBp = varianceBasisPoints(expenseCents, priorExpenseCents)
    comparedTo = periods[1]?.label ?? ''
    periodLabel = periods[0]?.label ?? ''

    /*
      The current month only, rather than a second comparative column. A
      statement that says where cash started, where it finished and what moved
      it between is already a trend; the prior month's movement would be a
      second one, and it costs two more passes over the whole ledger for a
      sentence the revenue and expense columns above substantially already
      give.
    */
    const flow = await cashFlowStatement(ctx, month)
    openingCashCents = flow.openingCashCents
    closingCashCents = flow.closingCashCents
    netCashChangeCents = flow.netChangeInCashCents
  }

  const figures = {
    cashBalanceCents: Number(cash?.total ?? 0),
    receivableCents: Number(receivable?.total ?? 0),
    overdueReceivableCents: Number(receivable?.overdue ?? 0),
    payableCents: Number(payable?.total ?? 0),
    winRateBp,
    revenueConcentrationBp: concentrationBp,
    topCustomerName: topCustomer?.name ?? '',
    expenseCents,
    priorExpenseCents,
    revenueCents,
    priorRevenueCents,
    expenseVarianceBp,
    openingCashCents,
    closingCashCents,
    netCashChangeCents,
    comparedTo,
    periodLabel,
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
      /*
        One blank line of values rather than several keys, so a company that
        cannot read the accounts gets a prompt with the section absent instead
        of a prompt full of zeroes — which the model would have had to explain.
      */
      comparisonBlock: comparedTo
        ? `\n\nThis period against ${comparedTo}:\n` +
          `Revenue: ${formatCents(revenueCents)} (was ${formatCents(priorRevenueCents)})\n` +
          `Operating expenses: ${formatCents(expenseCents)} ` +
          `(was ${formatCents(priorExpenseCents)}` +
          `${expenseVarianceBp === null ? '' : `, ${formatBasisPoints(Math.abs(expenseVarianceBp))} ${expenseVarianceBp >= 0 ? 'higher' : 'lower'}`})\n` +
          `Cash over ${periodLabel}: ${formatCents(openingCashCents)} to ` +
          `${formatCents(closingCashCents)} (net ${formatCents(netCashChangeCents)})`
        : '',
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
