import { formatCents } from '@/lib/money'
import { runDueSchedules } from '@/modules/billing/service'
import { registerHandler, type JobContext } from '../registry'

/**
 * Raising the invoices a schedule promised (spec §13, Phase 37).
 *
 * ## Why this is a job at all
 *
 * A recurring invoice that only happens when somebody opens a page is a
 * calendar reminder with extra steps. The whole value of the arrangement is
 * that a retainer client is billed on the 1st whether or not anybody thought
 * about it that morning — which is Phase 24's argument, applied to the thing a
 * business notices fastest when it stops.
 *
 * Daily rather than monthly, because the cadences differ: a weekly arrangement
 * and one on the 15th are both real, and a monthly job would bill the weekly
 * one four times at once or the mid-month one late. Each schedule carries its
 * own next date; this just asks every day whether any of them has arrived.
 *
 * Safe to fire twice, and it will be: the scheduler guarantees at least once
 * (Phase 10), and the occurrence row's unique constraint is what makes the
 * second attempt do nothing rather than bill December again.
 */
registerHandler({
  kind: 'billing.run_schedules',
  label: 'Raise invoices from billing schedules that have fallen due',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const asOfDate = String(
      context.payload.asOfDate ?? new Date().toISOString().slice(0, 10),
    )

    const results = await runDueSchedules(actor, asOfDate)

    if (results.length === 0) {
      // Not an error and not worth a notification. Most days, for most
      // companies, nothing is due — and a job that announced that daily is one
      // whose output nobody reads by the end of the week (ADR 0024).
      return { skipped: 'Nothing was due.' }
    }

    const raised = results.filter((row) => row.raised)
    const waiting = results.filter((row) => !row.raised && row.skipped === 'Waiting for somebody to raise it.')
    const totalCents = raised.reduce((sum, row) => sum + row.totalCents, 0)

    return {
      asOfDate,
      considered: results.length,
      invoicesRaised: raised.length,
      totalCents,
      total: formatCents(totalCents),
      awaitingSomebody: waiting.length,
      // The skipped reasons are kept rather than summarised away: "already
      // billed for this date" and "past its end date" are different facts, and
      // the operations screen is where somebody finds out which happened.
      skipped: results
        .filter((row) => row.skipped)
        .map((row) => ({ name: row.name, on: row.occurredOn, why: row.skipped })),
    }
  },
})
