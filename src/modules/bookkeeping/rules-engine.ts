import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bankTransactions, categorizationRules, type RuleCondition } from '@/db/schema'
import { newBatchId, recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { firstMatchingRule, vendorMemoryConditions } from './matching'

/**
 * Rule persistence and application (spec §3).
 *
 * All decision logic lives in `matching.ts` as pure functions; this module
 * only loads rules, applies the outcome, and writes the audit trail.
 */

/** Active rules for the company, ordered so ties break oldest-first. */
export async function activeRules(companyId: string) {
  return db
    .select()
    .from(categorizationRules)
    .where(
      and(
        eq(categorizationRules.companyId, companyId),
        eq(categorizationRules.isActive, true),
      ),
    )
    .orderBy(asc(categorizationRules.priority), asc(categorizationRules.createdAt))
}

/**
 * Runs the rules over freshly imported transactions.
 *
 * `auto` rules categorize outright; `suggest` rules stage a proposal the user
 * confirms in the inbox. Anything unmatched stays `new`. Consequential
 * financial actions stay reviewable (spec §23).
 */
export async function applyRulesToNewTransactions(
  ctx: ActorContext,
  transactionIds: string[],
  batchId?: string,
): Promise<{ autoCategorized: number; suggested: number }> {
  if (transactionIds.length === 0) return { autoCategorized: 0, suggested: 0 }

  const rules = await activeRules(ctx.companyId)
  if (rules.length === 0) return { autoCategorized: 0, suggested: 0 }

  const transactions = await db
    .select()
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions, inArray(bankTransactions.id, transactionIds)))

  let autoCategorized = 0
  let suggested = 0
  const appliedRuleIds: string[] = []

  await db.transaction(async (tx) => {
    for (const transaction of transactions) {
      // Only untouched rows are eligible; never overwrite a human decision.
      if (transaction.reviewState !== 'new') continue

      const rule = firstMatchingRule(rules, {
        description: transaction.description,
        merchantName: transaction.merchantName,
        amountCents: transaction.amountCents,
        financialAccountId: transaction.financialAccountId,
      })
      if (!rule) continue

      const reviewState = rule.action === 'auto' ? 'categorized' : 'suggested'

      await tx
        .update(bankTransactions)
        .set({
          chartAccountId: rule.chartAccountId,
          appliedRuleId: rule.id,
          reviewState,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankTransactions.id, transaction.id),
            eq(bankTransactions.companyId, ctx.companyId),
          ),
        )

      await recordAudit(
        ctx,
        {
          action: 'rule.apply',
          entityType: 'bank_transaction',
          entityId: transaction.id,
          batchId: batchId ?? null,
          before: { reviewState: transaction.reviewState, chartAccountId: null },
          after: { reviewState, chartAccountId: rule.chartAccountId, ruleId: rule.id },
        },
        tx,
      )

      appliedRuleIds.push(rule.id)
      if (rule.action === 'auto') autoCategorized++
      else suggested++
    }

    if (appliedRuleIds.length > 0) {
      await bumpMatchCounts(tx, ctx.companyId, appliedRuleIds)
    }
  })

  return { autoCategorized, suggested }
}

/** Increments each rule's usage counter, once per application. */
async function bumpMatchCounts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
  ruleIds: string[],
) {
  const counts = new Map<string, number>()
  for (const id of ruleIds) counts.set(id, (counts.get(id) ?? 0) + 1)

  for (const [ruleId, count] of counts) {
    await tx
      .update(categorizationRules)
      .set({
        matchCount: sql`${categorizationRules.matchCount} + ${count}`,
        lastAppliedAt: new Date(),
      })
      .where(
        and(
          eq(categorizationRules.id, ruleId),
          eq(categorizationRules.companyId, companyId),
        ),
      )
  }
}

export type CreateRuleInput = {
  name: string
  conditions: RuleCondition[]
  chartAccountId: string
  action?: 'auto' | 'suggest'
  matchType?: 'all' | 'any'
  priority?: number
  financialAccountId?: string | null
  isVendorMemory?: boolean
  /** Also apply the new rule to matching transactions already in the inbox. */
  applyToExisting?: boolean
  /**
   * Groups this rule's creation with another action so the two undo together —
   * used when categorizing also remembers the vendor.
   */
  batchId?: string | null
}

/** Creates a rule, optionally back-applying it to the existing inbox. */
export async function createRule(ctx: ActorContext, input: CreateRuleInput) {
  requirePermission(ctx, 'bookkeeping:rules')

  if (input.conditions.length === 0) {
    throw new Error('A rule needs at least one condition.')
  }

  const rule = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(categorizationRules)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        conditions: input.conditions,
        chartAccountId: input.chartAccountId,
        action: input.action ?? 'suggest',
        matchType: input.matchType ?? 'all',
        priority: input.priority ?? 100,
        financialAccountId: input.financialAccountId ?? null,
        isVendorMemory: input.isVendorMemory ?? false,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'rule.create',
        entityType: 'categorization_rule',
        entityId: created.id,
        batchId: input.batchId ?? null,
        after: {
          name: created.name,
          action: created.action,
          conditions: created.conditions,
          chartAccountId: created.chartAccountId,
        },
      },
      tx,
    )

    return created
  })

  let applied = { autoCategorized: 0, suggested: 0 }
  if (input.applyToExisting) {
    applied = await applyRuleToExisting(ctx, rule.id)
  }

  return { rule, applied }
}

