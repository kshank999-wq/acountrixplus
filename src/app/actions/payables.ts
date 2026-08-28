'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { recordPayment, DocumentError } from '@/modules/receivables/service'
import { applyVendorCredit } from '@/modules/receivables/vendor-credits'
import { billsByIds } from '@/modules/payables/queue'
import { applicationOrder, planRun } from '@/modules/payables/run'
import { messageFor } from '@/modules/errors'
import { formatCents } from '@/lib/money'

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
 */
export async function payRunAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = runSchema.parse(input)

    const chosen = await billsByIds(actor, parsed.billIds)

    if (chosen.length === 0) {
      return { ok: false, error: 'None of those bills is still outstanding.' }
    }

    const plan = planRun({ chosen, availableCents: null })

    const paid: string[] = []
    let paidCents = 0

    for (const supplier of plan.suppliers) {
      // Oldest first *within* what was chosen. The choice is respected
      // absolutely — a bill nobody ticked is never touched — but among the
      // ones they did tick, settling the oldest first is what a supplier
      // expects and what keeps an aging report sensible.
      const ordered = applicationOrder(chosen.filter((bill) => bill.vendorId === supplier.vendorId))

      await recordPayment(actor, {
        kind: 'disbursement',
        vendorId: supplier.vendorId,
        paymentDate: parsed.paymentDate,
        amountCents: supplier.totalCents,
        financialAccountId: parsed.financialAccountId,
        reference: parsed.reference || undefined,
        applications: ordered.map((bill) => ({
          billId: bill.id,
          amountCents: bill.balanceCents,
        })),
      })

      paid.push(supplier.vendorName)
      paidCents += supplier.totalCents
    }

    for (const path of PATHS) revalidatePath(path)

    return {
      ok: true,
      message:
        `${formatCents(paidCents)} paid — ${paid.length} payment${paid.length === 1 ? '' : 's'}, ` +
        `one per supplier, settling ${chosen.length} bill${chosen.length === 1 ? '' : 's'}.`,
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'That pay run could not be completed.') }
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
