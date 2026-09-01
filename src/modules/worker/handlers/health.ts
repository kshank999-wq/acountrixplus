import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { memberships } from '@/db/schema'
import { hasPermission, type Role } from '@/modules/permissions'
import { notify } from '@/modules/mobile/notifications'
import { culpritPhrase } from '@/modules/marketing/attribution'
import { health } from '../health'
import { registerHandler, type JobContext } from '../registry'

/**
 * The failure digest (spec §18, §19).
 *
 * ## A digest, not a notification per failure
 *
 * One broken bank feed retried five times is one dead job; one broken mail
 * provider is forty bounces in an hour. Sending a notification each would mean
 * the worst outage produces the loudest noise at the moment somebody most
 * needs to think — and the second-worst produces enough that the phone gets
 * silenced before the worst arrives.
 *
 * So: one message a day, with a count, and **nothing at all when the count is
 * zero**. Silence has to mean something, or the digest becomes a daily
 * "everything is fine" that nobody reads and therefore cannot notice the day
 * it says otherwise.
 *
 * ## Per company, and honest about it
 *
 * Dead jobs with no tenant reach every company's digest, which is the choice
 * Phase 10 already made for the operations page and for the same reason. What
 * this does *not* do is tell the deployment operator anything — there is no
 * operator identity in this application, and inventing one to page would be a
 * feature pretending to be a notification.
 */
registerHandler({
  kind: 'ops.failure_digest',
  label: 'Tell somebody about work that gave up and letters that bounced',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const hours = Number(context.payload.hours ?? 24)
    const since = context.payload.since
      ? new Date(String(context.payload.since))
      : new Date(Date.now() - hours * 60 * 60 * 1000)

    const state = await health(actor, { since })

    /*
      The whole point. A digest that fires on a quiet day teaches people to
      ignore the one that fires on a loud one.

      `worthSaying` rather than `total > 0` since Phase 84. A sending
      reputation going bad is not a count of things that failed — nothing
      failed, which is exactly why it is easy to miss until the domain is
      spent. It is the one thing here that gets worse while nobody does
      anything about it.
    */
    if (!state.worthSaying) {
      return { since: since.toISOString(), total: state.total, sent: 0 }
    }

    const rows = await db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.isActive, true)))

    const recipients = rows
      .filter((row) => hasPermission(row.role as Role, 'company:manage'))
      .map((row) => row.userId)

    const parts: string[] = []
    if (state.deadJobs.length > 0) {
      parts.push(
        `${state.deadJobs.length} background job${state.deadJobs.length === 1 ? '' : 's'} gave up`,
      )
    }
    if (state.bouncedMail.length > 0) {
      parts.push(
        `${state.bouncedMail.length} letter${state.bouncedMail.length === 1 ? '' : 's'} did not arrive`,
      )
    }
    if (state.sending && state.sending.concern) {
      // Leads, when it is the urgent one. A dead job is still there tomorrow;
      // a sending reputation is not.
      const phrase = `Marketing email: ${state.sending.concern}`
      if (state.sending.level === 'urgent') parts.unshift(phrase)
      else parts.push(phrase)
    }

    let sent = 0
    let suppressed = 0

    for (const userId of recipients) {
      const result = await notify({
        companyId: actor.companyId,
        userId,
        topic: 'background_failures',
        message: {
          title: parts.join(', '),
          // The first error rather than a count of distinct ones: somebody
          // reading this on a phone wants to know whether to get a laptop out,
          // and one real message answers that better than a tally.
          body:
            state.sending?.level === 'urgent'
              ? // The culprit when there is one, because "which send do I stop"
                // is the question somebody reading this on a phone actually
                // has, and a company-wide rate does not answer it (Phase 85).
                (culpritPhrase(state.culprit) ??
                `Over ${state.sending.accepted} messages in the last week. Mailbox providers score this over weeks, so it is worth looking today.`)
              : (state.deadJobs[0]?.lastError ??
                state.bouncedMail[0]?.error ??
                state.sending?.concern ??
                'Nothing retried them, and nothing will.'),
          url: '/settings/operations',
          tag: 'failure-digest',
        },
      })

      sent += result.sent
      if (result.suppressed) suppressed += 1
    }

    return {
      since: since.toISOString(),
      deadJobs: state.deadJobs.length,
      bouncedMail: state.bouncedMail.length,
      sending: state.sending?.level ?? 'unknown',
      culprit: state.culprit?.campaignId ?? null,
      total: state.total,
      sent,
      suppressed,
    }
  },
})
