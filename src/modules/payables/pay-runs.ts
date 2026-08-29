import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { financialAccounts } from '@/db/schema'
import { payRuns, payments, vendors } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError, messageFor } from '@/modules/errors'
import { recordPayment } from '@/modules/receivables/service'
import { sendRemittance } from './remittance-send'
import { billsByIds } from './queue'
import { describeHeld, splitByApproval } from './approval'
import { payablesPolicy } from './approvals-service'
import { applicationOrder, planRun } from './run'
import {
  adviseOutcome,
  payRunOutcome,
  type AdviseOutcome,
  type BatchFailure,
  type BatchStatus,
  type PayRunOutcome,
} from './batch'

/**
 * The record of one press of "Pay" (spec §13, §19, Phase 59).
 *
 * ## What was missing
 *
 * Phase 49 pays one supplier at a time in a loop with no transaction around it,
 * and that is the right shape — rolling back would undo real payments a business
 * may already have sent from its bank. What it did **not** do is record that the
 * loop happened, so a run that got three suppliers in and failed on the fourth
 * left the books correct and the person misinformed: the message said the run
 * could not be completed, and said nothing about the money that had gone.
 *
 * This module writes the run down, so that a half-done one is visible
 * afterwards, and so that Phase 58's remittance advice can be sent to a whole
 * batch — the follow-up ADR 0058 nominated.
 */

export class PayRunError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'PayRunError'
  }
}

/**
 * Opens the run before any money moves.
 *
 * Written first, and updated when the loop finishes, for the reason Phase 42
 * records a message before sending it: a run that crashes between the first
 * payment and the summary leaves a row saying somebody started one, which a
 * person can act on. A run written only on success would leave the crash
 * invisible, which is the failure this phase exists to fix.
 */
export async function openPayRun(
  ctx: ActorContext,
  input: {
    runDate: string
    reference: string | null
    financialAccountId: string
    suppliersAttempted: number
  },
): Promise<string> {
  requirePermission(ctx, 'accounting:journal')

  const [row] = await db
    .insert(payRuns)
    .values({
      companyId: ctx.companyId,
      runDate: input.runDate,
      reference: input.reference,
      financialAccountId: input.financialAccountId,
      // Until the loop reports otherwise, nothing has been paid. A crash
      // leaves this standing, which is the truth at that moment.
      status: 'nothing',
      suppliersAttempted: input.suppliersAttempted,
      createdBy: ctx.userId ?? null,
    })
    .returning({ id: payRuns.id })

  return row.id
}

/** Writes what the loop actually did onto the run it opened. */
export async function closePayRun(
  ctx: ActorContext,
  payRunId: string,
  result: {
    status: BatchStatus
    suppliersPaid: number
    billsSettled: number
    paidCents: number
    unpaidCents: number
    failures: BatchFailure[]
  },
): Promise<void> {
  await db
    .update(payRuns)
    .set({
      status: result.status,
      suppliersPaid: result.suppliersPaid,
      billsSettled: result.billsSettled,
      paidCents: result.paidCents,
      unpaidCents: result.unpaidCents,
      failures: result.failures.length
        ? result.failures.map((f) => `${f.vendorName}: ${f.error}`).join('\n')
        : null,
    })
    .where(scoped(ctx, payRuns, eq(payRuns.id, payRunId)))

  await recordAudit(ctx, {
    action: 'payrun.complete',
    entityType: 'pay_run',
    entityId: payRunId,
    after: {
      status: result.status,
      suppliersPaid: result.suppliersPaid,
      paidCents: result.paidCents,
      failed: result.failures.length,
    },
  })
}

export type ExecutedPayRun = {
  payRunId: string
  outcome: PayRunOutcome
  /** What Phase 50 held back for want of an approval, in its own words. */
  heldNote: string | null
}

/**
 * Pays the chosen bills, one payment per supplier, and records the run.
 *
 * ## Why the loop lives here rather than in the server action
 *
 * It used to be in `payRunAction`, which put the one piece of behaviour this
 * phase is about — what happens when a supplier in the middle fails — inside
 * `src/app`, where this project keeps no business logic and where nothing can
 * reach it from a test. Moving it makes the failure provable rather than
 * argued about.
 *
 * ## Why each supplier is caught on its own
 *
 * One failing — a euro bill with no rate on file for the payment date, a bill
 * somebody voided between the tick and the press — is not a reason to leave
 * the rest unpaid. The old code let the exception out of the loop, so
 * suppliers after the failure were never attempted and the ones before it were
 * never reported.
 *
 * ## Why there is still no transaction around the whole run
 *
 * Deliberate, and unchanged from Phase 49. Rolling back would undo payments a
 * business may already have sent from its bank; the ledger is correct either
 * way, and a half-done run reported honestly is the lesser failure. What was
 * missing was the honest report.
 */
