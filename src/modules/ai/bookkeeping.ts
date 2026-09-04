import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { bankTransactions, chartAccounts } from '@/db/schema'
import { formatCents } from '@/lib/money'
import { categorize } from '@/modules/bookkeeping/transactions'
import { createRule } from '@/modules/bookkeeping/rules-engine'
import { scoped, type ActorContext } from '@/modules/tenancy/context'
import { ask } from './gateway'
import {
  accountOptions,
  inboxShape,
  recentTransactions,
  renderAccounts,
  renderTransactions,
  transactionContext,
} from './retrieval'
import {
  anomaliesJsonSchema,
  anomaliesSchema,
  categorizeJsonSchema,
  categorizeSchema,
  ruleJsonSchema,
  ruleSchema,
  summaryJsonSchema,
  summarySchema,
} from './schemas'
import { getSuggestion, markAccepted, recordSuggestion } from './suggestions'
import { Refusal } from '@/modules/errors'

/**
 * The AI bookkeeping assistant (spec §11).
 *
 * Every function here produces a *suggestion*. None of them writes to the
 * ledger. The only function that changes anything is `acceptCategorization`,
 * and what it does is call `categorize` — the same service the Transaction
 * Inbox calls when a person picks an account from the dropdown, with the same
 * ActorContext, producing the same audit event and the same journal entry.
 *
 * That is the design in one sentence: **AI is another way to arrive at a
 * decision, never another way to make one.**
 */

// --- Suggest a category ----------------------------------------------------

