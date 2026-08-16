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
  // Ledger and closing controls (spec §13)
  | 'journal.post'
  | 'journal.draft'
  // Receivables completeness (spec §13, Phase 11)
  | 'credit_note.create'
  | 'credit_note.apply'
  | 'invoice.write_off'
  | 'invoice.write_off_recovered'
  | 'statement.create'
  | 'recurring.create'
  | 'recurring.update'
  | 'year.close'
  | 'year.reopen'
  | 'journal.discard_draft'
  | 'journal.void'
  | 'journal.reverse'
  | 'period.close'
  | 'period.reopen'
  // Reconciliation (spec §4)
  | 'reconciliation.start'
  | 'reconciliation.clear'
  | 'reconciliation.unclear'
  | 'reconciliation.complete'
  | 'reconciliation.reopen'
  // Receivables and payables (spec §13)
  | 'invoice.create'
  | 'invoice.void'
  | 'bill.create'
  | 'bill.void'
  | 'payment.record'
  | 'customer.create'
  | 'vendor.create'
  // Time and expense billing (spec §5, Phase 15)
  | 'time.log'
  | 'time.approve'
  | 'time.write_off'
  | 'time.bill'
  | 'expense.mark_billable'
  | 'retainer.receive'
  | 'retainer.apply'
  // Transactional mail, invitations and password reset (spec §19, Phase 19)
  | 'password.reset'
  | 'invitation.send'
  | 'invitation.accept'
  | 'invitation.withdraw'
  // Accountant practice mode (spec §14, Phase 18)
  | 'engagement.offer'
  | 'engagement.accept'
  | 'engagement.end'
  // Recorded in the company being *entered*, because "who opened our books
  // and when" is the client's question, not the accountant's.
  | 'company.switch'
  // Bringing an existing business's books in (spec §20 Phase 8, Phase 17)
  | 'import.commit'
  | 'import.revert'
  // Accounting dimensions and fixed assets (spec §13, Phase 16)
  | 'dimension.create'
  | 'dimension.update'
  // Reclassifying moves no money, which is exactly why it is audited: nothing
  // in the ledger records that somebody moved a quarter of the year's costs
  // from one site to another.
  | 'dimension.reclassify'
  | 'fixed_asset.register'
  | 'fixed_asset.depreciate'
  | 'fixed_asset.dispose'
  // Inventory (spec §5, Phase 14)
  | 'stock.adjust'
  | 'stock.receive'
  | 'item.update'
  | 'purchase_order.create'
  | 'purchase_order.receive'
  // Security controls (spec §14, §19, Phase 13)
  | 'device.revoke_all'
  | 'mfa.enable'
  | 'mfa.disable'
  | 'mfa.recovery_codes_regenerated'
  | 'password.change'
  | 'security_policy.update'
  | 'data.export'
  // Deposits and vendor credits (spec §13, Phase 12)
  | 'deposit.create'
  | 'deposit.void'
  | 'vendor_credit.create'
  | 'vendor_credit.apply'
  // CRM and proposals (spec §6, §9)
  | 'organization.create'
  | 'organization.update'
  | 'opportunity.create'
  | 'opportunity.update'
  | 'opportunity.stage_change'
  | 'opportunity.reopen'
  | 'opportunity.convert'
  | 'proposal.create'
  | 'proposal.update'
  | 'proposal.send'
  | 'proposal.decide'
  | 'lead.intake'
  | 'intake_key.create'
  | 'intake_key.revoke'
  // Company Studio and the design engine (spec §7, §15)
  | 'profile.update'
  | 'brand_kit.create'
  | 'brand_kit.update'
  | 'asset.upload'
  | 'asset.delete'
  | 'service_item.create'
  | 'clause.create'
  | 'clause.revise'
  | 'document.create'
  | 'document.update'
  | 'document.apply_template'
  | 'template.save'
  | 'proposal.accept'
  // Marketing (spec §10, §19)
  | 'segment.create'
  | 'segment.update'
  | 'campaign.create'
  | 'campaign.send'
  | 'campaign.cancel'
  | 'suppression.add'
  | 'suppression.remove'
  | 'task.complete'
  // Industry modules and job costing (spec §5, §20 Phase 7)
  | 'module.toggle'
  | 'cost_code.create'
  | 'cost_code.update'
  | 'budget.set'
  | 'change_order.create'
  | 'change_order.approve'
  | 'change_order.reject'
  | 'sov.set'
  | 'progress_billing.create'
  | 'progress_billing.issue'
  | 'subcontractor.create'
  | 'subcontractor.update'
  | 'compliance_document.record'
  | 'compliance_document.delete'
  // The optional AI module (spec §11, §12)
  | 'ai.settings_update'
  | 'ai_prompt.save'
  | 'ai_prompt.activate'
  | 'ai_suggestion.accept'
  | 'ai_suggestion.reject'
  // Payroll and tax (spec §13, §19 — Phase 9)
  | 'employee.create'
  | 'employee.update'
  | 'payroll.post'
  | 'payroll.void'
  | 'remittance.record'
  | 'tax_code.create'
  | 'tax_code.update'
  | 'filing.prepare'
  | 'filing.mark_filed'
  // The mobile app (spec §3, §18, §19 — Phase 8)
  | 'device.revoke'
  | 'device.rename'
  | 'receipt.attach'
  | 'receipt.detach'
  | 'push.subscribe'
  | 'push.unsubscribe'
  | 'notification.preference'
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
      // "Dana Chen (Hartley & Co)" when acting through a practice. The client
      // reading their own audit log should not have to cross-reference a user
      // list to find out that the person who reopened December works for
      // their accountants.
      actorName: ctx.viaPractice ? `${ctx.userName} (${ctx.viaPractice})` : ctx.userName,
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
