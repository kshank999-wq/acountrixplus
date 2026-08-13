import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { aiSuggestions } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { AiFeature } from './gateway'

/**
 * Human-in-the-loop approval (spec §11 "User approval required for material
 * accounting actions", §12, §23 "Consequential financial actions require
 * explicit authorization and must be auditable").
 *
 * This module is the boundary the whole AI design rests on, so it is worth
 * being explicit about what it does *not* do: **nothing here applies
 * anything.** A suggestion is a row with a payload and a status. Accepting it
 * hands the payload to whichever ordinary service would have done the work if
 * a person had typed it — `categorize`, `createRule`, `saveDocument` — under
 * that person's own ActorContext.
 *
 * The consequence is worth stating plainly: the audit log records the
 * *person* who accepted, not the model, because the person is who decided.
 * The `ai_suggestion.accept` event alongside it is what preserves the fact
 * that a machine proposed it.
 */

export type SuggestionInput = {
  feature: AiFeature
  entityType: string
  entityId?: string | null
  payload: Record<string, unknown>
  confidenceBp?: number | null
  rationale?: string | null
  requestId?: string | null
}

/**
 * Records a proposal for review.
 *
 * A new suggestion supersedes any pending one for the same entity and
 * feature. Two live proposals about the same transaction would make the
 * reviewer choose between machines rather than decide about the transaction.
 */
export async function recordSuggestion(ctx: ActorContext, input: SuggestionInput) {
  requirePermission(ctx, 'ai:use')

  return db.transaction(async (tx) => {
    if (input.entityId) {
      await tx
        .update(aiSuggestions)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(aiSuggestions.companyId, ctx.companyId),
            eq(aiSuggestions.feature, input.feature),
            eq(aiSuggestions.entityId, input.entityId),
            eq(aiSuggestions.status, 'pending'),
          ),
        )
    }

    const [suggestion] = await tx
      .insert(aiSuggestions)
      .values({
        companyId: ctx.companyId,
        requestId: input.requestId ?? null,
        feature: input.feature,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        payload: input.payload,
        confidenceBp: input.confidenceBp ?? null,
        rationale: input.rationale ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    return suggestion
  })
}

/** A pending suggestion, or null. Used to render the assistant's proposal. */
export async function pendingFor(
  ctx: ActorContext,
  feature: AiFeature,
  entityId: string,
) {
  const [row] = await db
    .select()
    .from(aiSuggestions)
    .where(
      scoped(
        ctx,
        aiSuggestions,
        eq(aiSuggestions.feature, feature),
        eq(aiSuggestions.entityId, entityId),
        eq(aiSuggestions.status, 'pending'),
      ),
    )
    .orderBy(desc(aiSuggestions.createdAt))
    .limit(1)

  return row ?? null
}

/** Everything awaiting a decision, newest first. */
export async function pendingSuggestions(ctx: ActorContext, limit = 50) {
  requirePermission(ctx, 'ai:use')

  return db
    .select()
    .from(aiSuggestions)
    .where(scoped(ctx, aiSuggestions, eq(aiSuggestions.status, 'pending')))
    .orderBy(desc(aiSuggestions.createdAt))
    .limit(limit)
}

/** One suggestion by id, scoped. */
export async function getSuggestion(ctx: ActorContext, suggestionId: string) {
  const [row] = await db
    .select()
    .from(aiSuggestions)
    .where(scoped(ctx, aiSuggestions, eq(aiSuggestions.id, suggestionId)))
    .limit(1)

  return row ?? null
}

/**
 * Marks a suggestion accepted.
 *
 * Called by the caller *after* the real work has been applied through the
 * ordinary service, not before — so a suggestion is never marked accepted for
 * a change that then failed to save. The caller owns that ordering because
 * only the caller knows which service does the work.
 */
export async function markAccepted(
  ctx: ActorContext,
  suggestionId: string,
  note?: string,
) {
  return decide(ctx, suggestionId, 'accepted', note)
}

/**
 * Rejects a suggestion.
 *
 * Recorded rather than deleted. What the assistant proposed and what a person
 * decided about it is exactly the record spec §19 wants kept, and the
 * rejections are the more interesting half — they are the evidence for whether
 * a prompt version is any good.
 */
export async function rejectSuggestion(
  ctx: ActorContext,
  suggestionId: string,
  note?: string,
) {
  return decide(ctx, suggestionId, 'rejected', note)
}

async function decide(
  ctx: ActorContext,
  suggestionId: string,
  status: 'accepted' | 'rejected',
  note?: string,
) {
  requirePermission(ctx, 'ai:use')

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(aiSuggestions)
      .set({
        status,
        decidedBy: ctx.userId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      })
      .where(
        and(
          eq(aiSuggestions.id, suggestionId),
          eq(aiSuggestions.companyId, ctx.companyId),
          eq(aiSuggestions.status, 'pending'),
        ),
      )
      .returning()

    // Already decided, or another company's. Either way there is nothing to
    // record — and reporting which would leak whether the id exists.
    if (!updated) throw new Error('That suggestion is no longer awaiting a decision.')

    await recordAudit(
      ctx,
      {
        action: status === 'accepted' ? 'ai_suggestion.accept' : 'ai_suggestion.reject',
        entityType: 'ai_suggestion',
        entityId: updated.id,
        after: {
          feature: updated.feature,
          targetType: updated.entityType,
          targetId: updated.entityId,
          confidenceBp: updated.confidenceBp,
        },
      },
      tx,
    )

    return updated
  })
}

export type AcceptanceStats = {
  total: number
  accepted: number
  rejected: number
  pending: number
  /** Accepted as a share of decided, in basis points. */
  acceptanceRateBp: number
}

/**
 * How often people take the assistant's advice (spec §12 monitoring).
 *
 * The number that matters for deciding whether a prompt version earns its
 * keep — and the one to watch after a prompt change, because a drop in
 * acceptance is the first sign a rollback is needed.
 */
export async function acceptanceStats(
  ctx: ActorContext,
  feature?: AiFeature,
): Promise<AcceptanceStats> {
  requirePermission(ctx, 'ai:use')

  const [row] = await db
    .select({
      total: sql<string>`count(*)`,
      accepted: sql<string>`count(*) FILTER (WHERE ${aiSuggestions.status} = 'accepted')`,
      rejected: sql<string>`count(*) FILTER (WHERE ${aiSuggestions.status} = 'rejected')`,
      pending: sql<string>`count(*) FILTER (WHERE ${aiSuggestions.status} = 'pending')`,
    })
    .from(aiSuggestions)
    .where(
      scoped(ctx, aiSuggestions, feature ? eq(aiSuggestions.feature, feature) : undefined),
    )

  const accepted = Number(row?.accepted ?? 0)
  const rejected = Number(row?.rejected ?? 0)
  const decided = accepted + rejected

  return {
    total: Number(row?.total ?? 0),
    accepted,
    rejected,
    pending: Number(row?.pending ?? 0),
    // Rate over *decided*, not over total: a pending suggestion has not been
    // turned down, it has not been looked at.
    acceptanceRateBp: decided === 0 ? 0 : Math.round((accepted / decided) * 10_000),
  }
}
