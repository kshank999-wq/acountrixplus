import { formatCents } from '@/lib/money'
import { getPaymentSettings } from '@/modules/payments/settings'
import { importPayouts, sweepUnresolvedCheckouts } from '@/modules/payments/service'
import { describeSweep, needsAttention } from '@/modules/payments/reconcile'
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

/**
 * Asking the processor about payments nobody came back from (Phase 46).
 *
 * ## Why hourly rather than daily
 *
 * Everything else on this schedule is money the business is waiting for.
 * This is money the business **already has** and does not know about — and
 * while it does not know, the invoice reads unpaid and Phase 43 chases the
 * customer for it. A day of that is a day of asking somebody for money they
 * have already sent, which is the worst thing this system can do to a
 * customer, so the loop runs as often as is reasonable.
 *
 * ## Silent unless something happened
 *
 * A run that only found payments still with the customer reports a skip. A
 * job announcing "0 recovered" every hour is one nobody reads by the
 * afternoon (ADR 0024), and the hour that matters is buried with it.
 */
registerHandler({
  kind: 'payments.sweep_checkouts',
  label: 'Find out what happened to payments nobody came back from',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const settings = await getPaymentSettings(actor.companyId)
    if (!settings.enabled) {
      return { skipped: 'Card payments are switched off for this company.' }
    }

    const summary = await sweepUnresolvedCheckouts(actor, {
      asOf: context.payload.asOf ? String(context.payload.asOf) : undefined,
    })

    const sentence = describeSweep(summary)
    if (!sentence) {
      return { skipped: `Nothing to resolve. ${summary.waiting} still with a customer.` }
    }

    return {
      summary: sentence,
      settled: summary.settled,
      expired: summary.expired,
      failed: summary.failed,
      // The one number worth waking somebody for. Everything else here is the
      // sweep working, or a customer changing their mind.
      investigate: summary.investigate,
      needsAttention: needsAttention(summary),
    }
  },
})