export async function executePayRun(
  ctx: ActorContext,
  input: {
    billIds: string[]
    paymentDate: string
    financialAccountId: string
    reference?: string | null
  },
): Promise<ExecutedPayRun> {
  requirePermission(ctx, 'accounting:journal')

  const chosen = await billsByIds(ctx, input.billIds)
  if (chosen.length === 0) {
    throw new PayRunError('None of those bills is still outstanding.')
  }

  /**
   * What nobody has approved is left where it is (Phase 50).
   *
   * Held back rather than refusing the whole run: somebody ticking eight bills
   * of which one needs approving should get the seven paid and be told about
   * the eighth. Refusing the lot teaches them to switch approvals off, which
   * is the opposite of what the control is for.
   */
  const policy = await payablesPolicy(ctx.companyId)
  const split = splitByApproval(chosen, policy)
  const heldNote = describeHeld(split.held) ?? null

  if (split.payable.length === 0) {
    throw new PayRunError(heldNote ?? 'Nothing in that run can be paid yet.')
  }

  const plan = planRun({ chosen: split.payable, availableCents: null })

  // Opened before any money moves, so a crash mid-loop still leaves a row
  // saying somebody started a run — the fact that used to vanish entirely.
  const payRunId = await openPayRun(ctx, {
    runDate: input.paymentDate,
    reference: input.reference || null,
    financialAccountId: input.financialAccountId,
    suppliersAttempted: plan.suppliers.length,
  })

  const paid: {
    vendorId: string
    vendorName: string
    amountCents: number
    billCount: number
  }[] = []
  const failed: BatchFailure[] = []
  const attemptedCentsByVendor: Record<string, number> = {}

  for (const supplier of plan.suppliers) {
    attemptedCentsByVendor[supplier.vendorId] = supplier.totalCents

    // Oldest first *within* what was chosen. The choice is respected
    // absolutely — a bill nobody ticked is never touched — but among the ones
    // they did tick, settling the oldest first is what a supplier expects and
    // what keeps an aging report sensible.
    const ordered = applicationOrder(
      split.payable.filter((bill) => bill.vendorId === supplier.vendorId),
    )

    try {
      await recordPayment(ctx, {
        kind: 'disbursement',
        vendorId: supplier.vendorId,
        paymentDate: input.paymentDate,
        amountCents: supplier.totalCents,
        financialAccountId: input.financialAccountId,
        reference: input.reference || undefined,
        payRunId,
        applications: ordered.map((bill) => ({
          billId: bill.id,
          amountCents: bill.balanceCents,
        })),
      })

      paid.push({
        vendorId: supplier.vendorId,
        vendorName: supplier.vendorName,
        amountCents: supplier.totalCents,
        billCount: ordered.length,
      })
    } catch (error) {
      failed.push({
        vendorId: supplier.vendorId,
        vendorName: supplier.vendorName,
        // The domain's own sentence, which names the fix (Phase 47's rule).
        error: messageFor(error, 'the payment was refused'),
      })
    }
  }

  const outcome = payRunOutcome({ paid, failed, attemptedCentsByVendor })

  await closePayRun(ctx, payRunId, {
    status: outcome.status,
    suppliersPaid: paid.length,
    billsSettled: outcome.billsSettled,
    paidCents: outcome.paidCents,
    unpaidCents: outcome.unpaidCents,
    failures: failed,
  })

  return { payRunId, outcome, heldNote }
}

export type PayRunRow = {
  id: string
  runDate: string
  reference: string | null
  accountName: string | null
  status: BatchStatus
  suppliersAttempted: number
  suppliersPaid: number
  billsSettled: number
  paidCents: number
  unpaidCents: number
  failures: string | null
  advisedAt: Date | null
  adviseCount: number
  /** How many of this run's payments still stand — a void changes it. */
  liveSuppliers: number
  /** How many of those have had an advice sent (Phase 58). */
  advisedSuppliers: number
}

/**
 * Recent runs, newest first.
 *
 * `liveSuppliers` and `advisedSuppliers` are counted from the payments rather
 * than stored on the run, because both change *after* the run finishes: Phase
 * 52 can void one of its payments, and Phase 58 can advise one on its own. A
 * stored count would be a second answer that drifts.
 */
