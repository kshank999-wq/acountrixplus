'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { DocumentError } from '@/modules/receivables/service'
import { applyVendorCredit } from '@/modules/receivables/vendor-credits'
import { voidPayment } from '@/modules/receivables/payment-voiding'
import { applyCredit, refundCredit } from '@/modules/receivables/customer-credit'
import {
  approveBill,
  updatePayablesPolicy,
  withdrawApproval,
} from '@/modules/payables/approvals-service'
import { messageFor } from '@/modules/errors'
import { formatCents } from '@/lib/money'
import { batchSucceeded } from '@/modules/payables/batch'
import { adviseRun, executePayRun } from '@/modules/payables/pay-runs'

/**
 * Paying suppliers (spec §13, Phase 49).
 *
 * ## The defect this closes
 *
 * `recordPaymentAction` has accepted `documentIds` since Phase 41 and honours
 * the order given. **No screen has ever sent them.** Selection was per vendor,
 * and `allocate` then consumed oldest first — so a business paying a supplier's
 * third invoice while disputing the first two could not: the money landed on
 * the disputed bills and marked them settled.
 *
 * The plumbing was right. What was missing was a screen that knew which bills a
 * person had chosen, and a run that pays them supplier by supplier.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = [
  '/accounting/payments',
  '/accounting/payables',
  '/accounting/invoices',
  '/accounting/receivables',
  '/accounting/reports',
  '/accounting',
]

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31.')

const runSchema = z.object({
  billIds: z.array(uuid).min(1, 'Choose at least one bill to pay.'),
  financialAccountId: uuid,
  paymentDate: isoDate,
  reference: z.string().trim().optional(),
})

/**
 * Pays the chosen bills, one payment per supplier.
 *
 * One per supplier rather than one per bill, because that is how the money
 * leaves: a business paying four of a supplier's invoices writes one cheque and
 * the bank statement shows one line. Four ledger rows against one statement row
 * is a reconciliation nobody can do — the same correspondence Phase 44 needed
 * between a card payout and the deposit it produces.
 *
 * ## What happens if one supplier fails
 *
 * The ones already paid stay paid, and the message says how far it got. Rolling
 * the lot back would undo real payments a business may already have sent from
 * its bank, and leaving it half done with an honest report is the lesser
 * failure — the aging report and the bank tie-out both show the truth either
 * way.
 *
 * **Phase 59 made the second half of that true.** It had never been: the loop
 * accumulated what it had paid, and the `catch` threw the list away and
 * returned `'That pay run could not be completed.'` — so a business paying
 * eight bills across four suppliers, where the third failed, was told the run
 * failed while real money had gone to the first two. Each supplier is now
 * caught on its own, the run is recorded, and a partial run is reported as a
 * success with a warning rather than a failure, because money left the bank.
 */
export async function payRunAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = runSchema.parse(input)

    const { outcome, heldNote } = await executePayRun(actor, {
      billIds: parsed.billIds,
      paymentDate: parsed.paymentDate,
      financialAccountId: parsed.financialAccountId,
      reference: parsed.reference,
    })

    for (const path of PATHS) revalidatePath(path)

    const message = outcome.message + (heldNote ? ` ${heldNote}` : '')

    // A partial run is a success with a warning: money left the bank, and
    // telling somebody it failed is what sends them to re-key it at the bank.
    return batchSucceeded(outcome.status)
      ? { ok: true, message }
      : { ok: false, error: message }
  } catch (error) {
    // Reached only by a failure *outside* the loop — reading the queue, or
    // opening the run. No money has moved at that point.
    return { ok: false, error: messageFor(error, 'That pay run could not be started.') }
  }
}

/** Tells every supplier in a run what their payment covered (Phase 58, 59). */
export async function adviseRunAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const { payRunId } = z.object({ payRunId: uuid }).parse(input)

    const outcome = await adviseRun(actor, payRunId)

    for (const path of PATHS) revalidatePath(path)
    revalidatePath('/accounting/payments')

    return batchSucceeded(outcome.status)
      ? { ok: true, message: outcome.message }
      : { ok: false, error: outcome.message }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Those advices could not be sent.') }
  }
}

const creditSchema = z.object({
  creditNoteId: uuid,
  billId: uuid,
  amountCents: z.number().int().positive('An application has to be for more than nothing.'),
  appliedOn: isoDate,
})

/**
 * Spends a vendor credit against a bill.
 *
 * `applyVendorCredit` and its server action have been written, exported and
 * tested since Phase 12 with **no caller anywhere in `src/app`** — so a credit
 * raised standalone, or one with anything left after the bill it was raised
 * against, was stranded for ever. The screen showed the remaining balance
 * beside no control at all.
 */
