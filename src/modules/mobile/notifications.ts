import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  notificationLog,
  notificationPreferences,
  notificationTopicEnum,
  pushSubscriptions,
  transactionalMessages,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { getPushProvider, type PushMessage } from './push-provider'
import {
  assertTopicBelongs,
  columnsFor,
  topicsFor,
  type Audience,
} from './audience'
import { decisionFor, type DecisionInput, type Outcome } from './decision'
import { Refusal } from '@/modules/errors'

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
  books_disagree: 'The books stopped agreeing with themselves',
  practice_brief: 'A client of your firm needs a look',
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
  books_disagree:
    'When a nightly reconciliation stops holding — the stock against the balance sheet, the deposits against what is owed to tenants, the invoices against the control account. Sent the night a difference appears, and not again while it is still there.',
  practice_brief:
    'One letter a day to everybody at your firm, naming the clients that got worse since the last one. Nothing arrives on a morning when nothing changed.',
}

/** How many transactions have to be waiting before a nudge is worth sending. */
export const REVIEW_NUDGE_THRESHOLD = 5

// --- Subscriptions ---------------------------------------------------------

export async function subscribe(
  ctx: ActorContext,
  input: { endpoint: string; p256dh: string; auth: string; deviceId?: string | null },
) {
  if (!input.endpoint.startsWith('https://')) {
    throw new Refusal('A push endpoint must be an https URL.')
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

/**
 * The switches one person can see for one audience (Phase 89).
 *
 * Only the topics that *belong* to this audience. A company screen listing the
 * firm's brief would offer a switch that nothing reads, and a person who set it
 * would believe they were covered — which is worse than having no switch at
 * all, and is why `TOPIC_AUDIENCE` exists.
 */
export async function preferencesFor(
  audience: Audience,
  userId: string,
): Promise<TopicPreference[]> {
  const owner =
    audience.kind === 'company'
      ? and(
          eq(notificationPreferences.companyId, audience.companyId),
          isNull(notificationPreferences.practiceId),
        )
      : and(
          eq(notificationPreferences.practiceId, audience.practiceId),
          isNull(notificationPreferences.companyId),
        )

  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(and(owner, eq(notificationPreferences.userId, userId)))

  const off = new Map(rows.map((row) => [row.topic, row.enabled]))

  return topicsFor(audience.kind, notificationTopicEnum.enumValues).map((topic) => ({
    topic,
    label: TOPIC_LABELS[topic],
    description: TOPIC_DESCRIPTIONS[topic],
    enabled: off.get(topic) ?? true,
  }))
}

/** The company screen's switches, for the company the actor is in. */
export async function preferences(ctx: ActorContext): Promise<TopicPreference[]> {
  return preferencesFor({ kind: 'company', companyId: ctx.companyId }, ctx.userId)
}

/**
 * Switch one topic on or off for one audience (Phase 89).
 *
 * `assertTopicBelongs` first: a company topic stored against a practice is a
 * row nothing ever reads, and the person who set it believes they are covered.
 *
 * The conflict target names all four columns because the unique index does, and
 * that index is `NULLS NOT DISTINCT` — without which two rows with the same null
 * owner are distinct to Postgres and this upsert silently becomes an insert.
 */
export async function setPreferenceFor(
  audience: Audience,
  userId: string,
  topic: NotificationTopic,
  enabled: boolean,
): Promise<void> {
  assertTopicBelongs(topic, audience)

  await db
    .insert(notificationPreferences)
    .values({ ...columnsFor(audience), userId, topic, enabled })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.userId,
        notificationPreferences.companyId,
        notificationPreferences.practiceId,
        notificationPreferences.topic,
      ],
      set: { enabled, updatedAt: new Date() },
    })
}

