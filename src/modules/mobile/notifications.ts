import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  notificationLog,
  notificationPreferences,
  notificationTopicEnum,
  pushSubscriptions,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { getPushProvider, type PushMessage } from './push-provider'

/**
 * Notifications (spec §3 "bookkeeping as a continuous habit").
 *
 * ## Why this module is small and cautious
 *
 * The feature that makes a bookkeeping app get opened is a reminder. The
 * feature that makes it get uninstalled is also a reminder. Everything here is
 * shaped by that: a topic a person can switch off individually, a ledger of
 * every attempt so "why did I get that" has an answer, and no notification
 * that is not about something the person actually has to decide.
 *
 * ## Absent means on, unlike the AI module
 *
 * ADR 0006 made "unconfigured" and "off" the same state for AI, because AI is
 * additive and nobody should get it by forgetting. Notifications are the
 * reverse: granting the browser permission *is* the opt-in, it is explicit,
 * and it already happened. Making somebody opt in a second time is how a
 * useful reminder never arrives. Switching one off writes a row.
 */

export type NotificationTopic = (typeof notificationTopicEnum.enumValues)[number]

export const TOPIC_LABELS: Record<NotificationTopic, string> = {
  transactions_to_review: 'Transactions waiting for review',
  proposal_decided: 'A proposal was accepted or declined',
  invoice_paid: 'An invoice was paid',
  compliance_expiring: 'Subcontractor insurance expiring',
  reconciliation_ready: 'An account is ready to reconcile',
  remittance_due: 'Payroll or sales tax owed to an agency',
  follow_up_due: 'A follow-up you promised is late',
  background_failures: 'Scheduled work failed, or a letter did not arrive',
}

export const TOPIC_DESCRIPTIONS: Record<NotificationTopic, string> = {
  transactions_to_review:
    'A nudge when enough has piled up to be worth a few minutes — not every time a transaction arrives.',
  proposal_decided: 'The moment a client signs, or says no.',
  invoice_paid: 'When money lands against an invoice.',
  compliance_expiring: 'Before a certificate lapses, not after.',
  reconciliation_ready: 'When a statement period is complete enough to reconcile.',
  remittance_due:
    'While there is still time to pay it. This is the one that costs penalties if it is missed.',
  follow_up_due:
    'Once a day, with a count rather than one message per task. A promise made on a call is chased without anybody opening a page.',
  background_failures:
    'A daily digest of scheduled work that gave up and letters that bounced. Silence means there is nothing to see, which is the point.',
}

/** How many transactions have to be waiting before a nudge is worth sending. */
export const REVIEW_NUDGE_THRESHOLD = 5

// --- Subscriptions ---------------------------------------------------------

export async function subscribe(
  ctx: ActorContext,
  input: { endpoint: string; p256dh: string; auth: string; deviceId?: string | null },
) {
  if (!input.endpoint.startsWith('https://')) {
    throw new Error('A push endpoint must be an https URL.')
  }

  const provider = getPushProvider()

  return db.transaction(async (tx) => {
    // Re-subscribing replaces rather than adds: a browser that rotates its
    // endpoint would otherwise leave a dead row behind for every rotation, and
    // every one of them would be tried on every send.
    const [subscription] = await tx
      .insert(pushSubscriptions)
      .values({
        companyId: ctx.companyId,
        userId: ctx.userId,
        deviceId: input.deviceId ?? null,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        provider: provider.key,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          companyId: ctx.companyId,
          userId: ctx.userId,
          deviceId: input.deviceId ?? null,
          p256dh: input.p256dh,
          auth: input.auth,
          provider: provider.key,
          // A resubscribe clears the failure history: whatever was wrong
          // before, this endpoint is alive now.
          failureCount: 0,
          lastFailureAt: null,
          disabledAt: null,
        },
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'push.subscribe',
        entityType: 'push_subscription',
        entityId: subscription.id,
        // Never the endpoint or the keys: they are a delivery credential, and
        // the audit log is read by more people than can send pushes.
        after: { provider: provider.key, deviceId: input.deviceId ?? null },
      },
      tx,
    )

    return subscription
  })
}

