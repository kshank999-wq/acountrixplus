import { randomUUID } from 'node:crypto'
import { desc, eq, and, isNull, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { auditEvents } from '@/db/schema'
import { scoped, type ActorContext } from '@/modules/tenancy/context'

export type AuditAction =
  | 'transaction.categorize'
  | 'transaction.uncategorize'
  | 'transaction.split'
  | 'transaction.unsplit'
  | 'transaction.exclude'
  | 'transaction.unexclude'
  | 'transaction.transfer_mark'
  | 'transaction.note'
  | 'transaction.import'
  | 'rule.create'
  | 'rule.update'
  | 'rule.delete'
  | 'rule.apply'
  | 'account.create'
  | 'account.update'
  | 'company.create'
  | 'company.update'
  | 'membership.create'
  | 'membership.update'
  | 'auth.login'
  | 'auth.logout'

export type AuditInput = {
  action: AuditAction
  entityType: string
  entityId?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  batchId?: string | null
  isUndo?: boolean
}

/**
 * Writes an audit event (spec §14, §19).
 *
 * `exec` should be the surrounding transaction so the audit row commits or
 * rolls back with the change it describes. Passing the bare `db` handle is
 * only appropriate for events that have no accompanying write, such as login.
 */
export async function recordAudit(
  ctx: ActorContext,
  input: AuditInput,
  exec: Executor = db,
): Promise<{ id: string }> {
  const [event] = await exec
    .insert(auditEvents)
    .values({
      companyId: ctx.companyId,
      userId: ctx.userId,
      actorName: ctx.userName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      batchId: input.batchId ?? null,
      isUndo: input.isUndo ?? false,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    })
    .returning({ id: auditEvents.id })

  return event
}

/** A fresh batch id, so one bulk action's events can be undone together. */
export function newBatchId(): string {
  return randomUUID()
}

/** History for one record, newest first (spec §3 "undo/history"). */
export async function historyFor(ctx: ActorContext, entityType: string, entityId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      scoped(
        ctx,
        auditEvents,
        eq(auditEvents.entityType, entityType),
        eq(auditEvents.entityId, entityId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
}

/** Company-wide activity feed, newest first. */
export async function recentActivity(ctx: ActorContext, limit = 50) {
  return db
    .select()
    .from(auditEvents)
    .where(scoped(ctx, auditEvents))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
}

/**
 * Entity types undo knows how to reverse.
 *
 * Events on anything else (company creation, imports) are skipped when looking
 * for the undo target. Without this filter a trailing non-reversible event
 * would sit at the head of the log and make undo report "nothing to undo"
 * while a perfectly undoable change waited right behind it.
 */
export const UNDOABLE_ENTITY_TYPES = ['bank_transaction', 'categorization_rule'] as const

/**
 * The most recent undoable event for this actor — what a Ctrl-Z should target.
 * Undo events themselves are excluded, so undo does not ping-pong.
 */
export async function lastUndoableEvent(ctx: ActorContext) {
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(
      scoped(
        ctx,
        auditEvents,
        eq(auditEvents.userId, ctx.userId),
        eq(auditEvents.isUndo, false),
        isNull(auditEvents.undoneByEventId),
        inArray(auditEvents.entityType, [...UNDOABLE_ENTITY_TYPES]),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1)

  return event ?? null
}

/** All events in a batch, oldest first, so an undo can reverse them in order. */
export async function eventsInBatch(ctx: ActorContext, batchId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(scoped(ctx, auditEvents, eq(auditEvents.batchId, batchId)))
    .orderBy(auditEvents.createdAt)
}

/** Marks an original event as reversed by `undoEventId`. */
export async function markUndone(
  ctx: ActorContext,
  originalEventId: string,
  undoEventId: string,
  exec: Executor = db,
) {
  await exec
    .update(auditEvents)
    .set({ undoneByEventId: undoEventId })
    .where(
      and(eq(auditEvents.id, originalEventId), eq(auditEvents.companyId, ctx.companyId)),
    )
}