/**
 * Applies one rule to transactions already sitting in the inbox.
 *
 * Only `new` and `suggested` rows are touched. A transaction a person has
 * already categorized is left alone — a new rule does not get to silently
 * rewrite settled books (spec §23).
 */
export async function applyRuleToExisting(
  ctx: ActorContext,
  ruleId: string,
): Promise<{ autoCategorized: number; suggested: number }> {
  requirePermission(ctx, 'bookkeeping:rules')

  const [rule] = await db
    .select()
    .from(categorizationRules)
    .where(scoped(ctx, categorizationRules, eq(categorizationRules.id, ruleId)))
    .limit(1)

  if (!rule) throw new Error('Rule not found')

  const candidates = await db
    .select()
    .from(bankTransactions)
    .where(
      scoped(
        ctx,
        bankTransactions,
        inArray(bankTransactions.reviewState, ['new', 'suggested']),
      ),
    )

  const batchId = newBatchId()
  const reviewState = rule.action === 'auto' ? 'categorized' : 'suggested'
  let autoCategorized = 0
  let suggested = 0

  await db.transaction(async (tx) => {
    const matchedIds: string[] = []

    for (const transaction of candidates) {
      const winner = firstMatchingRule([rule], {
        description: transaction.description,
        merchantName: transaction.merchantName,
        amountCents: transaction.amountCents,
        financialAccountId: transaction.financialAccountId,
      })
      if (!winner) continue

      await tx
        .update(bankTransactions)
        .set({
          chartAccountId: rule.chartAccountId,
          appliedRuleId: rule.id,
          reviewState,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankTransactions.id, transaction.id),
            eq(bankTransactions.companyId, ctx.companyId),
          ),
        )

      await recordAudit(
        ctx,
        {
          action: 'rule.apply',
          entityType: 'bank_transaction',
          entityId: transaction.id,
          batchId,
          before: {
            reviewState: transaction.reviewState,
            chartAccountId: transaction.chartAccountId,
          },
          after: { reviewState, chartAccountId: rule.chartAccountId, ruleId: rule.id },
        },
        tx,
      )

      matchedIds.push(rule.id)
      if (rule.action === 'auto') autoCategorized++
      else suggested++
    }

    if (matchedIds.length > 0) {
      await bumpMatchCounts(tx, ctx.companyId, matchedIds)
    }
  })

  return { autoCategorized, suggested }
}

/**
 * Creates a recurring vendor-memory rule from a transaction the user just
 * categorized (spec §3).
 *
 * Defaults to `suggest` so the next matching charge is proposed rather than
 * posted without review; the user can promote it to `auto` per their stated
 * preference.
 */
export async function rememberVendor(
  ctx: ActorContext,
  input: {
    description: string
    merchantName?: string | null
    chartAccountId: string
    action?: 'auto' | 'suggest'
    applyToExisting?: boolean
    batchId?: string | null
  },
) {
  const conditions = vendorMemoryConditions(input.description, input.merchantName)
  if (!conditions) return null

  const label = input.merchantName?.trim() || input.description
  return createRule(ctx, {
    name: `Remember ${label}`,
    conditions,
    chartAccountId: input.chartAccountId,
    action: input.action ?? 'suggest',
    isVendorMemory: true,
    applyToExisting: input.applyToExisting ?? false,
    batchId: input.batchId ?? null,
  })
}

export async function listRules(ctx: ActorContext) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select()
    .from(categorizationRules)
    .where(scoped(ctx, categorizationRules))
    .orderBy(asc(categorizationRules.priority), asc(categorizationRules.createdAt))
}

/** Soft-deletes a rule. Transactions it already categorized are untouched. */
export async function deactivateRule(ctx: ActorContext, ruleId: string) {
  requirePermission(ctx, 'bookkeeping:rules')

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(categorizationRules)
      .where(scoped(ctx, categorizationRules, eq(categorizationRules.id, ruleId)))
      .limit(1)

    if (!existing) throw new Error('Rule not found')

    await tx
      .update(categorizationRules)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(categorizationRules.id, ruleId),
          eq(categorizationRules.companyId, ctx.companyId),
        ),
      )

    await recordAudit(
      ctx,
      {
        action: 'rule.delete',
        entityType: 'categorization_rule',
        entityId: ruleId,
        before: { isActive: true, name: existing.name },
        after: { isActive: false },
      },
      tx,
    )
  })
}
