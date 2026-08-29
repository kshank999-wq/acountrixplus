import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { bills, payablesSettings } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DocumentError } from '@/modules/receivables/service'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  APPROVAL_OFF,
  STARTING_POLICY,
  mayApprove,
  type ApprovableBill,
  type ApprovalPolicy,
} from './approval'

/**
 * Approving a bill before it can be paid (spec §13, §14, Phase 50).
 *
 * ## What one person could do
 *
 * With `accounting:journal` alone: create a supplier, enter a bill to it, and
 * pay it — and nothing recorded who entered the bill. Phase 49 turned the last
 * step into one click across a batch. This is the second pair of eyes.
 *
 * ## What actually does the separating
 *
 * The **two-person rule**, not the permission. `accounting:approve` is its own
 * permission so that entering and approving are separately grantable, but the
 * default roster hands both to the same roles — an owner or accountant does
 * all of it — and only a bookkeeper, who cannot enter a bill either, is left
 * out. So the rule that bites is "not the bill you entered yourself". The
 * separate permission is the seam for a company that widens things: a
 * colleague granted `accounting:journal` as a per-membership override to enter
 * supplier bills does not thereby gain the power to clear them.
 */

/** What this company has decided. Absent means never agreed to anything. */
export async function payablesPolicy(companyId: string): Promise<ApprovalPolicy> {
  const [row] = await db
    .select()
    .from(payablesSettings)
    .where(eq(payablesSettings.companyId, companyId))
    .limit(1)

  if (!row) return APPROVAL_OFF

  return {
    enabled: row.approvalEnabled,
    thresholdCents: row.approvalThresholdCents,
    twoPersonRule: row.twoPersonRule,
  }
}

export async function updatePayablesPolicy(
  ctx: ActorContext,
  input: { enabled?: boolean; thresholdCents?: number; twoPersonRule?: boolean },
): Promise<ApprovalPolicy> {
  // Switching the control off is itself a control decision, so it needs the
  // stronger permission rather than the one that enters bills.
  requirePermission(ctx, 'accounting:approve')

  if (input.thresholdCents !== undefined && input.thresholdCents < 0) {
    throw new DocumentError('A threshold cannot be negative.')
  }

  /**
   * `STARTING_POLICY`, not `APPROVAL_OFF` (found in the browser).
   *
   * A company that has never decided anything reads back as `APPROVAL_OFF`,
   * whose threshold is zero because nothing reads it while the control is off.
   * Using that as the baseline for the *first save* wrote zero — so switching
   * approvals on made every bill, however small, need a second person, and
   * silently overrode the threshold the schema had chosen.
   */
  const stored = await db
    .select()
    .from(payablesSettings)
    .where(eq(payablesSettings.companyId, ctx.companyId))
    .limit(1)

  const current = stored.length > 0 ? await payablesPolicy(ctx.companyId) : STARTING_POLICY
  const next = {
    enabled: input.enabled ?? current.enabled,
    thresholdCents: input.thresholdCents ?? current.thresholdCents,
    twoPersonRule: input.twoPersonRule ?? current.twoPersonRule,
  }

  await db
    .insert(payablesSettings)
    .values({
      companyId: ctx.companyId,
      approvalEnabled: next.enabled,
      approvalThresholdCents: next.thresholdCents,
      twoPersonRule: next.twoPersonRule,
      updatedBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: payablesSettings.companyId,
      set: {
        approvalEnabled: next.enabled,
        approvalThresholdCents: next.thresholdCents,
        twoPersonRule: next.twoPersonRule,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      },
    })

  await recordAudit(ctx, {
    action: 'payables.policy',
    entityType: 'company',
    entityId: ctx.companyId,
    before: current,
    after: next,
  })

  return next
}

/**
 * Approves one bill.
 *
 * The claim is conditional on the bill still being unapproved, so two people
 * pressing at once produce one approval and the second is told it is already
 * done — the database arbitrates, as it does everywhere in this system two
 * people can act at once.
 */
export async function approveBill(
  ctx: ActorContext,
  billId: string,
): Promise<{ number: string; approvedBy: string }> {
  requirePermission(ctx, 'accounting:approve')

  const [row] = await db
    .select()
    .from(bills)
    .where(scoped(ctx, bills, eq(bills.id, billId)))
    .limit(1)

  if (!row) throw new DocumentError('That bill is not on these books.')
  if (row.status === 'void') throw new DocumentError('That bill has been voided.')

  const policy = await payablesPolicy(ctx.companyId)

  const comparable: ApprovableBill = {
    id: row.id,
    number: row.number,
    totalCents: row.totalCents,
    // The threshold is in the company's currency, so the comparison has to be
    // too — otherwise a foreign bill slips under the control (Phase 60).
    functionalTotalCents: row.functionalTotalCents,
    enteredBy: row.enteredBy,
    approvedBy: row.approvedBy,
  }

  const verdict = mayApprove({ bill: comparable, policy, actorId: ctx.userId })
  if (!verdict.ok) throw new DocumentError(verdict.why)

  const claimed = await db
    .update(bills)
    .set({ approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(bills.id, row.id), isNull(bills.approvedBy)))
    .returning({ id: bills.id })

  if (claimed.length === 0) {
    throw new DocumentError(`${row.number} was approved by somebody else a moment ago.`)
  }

  await recordAudit(ctx, {
    action: 'bill.approve',
    entityType: 'bill',
    entityId: row.id,
    after: { number: row.number, totalCents: row.totalCents, enteredBy: row.enteredBy },
  })

  return { number: row.number, approvedBy: ctx.userId }
}

/**
 * Takes an approval back.
 *
 * Only while nothing has been paid against it. An approval is a statement that
 * money may leave; once it has left, withdrawing the statement changes nothing
 * and would leave a paid bill reading as though it was never authorised — which
 * is a worse record than the truth.
 */
export async function withdrawApproval(ctx: ActorContext, billId: string): Promise<string> {
  requirePermission(ctx, 'accounting:approve')

  const [row] = await db
    .select()
    .from(bills)
    .where(scoped(ctx, bills, eq(bills.id, billId)))
    .limit(1)

  if (!row) throw new DocumentError('That bill is not on these books.')
  if (!row.approvedBy) throw new DocumentError(`${row.number} has not been approved.`)

  if (row.balanceCents !== row.totalCents) {
    throw new DocumentError(
      `${row.number} has already been paid, at least in part. An approval cannot be taken back ` +
        'after the money has gone — void the payment if it was wrong.',
    )
  }

  await db
    .update(bills)
    .set({ approvedBy: null, approvedAt: null, updatedAt: new Date() })
    .where(eq(bills.id, row.id))

  await recordAudit(ctx, {
    action: 'bill.approve',
    entityType: 'bill',
    entityId: row.id,
    before: { approvedBy: row.approvedBy },
    after: { approvedBy: null, withdrawn: true },
  })

  return row.number
}