export async function spendVendorCreditAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = creditSchema.parse(input)

    const result = await applyVendorCredit(actor, parsed)

    for (const path of PATHS) revalidatePath(path)

    return {
      ok: true,
      message:
        `${formatCents(parsed.amountCents)} of credit applied. ` +
        (result.creditRemainingCents === 0
          ? 'That credit is used up.'
          : `${formatCents(result.creditRemainingCents)} of it is still available.`),
    }
  } catch (error) {
    // A DomainError carries a sentence written for a person; anything else is
    // a surprise and gets the fallback (Phase 47's rule).
    return {
      ok: false,
      error: messageFor(
        error,
        error instanceof DocumentError ? error.message : 'That credit could not be applied.',
      ),
    }
  }
}

const approveSchema = z.object({ billId: uuid })

/** Agrees that a bill may be paid. Never by the person who entered it. */
export async function approveBillAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const { billId } = approveSchema.parse(input)

    const result = await approveBill(actor, billId)
    for (const path of PATHS) revalidatePath(path)

    return { ok: true, message: `${result.number} approved. It can be paid now.` }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That bill could not be approved.') }
  }
}

export async function withdrawApprovalAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const { billId } = approveSchema.parse(input)

    const number = await withdrawApproval(actor, billId)
    for (const path of PATHS) revalidatePath(path)

    return { ok: true, message: `${number} is waiting on an approval again.` }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That approval could not be taken back.') }
  }
}

const policySchema = z.object({
  enabled: z.boolean().optional(),
  thresholdCents: z.number().int().nonnegative().optional(),
  twoPersonRule: z.boolean().optional(),
})

export async function updatePayablesPolicyAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const policy = await updatePayablesPolicy(actor, policySchema.parse(input))

    for (const path of PATHS) revalidatePath(path)

    if (!policy.enabled) {
      return { ok: true, message: 'Approvals are off. Any bill can be paid by anybody who may pay.' }
    }

    return {
      ok: true,
      message:
        `Bills of ${formatCents(policy.thresholdCents)} and up need approving` +
        (policy.twoPersonRule ? ', and not by the person who entered them.' : '.'),
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That could not be saved.') }
  }
}

const voidSchema = z.object({
  paymentId: uuid,
  reason: z.string().trim().min(1, 'Say why this payment is being taken back.').max(500),
})

/**
 * Takes a payment back (Phase 52).
 *
 * Lives here rather than in `documents.ts` because this is the money half, not
 * the document half: `voidDocumentAction` cancels an invoice or a bill, and
 * this cancels the payment that settled one. Voiding a document that has been
 * paid and voiding the payment against a document that stands are different
 * decisions with different consequences, and putting them on one action would
 * have hidden that.
 */
export async function voidPaymentAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = voidSchema.parse(input)

    const result = await voidPayment(actor, parsed)

    for (const path of PATHS) revalidatePath(path)

    return {
      ok: true,
      message:
        `${formatCents(result.amountCents)} taken back. ` +
        (result.restorations.length > 0
          ? `${result.restorations.map((r) => r.number).join(', ')} ` +
            `${result.restorations.length === 1 ? 'is' : 'are'} owed again. `
          : '') +
        (result.ledger === 'reverse'
          ? `The ledger is corrected by reversing entry #${result.reversalNumber}, because the ` +
            'original falls in a closed period.'
          : 'The ledger entry is void with it.'),
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That payment could not be taken back.') }
  }
}

const applyCreditSchema = z.object({
  paymentId: uuid,
  invoiceId: uuid,
  amountCents: z.number().int().positive().optional(),
  appliedOn: isoDate,
})

/** Puts a customer's held overpayment against one of their invoices. */
export async function applyCustomerCreditAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = applyCreditSchema.parse(input)

    const result = await applyCredit(actor, parsed)

    for (const path of PATHS) revalidatePath(path)

    return {
      ok: true,
      message:
        `${formatCents(result.appliedCents)} of credit put against ${result.invoiceNumber}. ` +
        (result.remainingCents === 0
          ? 'That credit is used up.'
          : `${formatCents(result.remainingCents)} of it is still held.`),
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That credit could not be applied.') }
  }
}

const refundSchema = z.object({
  paymentId: uuid,
  amountCents: z.number().int().positive(),
  financialAccountId: uuid,
  refundedOn: isoDate,
  reference: z.string().trim().max(200).optional(),
})

/**
 * Gives a customer's held overpayment back.
 *
 * Phase 52's named follow-up. Deliberately its own action rather than a shape
 * of `voidPaymentAction`: a void says the payment never happened, a refund
 * says it happened and then went the other way, and the customer's own bank
 * statement can tell the two apart even if this application could not.
 */
export async function refundCustomerCreditAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = refundSchema.parse(input)

    const result = await refundCredit(actor, parsed)

    for (const path of PATHS) revalidatePath(path)

    return {
      ok: true,
      message:
        `${formatCents(result.refundedCents)} refunded to ${result.customerName}. ` +
        (result.remainingCents === 0
          ? 'Nothing is held for them now.'
          : `${formatCents(result.remainingCents)} is still held.`),
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That refund could not be made.') }
  }
}
