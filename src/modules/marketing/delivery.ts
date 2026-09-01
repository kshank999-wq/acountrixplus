import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { campaignEvents, campaignRecipients } from '@/db/schema'
import { suppressEmail } from './audience'
import { advanceStatus, outcomeFor, type DeliveryEvent, type RecipientStatus } from './delivery-events'

/**
 * Reconciling a provider's delivery callback (Phase 83).
 *
 * The fifth entry point that carries no session, and the only one not reached
 * from a link in an email — this one is reached by the email provider itself,
 * hours after the send, to say what happened to a message it accepted.
 *
 * Everything it can do is bounded the same way the other four are: it names one
 * recipient by an id only the provider was given, and the worst it can do is
 * mark that recipient's message undeliverable and stop sending to that address.
 * It cannot read a contact, reach another tenant, or send anything.
 */

/** One event, as a provider reported it. */
export type DeliveryCallback = {
  /** What `SendResult` returned and `campaign_recipients` stored. */
  providerMessageId?: string | null
  /**
   * The recipient id, when the provider echoes the tags it was sent.
   *
   * A fallback rather than the key: `tags` is documented as correlating a
   * callback back to a recipient row and until Phase 83 nothing read it, but
   * not every provider returns tags on every event kind — the message id always
   * comes back.
   */
  recipientId?: string | null
  event: DeliveryEvent
}

export type DeliveryResult =
  | { ok: true; recipientId: string; status: RecipientStatus | 'unchanged'; suppressed: boolean }
  | { ok: false; reason: 'unknown_message' }

async function recipientFor(callback: DeliveryCallback) {
  if (callback.providerMessageId) {
    const [row] = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.providerMessageId, callback.providerMessageId))
      .limit(1)

    if (row) return row
  }

  if (callback.recipientId) {
    const [row] = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.id, callback.recipientId))
      .limit(1)

    if (row) return row
  }

  return null
}

/**
 * Records what a provider said about one message.
 *
 * An unknown message is not an error to shout about: providers retry, and a
 * callback for a recipient row that retention has already swept is expected
 * rather than suspicious. It returns quietly and the route answers 200, because
 * a provider that gets an error back disables the webhook.
 */
export async function recordDeliveryEvent(
  callback: DeliveryCallback,
): Promise<DeliveryResult> {
  const recipient = await recipientFor(callback)
  if (!recipient) return { ok: false, reason: 'unknown_message' }

  const outcome = outcomeFor(callback.event)

  await db.insert(campaignEvents).values({
    companyId: recipient.companyId,
    recipientId: recipient.id,
    kind: outcome.event,
  })

  // A late `delivered` must not rewind a recipient who has already clicked,
  // and nothing here moves one off a bounce.
  const next = advanceStatus(recipient.status as RecipientStatus, outcome.status)
  if (next) {
    await db
      .update(campaignRecipients)
      .set({ status: next })
      .where(eq(campaignRecipients.id, recipient.id))
  }

  if (outcome.suppress) {
    await suppressEmail(recipient.companyId, recipient.email, {
      reason: outcome.suppress,
      campaignId: recipient.campaignId,
      notes:
        outcome.suppress === 'bounce'
          ? 'Hard bounce reported by the email provider.'
          : 'Marked as spam by the recipient.',
    })
  }

  return {
    ok: true,
    recipientId: recipient.id,
    status: next ?? 'unchanged',
    suppressed: outcome.suppress !== null,
  }
}