export async function unsubscribe(ctx: ActorContext, endpoint: string): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.userId, ctx.userId),
        ),
      )
      .returning({ id: pushSubscriptions.id })

    if (removed.length === 0) return

    await recordAudit(
      ctx,
      { action: 'push.unsubscribe', entityType: 'push_subscription', entityId: removed[0].id },
      tx,
    )
  })
}

// --- Preferences -----------------------------------------------------------

export type TopicPreference = {
  topic: NotificationTopic
  label: string
  description: string
  enabled: boolean
}

export async function preferences(ctx: ActorContext): Promise<TopicPreference[]> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.companyId, ctx.companyId),
        eq(notificationPreferences.userId, ctx.userId),
      ),
    )

  const off = new Map(rows.map((row) => [row.topic, row.enabled]))

  return notificationTopicEnum.enumValues.map((topic) => ({
    topic,
    label: TOPIC_LABELS[topic],
    description: TOPIC_DESCRIPTIONS[topic],
    enabled: off.get(topic) ?? true,
  }))
}

export async function setPreference(
  ctx: ActorContext,
  topic: NotificationTopic,
  enabled: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(notificationPreferences)
      .values({ companyId: ctx.companyId, userId: ctx.userId, topic, enabled })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.companyId,
          notificationPreferences.topic,
        ],
        set: { enabled, updatedAt: new Date() },
      })

    await recordAudit(
      ctx,
      {
        action: 'notification.preference',
        entityType: 'notification_preference',
        after: { topic, enabled },
      },
      tx,
    )
  })
}

async function topicEnabled(
  companyId: string,
  userId: string,
  topic: NotificationTopic,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.companyId, companyId),
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.topic, topic),
      ),
    )
    .limit(1)

  return row?.enabled ?? true
}

// --- Sending ---------------------------------------------------------------

/** Consecutive failures after which a subscription is left alone. */
export const MAX_PUSH_FAILURES = 5

export type NotifyResult = {
  sent: number
  suppressed: boolean
  failed: number
}

/**
 * Sends one notification to one person's devices.
 *
 * Every path writes a log row, including the suppressed one and the one where
 * there was nothing to send to. "Why did I not get told" is a support question
 * that deserves an answer rather than a shrug — the same argument the AI usage
 * ledger makes for recording blocked calls.
 */
export async function notify(
  input: {
    companyId: string
    userId: string
    topic: NotificationTopic
    message: PushMessage
  },
): Promise<NotifyResult> {
  const provider = getPushProvider()

  if (!(await topicEnabled(input.companyId, input.userId, input.topic))) {
    await log(input, { outcome: 'suppressed', detail: 'Topic switched off.', provider: provider.key })
    return { sent: 0, suppressed: true, failed: 0 }
  }

  const targets = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.companyId, input.companyId),
        eq(pushSubscriptions.userId, input.userId),
        isNull(pushSubscriptions.disabledAt),
      ),
    )

  if (targets.length === 0) {
    await log(input, { outcome: 'no_subscription', provider: provider.key })
    return { sent: 0, suppressed: false, failed: 0 }
  }

  let sent = 0
  let failed = 0

  for (const target of targets) {
    const result = await provider.send(
      { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
      input.message,
    )

    if (result.ok) {
      sent++
      if (target.failureCount > 0) {
        await db
          .update(pushSubscriptions)
          .set({ failureCount: 0, lastFailureAt: null })
          .where(eq(pushSubscriptions.id, target.id))
      }
      await log(input, {
        outcome: 'sent',
        provider: provider.key,
        subscriptionId: target.id,
      })
      continue
    }

    failed++

    if (result.gone) {
      // The subscription is dead at the push service. Deleting is right —
      // there is nothing to recover and nothing to retry.
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, target.id))
    } else {
      const failureCount = target.failureCount + 1
      await db
        .update(pushSubscriptions)
        .set({
          failureCount,
          lastFailureAt: new Date(),
          // Disabled rather than deleted: a push service having a bad week is
          // not the same as a subscription that no longer exists, and the row
          // is what a person needs to see to re-enable notifications.
          disabledAt: failureCount >= MAX_PUSH_FAILURES ? new Date() : null,
        })
        .where(eq(pushSubscriptions.id, target.id))
    }

    await log(input, {
      outcome: 'failed',
      detail: result.error,
      provider: provider.key,
      subscriptionId: target.id,
    })
  }

  return { sent, suppressed: false, failed }
}