export async function suggestCategory(ctx: ActorContext, transactionId: string) {
  const transaction = await transactionContext(ctx, transactionId)
  if (!transaction) {
    return { ok: false as const, message: 'That transaction was not found.', reason: 'not_found' }
  }

  const accounts = await accountOptions(ctx)
  if (accounts.length === 0) {
    return {
      ok: false as const,
      message: 'No accounts are available to choose from.',
      reason: 'no_accounts',
    }
  }

  const result = await ask(ctx, {
    feature: 'bookkeeping_categorize',
    promptKey: 'bookkeeping.categorize',
    values: {
      postedDate: transaction.postedDate,
      description: transaction.description,
      merchantName: transaction.merchantName ?? '(none given)',
      amount: formatCents(transaction.amountCents),
      accounts: renderAccounts(accounts),
    },
    input: { ...transaction, accounts },
    schema: categorizeSchema,
    jsonSchema: categorizeJsonSchema,
    effort: 'low',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  // The model may only choose from the accounts it was given. A returned id
  // that is not one of them is treated as no answer — it would otherwise be
  // a route to writing an arbitrary uuid into a journal line.
  const chosen = result.data.chartAccountId
    ? accounts.find((account) => account.id === result.data.chartAccountId)
    : null

  if (result.data.chartAccountId && !chosen) {
    return {
      ok: false as const,
      message: 'The assistant named an account that does not exist here.',
      reason: 'invalid_output',
    }
  }

  if (!chosen) {
    return {
      ok: false as const,
      message: result.data.rationale,
      reason: 'declined',
    }
  }

  const suggestion = await recordSuggestion(ctx, {
    feature: 'bookkeeping_categorize',
    entityType: 'bank_transaction',
    entityId: transactionId,
    payload: { chartAccountId: chosen.id, accountName: chosen.name, accountNumber: chosen.number },
    confidenceBp: result.data.confidenceBp,
    rationale: result.data.rationale,
    requestId: result.requestId,
  })

  return {
    ok: true as const,
    suggestionId: suggestion.id,
    account: chosen,
    confidenceBp: result.data.confidenceBp,
    rationale: result.data.rationale,
  }
}

/**
 * Applies an accepted categorization.
 *
 * The order is the important part: the ledger write happens **first**, through
 * the ordinary service, and the suggestion is only marked accepted once that
 * has succeeded. Marking first would leave a suggestion recorded as applied
 * against a change that never landed.
 */
export async function acceptCategorization(
  ctx: ActorContext,
  suggestionId: string,
  /** The mobile outbox's transaction, so accepting replays safely offline. */
  exec?: Executor,
) {
  const suggestion = await getSuggestion(ctx, suggestionId)

  if (!suggestion || suggestion.status !== 'pending') {
    throw new Refusal('That suggestion is no longer awaiting a decision.')
  }
  if (suggestion.feature !== 'bookkeeping_categorize' || !suggestion.entityId) {
    throw new Refusal('That suggestion is not a categorization.')
  }

  const chartAccountId = String(suggestion.payload.chartAccountId ?? '')
  if (!chartAccountId) throw new Refusal('That suggestion has no account on it.')

  // `categorize` runs its own permission check, its own tenant scoping, and
  // writes its own audit event under this actor. Nothing about the call says
  // it came from a suggestion, which is right — the person categorized it.
  await categorize(ctx, suggestion.entityId, chartAccountId, {}, exec)
  await markAccepted(ctx, suggestionId, undefined, exec)

  return { transactionId: suggestion.entityId, chartAccountId }
}

// --- Review for anomalies --------------------------------------------------

export async function reviewAnomalies(ctx: ActorContext) {
  const transactions = await recentTransactions(ctx, 120)

  if (transactions.length < 3) {
    return {
      ok: true as const,
      findings: [],
      message: 'Not enough activity yet for a useful review.',
    }
  }

  const result = await ask(ctx, {
    feature: 'bookkeeping_anomalies',
    promptKey: 'bookkeeping.anomalies',
    values: { transactions: renderTransactions(transactions) },
    input: { transactions },
    schema: anomaliesSchema,
    jsonSchema: anomaliesJsonSchema,
    effort: 'medium',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  // Only findings about transactions we actually supplied. A model naming an
  // id it was not given is either confused or being steered.
  const known = new Set(transactions.map((row) => row.id))
  const findings = result.data.findings.filter((finding) =>
    finding.transactionIds.every((id) => known.has(id)),
  )

  const byId = new Map(transactions.map((row) => [row.id, row]))

  return {
    ok: true as const,
    findings: findings.map((finding) => ({
      ...finding,
      transactions: finding.transactionIds
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    })),
    message: null,
  }
}

// --- Propose a rule --------------------------------------------------------

/**
 * Proposes a rule from a pattern the user has already established.
 *
 * Only offered for a merchant categorized the same way at least twice — the
 * assistant is generalizing a decision the person made, not inventing one.
 */
export async function suggestRule(ctx: ActorContext, transactionId: string) {
  const transaction = await transactionContext(ctx, transactionId)
  if (!transaction) {
    return { ok: false as const, message: 'That transaction was not found.', reason: 'not_found' }
  }

  const merchantKey = transaction.merchantName ?? transaction.description

  const [pattern] = await db
    .select({
      chartAccountId: bankTransactions.chartAccountId,
      accountName: chartAccounts.name,
      occurrences: sql<string>`count(*)`,
    })
    .from(bankTransactions)
    .innerJoin(chartAccounts, eq(chartAccounts.id, bankTransactions.chartAccountId))
    .where(
      scoped(
        ctx,
        bankTransactions,
        eq(
          sql`coalesce(${bankTransactions.merchantName}, ${bankTransactions.description})`,
          merchantKey,
        ),
      ),
    )
    .groupBy(bankTransactions.chartAccountId, chartAccounts.name)
    .orderBy(sql`count(*) desc`)
    .limit(1)

  if (!pattern || Number(pattern.occurrences) < 2) {
    return {
      ok: false as const,
      message:
        'This merchant has only been categorized once. Categorize another before making it a rule.',
      reason: 'no_pattern',
    }
  }

  const result = await ask(ctx, {
    feature: 'bookkeeping_rule',
    promptKey: 'bookkeeping.rule',
    values: {
      occurrences: String(pattern.occurrences),
      accountName: pattern.accountName,
      merchantName: transaction.merchantName ?? '(none given)',
      description: transaction.description,
    },
    input: {
      merchantName: transaction.merchantName,
      description: transaction.description,
      accountName: pattern.accountName,
      occurrences: Number(pattern.occurrences),
    },
    schema: ruleSchema,
    jsonSchema: ruleJsonSchema,
    effort: 'low',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  const suggestion = await recordSuggestion(ctx, {
    feature: 'bookkeeping_rule',
    entityType: 'categorization_rule',
    entityId: transactionId,
    payload: { ...result.data, chartAccountId: pattern.chartAccountId },
    confidenceBp: result.data.confidenceBp,
    rationale: result.data.rationale,
    requestId: result.requestId,
  })

  return {
    ok: true as const,
    suggestionId: suggestion.id,
    rule: result.data,
    accountName: pattern.accountName,
  }
}

/** Creates the proposed rule through the ordinary rules service. */
export async function acceptRule(ctx: ActorContext, suggestionId: string) {
  const suggestion = await getSuggestion(ctx, suggestionId)

  if (!suggestion || suggestion.status !== 'pending') {
    throw new Refusal('That suggestion is no longer awaiting a decision.')
  }
  if (suggestion.feature !== 'bookkeeping_rule') {
    throw new Refusal('That suggestion is not a rule.')
  }

  // Re-validated on the way out. The payload was schema-checked when it was
  // stored, but it has been sitting in a JSONB column since — and this is the
  // step that creates a rule which will categorize transactions unattended.
  const payload = ruleSchema
    .extend({ chartAccountId: z.string().uuid() })
    .parse(suggestion.payload)

  const rule = await createRule(ctx, {
    name: payload.name,
    conditions: [
      { field: payload.field, operator: payload.operator, value: payload.value },
    ],
    chartAccountId: payload.chartAccountId,
    action: payload.action,
  })

  await markAccepted(ctx, suggestionId)
  return rule
}

// --- Summarize the inbox ---------------------------------------------------

export async function summarizeInbox(ctx: ActorContext) {
  const shape = await inboxShape(ctx)

  const result = await ask(ctx, {
    feature: 'bookkeeping_summary',
    promptKey: 'bookkeeping.summary',
    values: {
      uncategorizedCount: String(shape.uncategorizedCount),
      uncategorizedTotal: formatCents(Math.abs(shape.uncategorizedTotalCents)),
      topMerchants:
        shape.topMerchants.map((row) => `${row.name} (${row.count})`).join(', ') || '(none)',
    },
    input: shape,
    schema: summarySchema,
    jsonSchema: summaryJsonSchema,
    effort: 'low',
  })

  if (!result.ok) return { ok: false as const, message: result.message, reason: result.reason }

  return { ok: true as const, ...result.data }
}
