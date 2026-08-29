import { runChases } from '@/modules/receivables/chase-run'
import { runStatements } from '@/modules/receivables/statement-run'
import { registerHandler, type JobContext } from '../registry'

/**
 * Chasing overdue invoices (spec §13, Phase 43).
 *
 * ## Why this is a job
 *
 * Getting paid is the thing a small business is worst at, and not because they
 * do not know who owes them — the aging report has said so since Phase 2. It
 * is that chasing is a job nobody has, which has to happen on a Tuesday when
 * something else is on fire, and which feels rude. So an invoice that went out
 * in March is still open in July because nobody said anything after the first
 * email.
 *
 * Phase 42 built the send. Phase 10 built this queue. The only part missing
 * was something that decides *when* without being asked.
 *
 * ## Silent for almost everybody
 *
 * Chasing is off unless a company has switched it on, so on most nights for
 * most companies this reads two tables and returns having sent nothing. That
 * is reported as a skip rather than a result, for ADR 0024's reason: a job
 * that announces "0 sent" every morning is a job whose output nobody reads by
 * the end of the week, and the one morning it matters is buried with it.
 *
 * ## Firing twice does not chase twice
 *
 * The scheduler guarantees at least once. What stops a double chase is not a
 * lock here but the decision itself: `sendInvoice` stamps `sent_at`, and the
 * second run sees no silence has passed since and answers `too_soon`. The
 * state that prevents the repeat is the same state that records the first
 * send — there is no separate "already chased today" flag to fall out of step
 * with what actually went out.
 */
registerHandler({
  kind: 'receivables.chase_overdue',
  label: 'Chase overdue invoices the policy says are due one',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    // From the payload rather than the clock, so a run can be replayed for a
    // date and a test can assert on one.
    const asOf = context.payload.asOf ? String(context.payload.asOf) : undefined

    const result = await runChases(actor, { asOf })

    if (!result.enabled) {
      return { skipped: 'Chasing is switched off for this company.' }
    }

    if (result.sent === 0 && result.failed === 0) {
      return { skipped: `Nothing was due on ${result.asOf}.`, considered: result.considered }
    }

    return {
      asOf: result.asOf,
      considered: result.considered,
      sent: result.sent,
      failed: result.failed,
      // Kept rather than summarised away. "The provider refused it" and "the
      // customer has no address" are different problems with different fixes,
      // and the operations screen is where somebody finds out which happened.
      notes: result.notes,
    }
  },
})

/**
 * Sending the month's statements (spec §13, Phase 57).
 *
 * ## Why this is a job, when Phase 55 already made sending possible
 *
 * Because a month-end statement run is a job somebody does on one afternoon or
 * does not do at all. Phase 55 gave a person a Send button; this is what makes
 * it happen without a person, which for a repetitive, unurgent, unpleasant task
 * is the difference between a feature and a habit.
 *
 * ## Daily, deciding for itself whether today is the day
 *
 * Scheduled every day rather than monthly, and `runStatements` compares today
 * against the company's `dayOfMonth`. The schedule then lives in a row somebody
 * can change on a screen, rather than in a cron expression that needs a
 * deployment — which is the same reason Phase 43's cadence is data.
 *
 * ## Firing twice does not send twice
 *
 * The scheduler guarantees at least once. What stops a double send is the
 * decision itself: `sendStatement` stamps `sent_at`, and the second run of the
 * day sees no quiet has passed since and answers `sent_recently`. The state
 * that prevents the repeat is the same state that records the first send, so
 * there is no separate "already run today" flag to fall out of step with what
 * actually went out.
 */
registerHandler({
  kind: 'receivables.send_statements',
  label: 'Send the month’s statements to customers with something to be told',
  handler: async (context: JobContext) => {
    const actor = context.actor!
    const asOf = context.payload.asOf ? String(context.payload.asOf) : undefined

    const result = await runStatements(actor, { asOf })

    if (!result.enabled) {
      return { skipped: 'Statement runs are switched off for this company.' }
    }

    // Silent on the other 27 days of the month, for ADR 0024's reason: a job
    // that announces "0 sent" every morning is one nobody reads by the end of
    // the week, and the morning it matters is buried with it.
    if (result.sent === 0 && result.failed === 0) {
      return { skipped: `No statements were due on ${result.asOf}.`, considered: result.considered }
    }

    return {
      asOf: result.asOf,
      considered: result.considered,
      saved: result.saved,
      sent: result.sent,
      failed: result.failed,
      notes: result.notes,
    }
  },
})
