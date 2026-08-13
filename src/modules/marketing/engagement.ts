import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  campaignEvents,
  campaignRecipients,
  campaigns,
  contacts,
  opportunities,
  organizations,
  tasks,
} from '@/db/schema'
import { safeUrl } from '@/modules/design/urls'
import { suppressEmail } from './audience'

/**
 * Engagement tracking and unsubscribe (spec §10).
 *
 * All three entry points here are unauthenticated — they are reached from a
 * link in an email, days later, from a device with no session. Each is
 * identified only by the per-recipient token, which is unguessable and scoped
 * to exactly one recipient of one campaign step.
 *
 * None of them can read anything: an open records a timestamp, a click records
 * a destination, an unsubscribe suppresses one address. A leaked token cannot
 * be used to enumerate contacts or reach another tenant.
 */

export type TrackMeta = { ipPrefix?: string | null; userAgent?: string | null }

async function recipientByToken(token: string) {
  const [recipient] = await db
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.unsubscribeToken, token))
    .limit(1)

  return recipient ?? null
}

/**
 * Records an email open.
 *
 * Fired by the tracking pixel, so it must never throw and never reveal
 * anything: an unknown token returns quietly and the caller still serves a
 * transparent image.
 */
export async function recordOpen(token: string, meta: TrackMeta = {}): Promise<void> {
  const recipient = await recipientByToken(token)
  if (!recipient) return

  await db.transaction(async (tx) => {
    await tx.insert(campaignEvents).values({
      companyId: recipient.companyId,
      recipientId: recipient.id,
      kind: 'open',
      ipPrefix: meta.ipPrefix ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })

    // Only advance the status; a click already recorded outranks an open.
    if (recipient.status === 'sent' || recipient.status === 'delivered') {
      await tx
        .update(campaignRecipients)
        .set({ status: 'opened', openedAt: recipient.openedAt ?? new Date() })
        .where(eq(campaignRecipients.id, recipient.id))
    } else if (!recipient.openedAt) {
      await tx
        .update(campaignRecipients)
        .set({ openedAt: new Date() })
        .where(eq(campaignRecipients.id, recipient.id))
    }
  })
}

export type ClickResult = { ok: true; destination: string } | { ok: false }

/**
 * Records a click and returns where to send the reader.
 *
 * The destination is re-validated through `safeUrl` even though it came from
 * the query string — an attacker who forges a tracking link must not be able
 * to turn it into an open redirect to a phishing page.
 */
export async function recordClick(
  token: string,
  rawUrl: string,
  meta: TrackMeta = {},
): Promise<ClickResult> {
  const destination = safeUrl(rawUrl)
  if (destination === '#') return { ok: false }

  const recipient = await recipientByToken(token)
  if (!recipient) return { ok: false }

  await db.transaction(async (tx) => {
    await tx.insert(campaignEvents).values({
      companyId: recipient.companyId,
      recipientId: recipient.id,
      kind: 'click',
      url: destination.slice(0, 2_000),
      ipPrefix: meta.ipPrefix ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })

    await tx
      .update(campaignRecipients)
      .set({
        status: 'clicked',
        clickedAt: recipient.clickedAt ?? new Date(),
        openedAt: recipient.openedAt ?? new Date(),
      })
      .where(eq(campaignRecipients.id, recipient.id))
  })

  // Spec §10: engagement feeds back into the pipeline.
  await createFollowUpTask(recipient)

  return { ok: true, destination }
}

/**
 * A click on a nurture email is a buying signal, so it raises a task for
 * whoever owns the relationship (spec §10 marketing-to-sales loop).
 *
 * A task, not an automatic reopen: reopening a lost deal is a judgement a
 * salesperson makes, and doing it silently would corrupt the win/loss figures
 * spec §9 reports.
 */
async function createFollowUpTask(
  recipient: typeof campaignRecipients.$inferSelect,
): Promise<void> {
  if (!recipient.organizationId) return

  const [existing] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, recipient.companyId),
        eq(tasks.campaignId, recipient.campaignId),
        eq(tasks.organizationId, recipient.organizationId),
        eq(tasks.status, 'open'),
      ),
    )
    .limit(1)

  // One open task per organization per campaign, however many links they click.
  if (existing) return

  const [organization] = await db
    .select({ name: organizations.name, ownerId: organizations.ownerId })
    .from(organizations)
    .where(eq(organizations.id, recipient.organizationId))
    .limit(1)

  const [campaign] = await db
    .select({ name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.id, recipient.campaignId))
    .limit(1)

  await db.insert(tasks).values({
    companyId: recipient.companyId,
    title: `Follow up: ${organization?.name ?? 'a contact'} engaged with "${campaign?.name ?? 'a campaign'}"`,
    detail: `${recipient.email} clicked a link. Worth a call while it is warm.`,
    organizationId: recipient.organizationId,
    contactId: recipient.contactId,
    campaignId: recipient.campaignId,
    assignedTo: organization?.ownerId ?? null,
    dueOn: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
  })
}

export type UnsubscribeResult =
  | { ok: true; email: string; alreadyUnsubscribed: boolean }
  | { ok: false }

/**
 * Unsubscribes the holder of a token (spec §10, §19).
 *
 * Idempotent, because mail clients pre-fetch links and a person may click
 * twice. Suppression is company-wide and keyed by address, so it survives the
 * contact record being recreated by a later lead-intake submission.
 */
export async function unsubscribeByToken(token: string): Promise<UnsubscribeResult> {
  const recipient = await recipientByToken(token)
  if (!recipient) return { ok: false }

  const alreadyUnsubscribed = recipient.unsubscribedAt !== null

  if (!alreadyUnsubscribed) {
    await db.transaction(async (tx) => {
      await tx
        .update(campaignRecipients)
        .set({ status: 'unsubscribed', unsubscribedAt: new Date() })
        .where(eq(campaignRecipients.id, recipient.id))

      await tx.insert(campaignEvents).values({
        companyId: recipient.companyId,
        recipientId: recipient.id,
        kind: 'unsubscribe',
      })
    })

    await suppressEmail(recipient.companyId, recipient.email, {
      reason: 'unsubscribe',
      campaignId: recipient.campaignId,
    })
  }

  return { ok: true, email: recipient.email, alreadyUnsubscribed }
}

/** The company name to show on the unsubscribe confirmation page. */
export async function unsubscribeContext(token: string) {
  const recipient = await recipientByToken(token)
  if (!recipient) return null

  const [contact] = recipient.contactId
    ? await db
        .select({ firstName: contacts.firstName })
        .from(contacts)
        .where(eq(contacts.id, recipient.contactId))
        .limit(1)
    : []

  return { email: recipient.email, firstName: contact?.firstName ?? null }
}

/**
 * Reopens a lost opportunity from a marketing signal (spec §10).
 *
 * An explicit action a salesperson takes, not something engagement does on its
 * own — see `createFollowUpTask`.
 */
export async function opportunitiesForOrganization(companyId: string, organizationId: string) {
  return db
    .select({
      id: opportunities.id,
      title: opportunities.title,
      stage: opportunities.stage,
      lossReason: opportunities.lossReason,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.companyId, companyId),
        eq(opportunities.organizationId, organizationId),
      ),
    )
}