export async function setPreference(
  ctx: ActorContext,
  topic: NotificationTopic,
  enabled: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    assertTopicBelongs(topic, { kind: 'company', companyId: ctx.companyId })

    await tx
      .insert(notificationPreferences)
      .values({ companyId: ctx.companyId, userId: ctx.userId, topic, enabled })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.userId,
          notificationPreferences.companyId,
          notificationPreferences.practiceId,
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

/**
 * Whether this person still wants this topic, for this audience.
 *
 * Takes an `Audience` rather than a company id since Phase 89: a preference
 * belongs to a company *or* to a practice, and the firm's brief belongs to the
 * second. `eq` cannot match a null, so the owner that is null is matched with
 * `isNull` — a `where` built from `eq(column, null)` silently matches nothing
 * and would have made every practice preference look unset.
 */
export async function topicEnabled(
  audience: Audience,
  userId: string,
  topic: NotificationTopic,
): Promise<boolean> {
  const owner =
    audience.kind === 'company'
      ? and(
          eq(notificationPreferences.companyId, audience.companyId),
          isNull(notificationPreferences.practiceId),
        )
      : and(
          eq(notificationPreferences.practiceId, audience.practiceId),
          isNull(notificationPreferences.companyId),
        )

  const [row] = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(owner, eq(notificationPreferences.userId, userId), eq(notificationPreferences.topic, topic)))
    .limit(1)

  // Absent means on, which is Phase 8's rule and unchanged: somebody who
  // installed the app has already opted in once.
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

  if (
    !(await topicEnabled(
      { kind: 'company', companyId: input.companyId },
      input.userId,
      input.topic,
    ))
  ) {
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
    outcome: Outcome
    detail?: string
    provider: string
    subscriptionId?: string
  },
): Promise<void> {
  await record({
    audience: { kind: 'company', companyId: input.companyId },
    userId: input.userId,
    topic: input.topic,
    channel: 'push',
    outcome: outcome.outcome,
    title: input.message.title,
    body: input.message.body,
    url: input.message.url ?? null,
    detail: outcome.detail ?? null,
    subscriptionId: outcome.subscriptionId ?? null,
    provider: outcome.provider,
  })
}

/**
 * Files one decision (Phase 90).
 *
 * The only writer of `notification_log`, and it takes an `Audience` rather than
 * a company so the firm's brief can reach it at all — which was the whole hole
 * Phase 88 opened and this phase closes.
 *
 * Swallows its own failure, deliberately and unchanged from Phase 8: losing a
 * log row is a smaller failure than losing the notification it describes. Same
 * call as `meter()` in the AI gateway. The shape checks in `decisionFor` run
 * *inside* the try for that reason — a programming error in a caller must not
 * take down the send it was only trying to describe.
 */
export async function record(input: DecisionInput): Promise<void> {
  try {
    await db.insert(notificationLog).values(decisionFor(input))
  } catch {
    // See above.
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

/**
 * One person's history for one firm (Phase 90).
 *
 * Not `scoped()`, which resolves a company and would find nothing here: these
 * rows have a null company by construction. Scoped instead by the two things
 * that matter — the firm the rows belong to, and the person reading them.
 *
 * The caller is responsible for proving membership of the firm before calling;
 * `setBriefPreferenceAction` already does it through `practicesFor`, and the
 * server component that renders this reads the same list.
 */
export async function practiceNotifications(
  practiceId: string,
  userId: string,
  limit = 10,
) {
  return db
    .select({
      id: notificationLog.id,
      companyId: notificationLog.companyId,
      practiceId: notificationLog.practiceId,
      topic: notificationLog.topic,
      channel: notificationLog.channel,
      title: notificationLog.title,
      /** Null for mail by design — see `mobile/decision`. */
      body: notificationLog.body,
      outcome: notificationLog.outcome,
      detail: notificationLog.detail,
      messageId: notificationLog.messageId,
      createdAt: notificationLog.createdAt,
      // Phase 91. The decision names the letter; the letter keeps the words.
      // A left join because a suppression never had one, and because retention
      // sweeps letters at a year while the decision outlives them — both are
      // rows that should still read as "we told you", with nothing to open.
      letter: transactionalMessages.body,
    })
    .from(notificationLog)
    .leftJoin(
      transactionalMessages,
      eq(transactionalMessages.id, notificationLog.messageId),
    )
    .where(
      and(
        eq(notificationLog.practiceId, practiceId),
        isNull(notificationLog.companyId),
        eq(notificationLog.userId, userId),
      ),
    )
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
