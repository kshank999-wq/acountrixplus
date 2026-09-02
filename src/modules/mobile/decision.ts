import { assertTopicBelongs, columnsFor, type Audience } from './audience'
import type { NotificationTopic } from './notifications'

/**
 * What a notification log row may say (Phase 90).
 *
 * ## The decision nobody recorded
 *
 * ADR 0008 built `notification_log` because *"why did I not get told about
 * that" is a question a support conversation starts with, and it needs an
 * answer that is not a guess.* Every path through `notify` writes a row —
 * including the suppressed one and the one where there was nothing to send to.
 * That is the point: silence is a decision, and an unrecorded decision is
 * indistinguishable from a bug.
 *
 * **Phase 88 broke the promise and Phase 89 widened the hole.** The firm's
 * morning brief is a notification by every meaning except the transport it
 * uses, and it does not go through `notify` — it goes through Phase 19's mail
 * channel. So a *sent* brief is recorded in `transactional_messages` and a
 * *suppressed* one is recorded nowhere at all: Phase 89's handler increments a
 * counter and moves on. A person who switched the brief off in March and forgot
 * has no way, in July, to find out that they did.
 *
 * ## The judgement: two tables, one boundary, written down
 *
 * The tempting fix is to merge the two logs. It is wrong: they answer different
 * questions. `transactional_messages` records a **transmission** — this address,
 * this provider, this provider id, did the SMTP hop succeed. `notification_log`
 * records a **decision** — this person, this topic, we chose to tell them or
 * chose not to, and here is why.
 *
 * A suppression has no transmission, which is exactly why it fits in one table
 * and not the other. So the boundary stays, and this module makes it explicit
 * rather than accidental.
 *
 * ## The body is stored only when nothing else stores it
 *
 * A push notification's text exists nowhere but the log row, so the row keeps
 * it. A mail-backed notification's text is already in `transactional_messages`,
 * rendered, with the address it went to — and a second copy in a second table is
 * the two-answers-to-one-question defect this project keeps finding. An edit to
 * the brief's wording would fix one copy and leave the other lying.
 *
 * So `body` is null for mail, and `channel` is stored beside it so that a reader
 * can tell *why* it is null rather than guessing that there was nothing to say.
 *
 * Nothing here touches the database or the clock.
 */

/** How the notification was carried. */
export type Channel = 'push' | 'mail'

/**
 * What was decided.
 *
 * The four Phase 8 introduced, named rather than left as a bare string. Three
 * of them are ways nothing arrived, and telling them apart is the entire value
 * of the table: "you switched it off", "your phone is not subscribed" and "the
 * provider refused it" are three different conversations.
 */
export type Outcome = 'sent' | 'suppressed' | 'failed' | 'no_subscription'

export const OUTCOMES: readonly Outcome[] = [
  'sent',
  'suppressed',
  'failed',
  'no_subscription',
] as const

/** How much of a provider's complaint is worth keeping. */
export const DETAIL_LIMIT = 500

/** The reason a message was suppressed, in the words a person would use. */
export const SWITCHED_OFF = 'You switched this off.'

export type DecisionInput = {
  audience: Audience
  userId: string
  topic: NotificationTopic
  channel: Channel
  outcome: Outcome
  title: string
  /** The message text. Kept for push, discarded for mail — see above. */
  body?: string | null
  url?: string | null
  detail?: string | null
  subscriptionId?: string | null
  provider: string
}

/** Exactly the columns a `notification_log` row carries. */
export type Decision = {
  companyId: string | null
  practiceId: string | null
  userId: string
  topic: NotificationTopic
  channel: Channel
  outcome: Outcome
  title: string
  body: string | null
  url: string | null
  detail: string | null
  subscriptionId: string | null
  provider: string
}

/**
 * Builds the row, refusing the shapes that would make the log lie.
 *
 * Three refusals, each for a row that would be worse than no row:
 *
 * - a topic against the wrong kind of audience, which is `assertTopicBelongs`'
 *   rule from Phase 89 applied to the record as well as the preference: a
 *   company topic filed against a practice is a row no query will ever find;
 * - `no_subscription` on the mail channel, which cannot happen and would mean
 *   something else went wrong. A letter is addressed by construction — the
 *   recipient's address comes from the roster — so "nowhere to send it" is a
 *   push-shaped answer and using it for mail would hide the real reason;
 * - an empty title, because the title is the only thing a person scanning their
 *   history reads, and a blank one makes the row unreadable exactly when they
 *   are trying to read it.
 */
export function decisionFor(input: DecisionInput): Decision {
  assertTopicBelongs(input.topic, input.audience)

  if (input.outcome === 'no_subscription' && input.channel === 'mail') {
    throw new Error(
      'A letter is addressed by construction; "no_subscription" is a push outcome.',
    )
  }

  const title = input.title.trim()
  if (title.length === 0) {
    throw new Error('A notification log row needs a title to be readable.')
  }

  return {
    ...columnsFor(input.audience),
    userId: input.userId,
    topic: input.topic,
    channel: input.channel,
    outcome: input.outcome,
    title,
    body: bodyFor(input.channel, input.body ?? null),
    url: input.url ?? null,
    detail: truncateDetail(input.detail ?? null),
    subscriptionId: input.subscriptionId ?? null,
    provider: input.provider,
  }
}

/**
 * The stored body, which is the message text only when nothing else stores it.
 *
 * Deliberately not "store it anyway, it is cheap". Cheap duplication is how a
 * codebase ends up with two answers to one question, and this project has spent
 * enough phases finding those to know what they cost.
 */
export function bodyFor(channel: Channel, body: string | null): string | null {
  return channel === 'mail' ? null : body
}

/** A provider's complaint, bounded. A stack trace is not a support answer. */
export function truncateDetail(detail: string | null): string | null {
  if (detail === null) return null
  const trimmed = detail.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, DETAIL_LIMIT)
}

/** Whether this row is a message that did not arrive. */
export function isSilence(outcome: Outcome): boolean {
  return outcome !== 'sent'
}

/**
 * The sentence that answers "why did I not get told about that".
 *
 * The whole table exists for this question, so the answer belongs in the core
 * where it can be tested, rather than in a template where each screen invents
 * its own wording and two of them eventually disagree.
 *
 * A stored `detail` wins over the generic sentence when there is one, because a
 * provider that said something specific said it for a reason.
 */
export function explain(row: {
  channel: Channel
  outcome: Outcome
  detail: string | null
}): string {
  const where = row.channel === 'mail' ? 'your inbox' : 'your phone'

  switch (row.outcome) {
    case 'sent':
      return `Sent to ${where}.`
    case 'suppressed':
      return row.detail ?? SWITCHED_OFF
    case 'no_subscription':
      return 'Nowhere to send it — no device is subscribed to notifications.'
    case 'failed':
      return row.detail
        ? `It did not arrive: ${row.detail}`
        : 'It did not arrive, and the provider gave no reason.'
  }
}
