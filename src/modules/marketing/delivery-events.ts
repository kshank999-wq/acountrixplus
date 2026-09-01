/**
 * What a provider's delivery callback means (Phase 83).
 *
 * ## The bounce that was a failed API call
 *
 * `sendStep` had two outcomes: the provider accepted the message, or it did
 * not. The second set the recipient to **`bounced`** and put the provider's
 * error into `skipReason` — a column whose own doc says *"Why a recipient was
 * skipped: no_consent, suppressed, no_email"*.
 *
 * Neither half is right. A provider refusing an API call — bad credentials, a
 * rate limit, a malformed address — is a **send failure**. A bounce is the
 * receiving mail server rejecting the message *after* the provider accepted
 * it, hours later, down a channel this application had no way to hear.
 *
 * The difference decides what to do about it. A send failure is ours and
 * usually transient: retry it, fix the key, do not touch the address. A hard
 * bounce means the mailbox does not exist, and mailing it again on the next
 * campaign is the single fastest way to wreck a sending domain's reputation.
 * Phase 82 got the headers right to reach the inbox; this is what keeps a
 * sender there.
 *
 * ## Five places already expected this
 *
 * The schema was built for it in Phase 5 and the behaviour never arrived:
 *
 *  - `campaign_recipients.provider_message_id` — *"Provider's own id, for
 *    reconciling delivery webhooks later."* Nothing reconciled.
 *  - `recipient_status` has `delivered` and `complained`. Nothing could reach
 *    either.
 *  - `campaign_events.kind` names `"bounce"` and `"complaint"`.
 *  - `suppressions.reason` names `"bounce"` and `"complaint"`. Only
 *    `"unsubscribe"` was ever written.
 *  - `campaignStats` reports a bounce rate.
 *
 * Nothing here touches the database or the clock.
 */

/** What a provider tells us happened, once it has stopped being our problem. */
export type DeliveryKind = 'delivered' | 'bounced' | 'complained'

/**
 * Why a message bounced.
 *
 * **Hard**: the mailbox does not exist, or the domain does not. Permanent, and
 * the address must not be mailed again.
 *
 * **Soft**: full mailbox, greylisting, a server having a bad afternoon.
 * Temporary. Suppressing on one of these silences a real customer because
 * their inbox was full for a day, which is a worse outcome than one wasted
 * send — so it records the event and leaves the address alone.
 */
export type BounceKind = 'hard' | 'soft'

export type DeliveryEvent = {
  kind: DeliveryKind
  /** Present on a bounce; a provider that does not say is treated as soft. */
  bounce?: BounceKind
}

/** The statuses a delivery callback can put a recipient into. */
export type RecipientStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'unsubscribed'
  | 'skipped'
  | 'failed'

export type DeliveryOutcome = {
  /** The status this event implies, before ordering is considered. */
  status: RecipientStatus
  /** The `campaign_events.kind` to append. */
  event: 'delivered' | 'bounce' | 'complaint'
  /** The `suppressions.reason` to write, or null to leave the address alone. */
  suppress: 'bounce' | 'complaint' | null
}

/** What one callback means for the recipient it names. */
export function outcomeFor(event: DeliveryEvent): DeliveryOutcome {
  if (event.kind === 'complained') {
    // Somebody pressed "this is spam". There is no version of continuing to
    // mail them that is defensible, and mailbox providers count it.
    return { status: 'complained', event: 'complaint', suppress: 'complaint' }
  }

  if (event.kind === 'bounced') {
    return {
      status: 'bounced',
      event: 'bounce',
      suppress: event.bounce === 'hard' ? 'bounce' : null,
    }
  }

  return { status: 'delivered', event: 'delivered', suppress: null }
}

/**
 * How far through the engagement story a status is.
 *
 * Webhooks arrive out of order — a `delivered` callback can land after the
 * reader has already clicked, because one hop was slow. Ranking them stops a
 * late arrival rewinding what is already known, which is the rule `recordOpen`
 * has always followed for opens against clicks and which is now written down
 * rather than repeated.
 */
const ENGAGEMENT_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
}

/**
 * Statuses that are facts about the address rather than steps in a story.
 *
 * They win regardless of rank. A complaint after a click is not a regression —
 * it is somebody who read the message and objected to it, and that is the more
 * important thing to know. `unsubscribed` and `skipped` are equally terminal
 * and are never set from here.
 */
const TERMINAL = new Set<RecipientStatus>([
  'bounced',
  'complained',
  'unsubscribed',
  'skipped',
  'failed',
])

/**
 * The status to store, given what is already there.
 *
 * Returns `null` when the event tells us nothing new, so a caller can skip the
 * write rather than churn a row on every duplicate a provider retries.
 */
export function advanceStatus(
  current: RecipientStatus,
  next: RecipientStatus,
): RecipientStatus | null {
  if (current === next) return null

  // Nothing a delivery callback says moves a recipient off a terminal fact.
  // A `delivered` arriving after a bounce is the provider's own race.
  if (TERMINAL.has(current)) return null

  if (TERMINAL.has(next)) return next

  const from = ENGAGEMENT_RANK[current] ?? 0
  const to = ENGAGEMENT_RANK[next] ?? 0

  return to > from ? next : null
}
