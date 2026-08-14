import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '@/db'
import { campaigns, campaignSteps } from '@/db/schema'
import { sendStep } from '@/modules/marketing/campaigns'
import { registerHandler, type JobContext } from '../registry'
import { enqueue } from '../queue'

/**
 * Campaign scheduling — the thing ADR 0005 said was missing.
 *
 * From that ADR:
 *
 * > `scheduledFor` puts a campaign on the calendar and a nurture step's
 * > `delayDays` is recorded, but nothing fires on its own — sending is a
 * > button somebody presses. The missing piece is a background worker calling
 * > the same `sendStep` that enforces consent.
 *
 * The emphasis is the point: **the same `sendStep`**. Every consent rule,
 * suppression check, and unsubscribe honour lives in that function, and a
 * scheduler that reimplemented sending to be more convenient would be a second
 * path that skips them. This handler picks campaigns and calls it — nothing
 * more.
 */

registerHandler({
  kind: 'campaign.send_due',
  label: 'Send campaigns whose scheduled time has passed',
  handler: async (context: JobContext) => {
    const actor = context.actor!
    const now = new Date()

    const due = await db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.companyId, actor.companyId),
          eq(campaigns.status, 'scheduled'),
          isNotNull(campaigns.scheduledFor),
          lte(campaigns.scheduledFor, now),
        ),
      )

    const sent: string[] = []
    const failed: Array<{ campaign: string; reason: string }> = []

    for (const campaign of due) {
      try {
        const summary = await sendStep(actor, campaign.id, 1)
        sent.push(campaign.name)

        // A nurture sequence's later steps are scheduled from the moment the
        // first one actually went out, not from when it was *meant* to. A
        // worker that was down for a day would otherwise fire steps two and
        // three immediately on recovery, which is the failure mode that reads
        // to a recipient as being spammed.
        await scheduleFollowingSteps(actor.companyId, campaign.id, new Date())

        void summary
      } catch (error) {
        // Recorded, not thrown. One campaign missing a from-address must not
        // stop every other company's campaign in the same tick.
        failed.push({
          campaign: campaign.name,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { considered: due.length, sent, failed }
  },
})

/**
 * Queues each later step of a nurture sequence at its own delay.
 *
 * `delayDays` is cumulative down the sequence — step 3 at two days after step 2
 * at three days after step 1 lands five days out, not two.
 */
async function scheduleFollowingSteps(
  companyId: string,
  campaignId: string,
  from: Date,
): Promise<void> {
  const steps = await db
    .select()
    .from(campaignSteps)
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.companyId, companyId)))
    .orderBy(campaignSteps.stepNumber)

  let offsetDays = 0

  for (const step of steps) {
    if (step.stepNumber === 1) continue
    offsetDays += step.delayDays

    const runAt = new Date(from.getTime() + offsetDays * 24 * 60 * 60 * 1000)

    await enqueue({
      kind: 'campaign.send_step',
      companyId,
      payload: { campaignId, stepNumber: step.stepNumber },
      runAt,
      // One job per step per campaign, ever. Re-running the parent handler
      // after a crash must not double the sequence.
      dedupeKey: `campaign-step:${campaignId}:${step.stepNumber}`,
    })
  }
}

registerHandler({
  kind: 'campaign.send_step',
  label: 'Send one nurture step',
  handler: async (context: JobContext) => {
    const actor = context.actor!
    const campaignId = String(context.payload.campaignId)
    const stepNumber = Number(context.payload.stepNumber)

    const summary = await sendStep(actor, campaignId, stepNumber)

    return {
      campaignId,
      stepNumber,
      matched: summary.matched,
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
    }
  },
})