async function log(
  input: { companyId: string; userId: string; topic: NotificationTopic; message: PushMessage },
  outcome: {
    outcome: string
    detail?: string
    provider: string
    subscriptionId?: string
  },
): Promise<void> {
  try {
    await db.insert(notificationLog).values({
      companyId: input.companyId,
      userId: input.userId,
      subscriptionId: outcome.subscriptionId ?? null,
      topic: input.topic,
      title: input.message.title,
      body: input.message.body,
      url: input.message.url ?? null,
      outcome: outcome.outcome,
      detail: outcome.detail?.slice(0, 500) ?? null,
      provider: outcome.provider,
    })
  } catch {
    // Losing a log row is a smaller failure than losing the notification.
    // Same call as `meter()` in the AI gateway.
  }
}

/** The notification history, for the settings page. */
export async function recentNotifications(ctx: ActorContext, limit = 25) {
  requirePermission(ctx, 'bookkeeping:view')

  return db
    .select()
    .from(notificationLog)
    .where(and(scoped(ctx, notificationLog), eq(notificationLog.userId, ctx.userId)))
    .orderBy(desc(notificationLog.createdAt))
    .limit(limit)
}

// --- The events that actually fire ----------------------------------------

/**
 * Nudges somebody whose inbox has piled up.
 *
 * Threshold rather than per-transaction, because "you have one transaction to
 * review" is the notification that gets the app muted. The tag collapses
 * repeats, so a phone shows the current count rather than a stack.
 */
export async function nudgeReviewQueue(
  input: { companyId: string; userId: string; waiting: number },
): Promise<NotifyResult> {
  if (input.waiting < REVIEW_NUDGE_THRESHOLD) {
    return { sent: 0, suppressed: true, failed: 0 }
  }

  return notify({
    companyId: input.companyId,
    userId: input.userId,
    topic: 'transactions_to_review',
    message: {
      title: `${input.waiting} transactions to review`,
      body: 'A couple of minutes now beats an afternoon at month end.',
      url: '/m',
      tag: 'transactions_to_review',
    },
  })
}

export async function notifyProposalDecided(
  input: {
    companyId: string
    userId: string
    proposalNumber: string
    clientName: string
    won: boolean
  },
): Promise<NotifyResult> {
  return notify({
    companyId: input.companyId,
    userId: input.userId,
    topic: 'proposal_decided',
    message: {
      title: input.won ? `${input.clientName} accepted your proposal` : 'A proposal was declined',
      body: `Proposal ${input.proposalNumber} — ${input.clientName}.`,
      url: '/crm',
      tag: `proposal:${input.proposalNumber}`,
    },
  })
}

export async function notifyInvoicePaid(
  input: {
    companyId: string
    userId: string
    invoiceNumber: string
    customerName: string
    amount: string
  },
): Promise<NotifyResult> {
  return notify({
    companyId: input.companyId,
    userId: input.userId,
    topic: 'invoice_paid',
    message: {
      title: `${input.customerName} paid ${input.amount}`,
      body: `Invoice ${input.invoiceNumber}.`,
      url: '/accounting',
      tag: `invoice:${input.invoiceNumber}`,
    },
  })
}

export async function notifyComplianceExpiring(
  input: { companyId: string; userId: string; vendorName: string; expiresOn: string },
): Promise<NotifyResult> {
  return notify({
    companyId: input.companyId,
    userId: input.userId,
    topic: 'compliance_expiring',
    message: {
      title: `${input.vendorName}'s insurance expires ${input.expiresOn}`,
      body: 'Collect the renewal before the next payment.',
      url: '/jobs/subcontractors',
      tag: `compliance:${input.vendorName}`,
    },
  })
}
