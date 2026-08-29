import { randomUUID } from 'node:crypto'
import { desc, eq, and, isNull, inArray, notInArray } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { auditEvents } from '@/db/schema'
import { can, requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { permissionToRead, withheldEntityTypes } from './visibility'

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
  // Phase 42. Sending is not the same act as raising, and "who asked this
  // customer for the money, and when" is a question people ask.
  | 'invoice.send'
  | 'invoice.share'
  // Phase 55. `customer_statements.sent_at` existed from Phase 11 and nothing
  // ever wrote it, so "what did we send them, and when" — the first question
  // in any collections conversation — had no answer anywhere.
  | 'statement.send'
  // Phase 57. Switching statement runs on decides that a letter goes to every
  // customer with an account, every month, without anybody deciding again.
  | 'statement.policy'
  // Phase 58. "Did we tell them what that payment was for" is the question a
  // supplier's chase turns on, and it had no answer anywhere.
  | 'remittance.send'
  | 'payrun.complete'
  | 'payrun.advise'
  // Phase 43. Switching chasing on decides that invoices will be sent without
  // anybody deciding again, so "why did our customer get three emails" needs
  // an answer somebody can find.
  | 'chase.settings_update'
  | 'bill.create'
  /** A second pair of eyes agreed the money may leave (Phase 50). */
  | 'bill.approve'
  /**
   * That agreement taken back (Phase 70).
   *
   * Its own action rather than a second `bill.approve` carrying a `withdrawn`
   * flag, which is what it was until this phase. Two opposite events under one
   * name is this phase's own defect wearing an audit trail: "when was this bill
   * approved" could not be answered by asking for `bill.approve` — you got the
   * withdrawal too, and had to read a flag inside the payload to tell which one
   * you were holding.
   */
  | 'bill.approval_withdraw'
  /** The company changed what it requires before a bill can be paid. */
  | 'payables.policy'
  | 'bill.void'
  | 'payment.record'
  /**
   * A payment taken back (Phase 52). Carries the reason, because a void with
   * no reason is a hole somebody has to reconstruct from dates months later.
   */
  | 'payment.void'
  /** Held overpayment put against a later invoice, or given back (Phase 53). */
  | 'payment.credit_applied'
  | 'payment.credit_refunded'
  // Phase 44. A card payment is initiated by somebody who is not a user of
  // this system, so "who took this money, and what did the processor keep"
  // has an answer that is not a person's name.
  | 'payment.card_captured'
  | 'payments.settings_update'
  | 'payments.payout_import'
  // Phase 46. A sweep that recovers a payment nobody came back from has moved
  // real money onto the books without a person present, and one that cannot
  // account for a checkout is the start of an investigation.
  | 'payments.sweep'
  | 'customer.create'
  | 'vendor.create'
  // Phase 45. Changing a vendor's details is the commonest invoice-fraud
  // vector a small business meets — an email saying "our bank has changed",
  // a quiet edit, and the next payment run goes to a stranger. Before and
  // after are both recorded, which is the whole reason to prefer an update
  // over a delete and recreate.
  | 'customer.update'
  | 'vendor.update'
  // Time and expense billing (spec §5, Phase 15)
  | 'time.log'
  | 'time.approve'
  | 'time.write_off'
  | 'time.bill'
  | 'expense.mark_billable'
  | 'retainer.receive'
  | 'retainer.apply'
  | 'retainer.refund'
  // Attachments and accountant notes (spec §13, §18, Phase 20)
  | 'document.store'
  | 'document.attach'
  | 'document.detach'
  | 'document.delete'
  | 'note.write'
  | 'note.resolve'
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
  // Property management (spec §5, Phase 23). The deposit actions are here
  // because a deposit is somebody else's money: who took it, who gave it back,
  // and who decided to keep it are exactly the privileged decisions §19 asks
  // to be able to reconstruct.
  | 'property.create'
  | 'property.retire'
  | 'lease.create'
  | 'lease.end'
  | 'rent.run'
  | 'deposit.receive'
  | 'deposit.refund'
  | 'deposit.apply'
  // Fund accounting (spec §5, Phase 26). A release is the moment a charity
  // says a donor's condition has been met, which is a judgement rather than a
  // calculation — so who made it, for which fund and for how much is exactly
  // the privileged decision §19 asks to be able to reconstruct.
  | 'fund.create'
  | 'fund.update'
  | 'fund.close'
  | 'fund.release'
  | 'contribution.record'
  | 'contribution.receive'
  // Daily takings (spec §5, Phase 28). Importing a day decides a business's
  // revenue for that day from somebody else's summary, and records a till
  // discrepancy — both are exactly what §19 asks to be able to reconstruct.
  | 'takings.import'
  // Appointments (spec §5, Phase 29). Completing a visit decides what somebody
  // is paid, and redeeming a card spends money a client handed over months
  // earlier — §19 asks for both to be reconstructable.
  | 'appointment.complete'
  | 'giftcard.redeem'
  // Vehicles (spec §5, Phase 30). Who authorised what is the whole evidentiary
  // content of a repair order, and an odometer going backwards is the one event
  // in this application that may need explaining to somebody official.
  | 'repair.authorise'
  | 'repair.complete'
  | 'vehicle.odometer_rollback'
  // Cash drawers (spec §5, §13, Phase 34). Who opened a till, who counted it,
  // and what they said was in it — the count is a person's declaration about a
  // moment, and §19's whole demand is that such a moment stays reconstructable.
  | 'drawer.create'
  | 'drawer.shift_open'
  | 'drawer.shift_close'
  // Foreign exchange (spec §19, Phase 35). The rate a foreign entry posted at
  // is the one number in the transaction nobody outside the business can
  // check, which makes who set it and when exactly what §19 asks to keep.
  | 'fx.rate_set'
  // Budgets (spec §13, Phase 36). None of these move a penny in the ledger,
  // and they are audited anyway: "who changed the number we are being measured
  // against, and when" is a question somebody asks in every review meeting,
  // and a plan quietly edited to match the result is the oldest trick there is.
  | 'budget.create'
  | 'budget.set_account'
  | 'budget.clear_account'
  | 'budget.approve'
  | 'budget.copy_actuals'
  // Recurring billing (spec §13, Phase 37). A schedule decides what a customer
  // is charged every month without anybody touching it again, so who set it up
  // and who changed the amount is exactly the question asked when a client
  // rings about their invoice.
  | 'billing.schedule_create'
  | 'billing.schedule_pause'
  | 'billing.schedule_resume'
  | 'billing.occurrence_raise'
  // Manufacturing (spec §5, Phase 27). Completing a run decides a unit cost
  // that every subsequent sale of that item is measured against, and
  // cancelling one writes off stock that was consumed and never became
  // anything — both are judgements §19 asks to be able to reconstruct.
  | 'bom.create'
  | 'work_order.create'
  | 'work_order.complete'
  | 'work_order.cancel'
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
  | 'vendor_credit.refund'
  // Taking any of the three refunds back (Phase 69)
  | 'refund.void'
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
  // The Design Center and the design engine (spec §7, §15)
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

/**
 * Who may read the history of what.
 *
 * Phase 71's rule — you may read the history of a record you may read — with
 * Phase 72's guarded domains folded in. The registry lives in `visibility`
 * rather than here, because the whole-company feed below asks the same
 * question and two tables answering it is the defect this codebase keeps
 * removing.
 */

/**
 * What a history screen is given.
 *
 * Explicit rather than `select()`, because the row carries an IP address and a
 * user agent that nothing displaying a history needs, and a query that hands
 * back everything is one somebody eventually renders.
 *
 * `userId` stays. It is not the sensitive part — `actorName` already names the
 * person out loud — and it is the durable identity behind that name: two
 * colleagues can share a display name, and one who leaves keeps their id while
 * the name on old rows is whatever it was at the time. A feed that filtered by
 * name would quietly conflate them.
 */
const HISTORY_COLUMNS = {
  id: auditEvents.id,
  action: auditEvents.action,
  entityType: auditEvents.entityType,
  entityId: auditEvents.entityId,
  userId: auditEvents.userId,
  actorName: auditEvents.actorName,
  before: auditEvents.before,
  after: auditEvents.after,
  isUndo: auditEvents.isUndo,
  undoneByEventId: auditEvents.undoneByEventId,
  batchId: auditEvents.batchId,
  createdAt: auditEvents.createdAt,
} as const

/**
 * History for one record, newest first (spec §3 "undo/history", §19).
 *
 * Gated since Phase 71. It was not before: every caller was in `tests/`, so
 * eighteen months of "nobody has noticed" stood in for a permission check.
 */
export async function historyFor(
  ctx: ActorContext,
  entityType: string,
  entityId: string,
  limit = 50,
) {
  requirePermission(ctx, permissionToRead(entityType))

  return db
    .select(HISTORY_COLUMNS)
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
    .limit(limit)
}

/**
 * Company-wide activity feed, newest first.
 *
 * `audit:view` at last. The permission was declared in Phase 3 for exactly
 * this, granted to an owner and an accountant, and reasoned about in other
 * modules' comments as though it were the gate — `payroll/vendor-reporting`
 * keeps a tax identifier out of the log because that table is "read by
 * everyone with `audit:view`" — while nothing ever checked it.
 */
export async function recentActivity(ctx: ActorContext, limit = 50) {
  requirePermission(ctx, 'audit:view')

  /**
   * `audit:view` opens the feed; it does not open everything in it (Phase 72).
   *
   * A manager holds `audit:view` and deliberately not `payroll:view` — Phase 9
   * says so out loud — and until now this handed them every payroll event on
   * the books, gross and net included. The permission that guards a record
   * guards the events about it too.
   *
   * Filtered in SQL rather than after the fact, because a `limit` applied
   * before the filter returns a short page of what somebody may see rather
   * than a full one, and the shortfall looks like "nothing happened".
   */
  const withheld = withheldEntityTypes((permission) => can(ctx, permission))

  return db
    .select(HISTORY_COLUMNS)
    .from(auditEvents)
    .where(
      scoped(
        ctx,
        auditEvents,
        ...(withheld.length > 0 ? [notInArray(auditEvents.entityType, withheld)] : []),
      ),
    )
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
