import { formatCents } from '@/lib/money'
import { getPaymentSettings } from '@/modules/payments/settings'
import { importPayouts } from '@/modules/payments/service'
import { registerHandler, type JobContext } from '../registry'

/**
 * Bringing in what the card processor has deposited (spec §13, Phase 44).
 *
 * ## Why this is a job
 *
 * The money arrives on the processor's schedule, not on anybody's. A business
 * that has to remember to press "check for deposits" has a bank account whose
 * balance is wrong every morning until somebody does — and the whole reason
 * `1250 Payments in Transit` exists is so the books can say where the money is
 * without being asked.
 *
 * ## Firing twice deposits once
 *
 * `payouts` is unique on (company, provider payout id) and the insert is
 * `onConflictDoNothing`, so a second run finds the batch already there and
 * posts nothing. The database decides, which is the rule everywhere the
 * scheduler's at-least-once guarantee meets real money.
 */
registerHandler({
  kind: 'payments.import_payouts',
  label: 'Post what the card processor has deposited',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const settings = await getPaymentSettings(actor.companyId)

    // Silent for almost everybody, and reported as a skip rather than a
    // result — ADR 0024's rule: a job announcing "0 deposits" every morning is
    // a job whose output nobody reads by the end of the week.
    if (!settings.enabled) {
      return { skipped: 'Card payments are switched off for this company.' }
    }
    if (!settings.payoutFinancialAccountId) {
      return { skipped: 'No payout account chosen, so nothing can post.' }
    }

    const result = await importPayouts(actor, {
      since: context.payload.since ? String(context.payload.since) : undefined,
    })

    if (result.imported === 0) return { skipped: 'Nothing new from the processor.' }

    return {
      imported: result.imported,
      postedCents: result.postedCents,
      posted: formatCents(result.postedCents),
      // Kept rather than summarised away. A batch that disagrees with its own
      // payments means a refund netted off, a fee schedule that is not what
      // the company believes, or a double-counted payment — three different
      // problems, and the operations screen is where somebody finds out which.
      discrepancies: result.discrepancies,
    }
  },
})