export async function listPayRuns(ctx: ActorContext, limit = 12): Promise<PayRunRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      run: payRuns,
      accountName: financialAccounts.name,
      liveSuppliers: sql<string>`(
        select count(*) from ${payments}
        where ${payments.payRunId} = ${payRuns.id} and ${payments.status} <> 'void'
      )`,
      advisedSuppliers: sql<string>`(
        select count(*) from ${payments}
        where ${payments.payRunId} = ${payRuns.id}
          and ${payments.status} <> 'void'
          and ${payments.remittanceSentAt} is not null
      )`,
    })
    .from(payRuns)
    .leftJoin(financialAccounts, eq(financialAccounts.id, payRuns.financialAccountId))
    .where(scoped(ctx, payRuns))
    .orderBy(desc(payRuns.runDate), desc(payRuns.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.run.id,
    runDate: row.run.runDate,
    reference: row.run.reference,
    accountName: row.accountName,
    status: row.run.status as BatchStatus,
    suppliersAttempted: row.run.suppliersAttempted,
    suppliersPaid: row.run.suppliersPaid,
    billsSettled: row.run.billsSettled,
    paidCents: row.run.paidCents,
    unpaidCents: row.run.unpaidCents,
    failures: row.run.failures,
    advisedAt: row.run.advisedAt,
    adviseCount: row.run.adviseCount,
    liveSuppliers: Number(row.liveSuppliers ?? 0),
    advisedSuppliers: Number(row.advisedSuppliers ?? 0),
  }))
}

/**
 * Tells every supplier in a run what their payment covered.
 *
 * The follow-up ADR 0058 named: Phase 58 advises one payment, and doing it
 * forty times by hand after a pay run is the job nobody does.
 *
 * ## Why it does not stop at the first refusal
 *
 * A supplier with no address on file is ordinary, and Phase 58 refuses that
 * case with an instruction rather than a rule. A loop that threw on the first
 * one would leave the rest of the run silently unadvised — the same shape of
 * failure this phase exists to fix, one level up. Each supplier is caught on
 * its own and reported by name.
 *
 * ## Why a voided payment is skipped rather than refused
 *
 * Phase 58 will not send a fresh advice for a payment that has been taken back,
 * and it is right not to: the advice would describe money the supplier does not
 * have. Inside a batch that is not a failure worth reporting — nobody asked for
 * that supplier to be told — so it is passed over silently, and the supplier's
 * existing link already says the payment was reversed.
 */
export async function adviseRun(ctx: ActorContext, payRunId: string): Promise<AdviseOutcome> {
  requirePermission(ctx, 'accounting:view')

  const [run] = await db
    .select({ id: payRuns.id })
    .from(payRuns)
    .where(scoped(ctx, payRuns, eq(payRuns.id, payRunId)))
    .limit(1)

  if (!run) throw new PayRunError('That pay run is not on these books.')

  const rows = await db
    .select({
      paymentId: payments.id,
      vendorId: payments.vendorId,
      vendorName: vendors.name,
    })
    .from(payments)
    .leftJoin(vendors, eq(vendors.id, payments.vendorId))
    .where(
      scoped(
        ctx,
        payments,
        and(eq(payments.payRunId, payRunId), sql`${payments.status} <> 'void'`),
      ),
    )
    .orderBy(vendors.name)

  const sent: { vendorId: string; vendorName: string; to: string }[] = []
  const failed: BatchFailure[] = []

  for (const row of rows) {
    const vendorName = row.vendorName ?? 'a supplier'
    try {
      const result = await sendRemittance(ctx, row.paymentId)
      sent.push({ vendorId: row.vendorId ?? '', vendorName, to: result.to })
    } catch (error) {
      failed.push({
        vendorId: row.vendorId ?? '',
        vendorName,
        // The domain's own sentence, which names the fix (Phase 47's rule).
        error: messageFor(error, 'the advice could not be sent'),
      })
    }
  }

  const outcome = adviseOutcome({ sent, failed })

  if (sent.length > 0) {
    await db
      .update(payRuns)
      .set({ advisedAt: new Date(), adviseCount: sql`${payRuns.adviseCount} + 1` })
      .where(scoped(ctx, payRuns, eq(payRuns.id, payRunId)))
  }

  await recordAudit(ctx, {
    action: 'payrun.advise',
    entityType: 'pay_run',
    entityId: payRunId,
    after: { sent: sent.length, failed: failed.length, status: outcome.status },
  })

  return outcome
}

/** Whether any run has ever been recorded, so the screen can stay quiet. */
export async function hasPayRuns(ctx: ActorContext): Promise<boolean> {
  const [row] = await db
    .select({ id: payRuns.id })
    .from(payRuns)
    .where(scoped(ctx, payRuns, isNotNull(payRuns.id)))
    .limit(1)

  return Boolean(row)
}
