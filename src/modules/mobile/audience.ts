import type { NotificationTopic } from './notifications'

/**
 * Who a notification preference belongs to (Phase 89).
 *
 * ## The preference that assumed a company
 *
 * Phase 8 gave every notification topic a per-person on/off switch, for a
 * reason worth restating: *a channel nobody can quiet is a channel that gets
 * filtered to a folder, and then the one message that mattered is filtered with
 * it.* The switch is real, reachable at `/m/settings`, and honoured by `notify`
 * before anything reaches a provider.
 *
 * It is keyed on `(user, company, topic)`, and `company_id` is `NOT NULL`.
 * Every function that reads or writes it takes an `ActorContext`, which names
 * exactly one company. That premise held for eight phases and eighty topics'
 * worth of messages, because every notification this application sent belonged
 * to a company.
 *
 * **Phase 88 made it false.** The firm's morning brief belongs to a *practice*,
 * which is a third kind of owner — not a company, and not housekeeping. So the
 * one channel that arrives unannounced in somebody's inbox is the one channel
 * with no switch, and the preference machinery cannot be pointed at it: there
 * is nowhere to put the row.
 *
 * ## The judgement: a preference belongs to an audience
 *
 * Not to a company that might be null. A nullable `company_id` alone would mean
 * "no company" is a missing value, and two rows with a null company would be
 * distinct as far as a Postgres unique constraint is concerned — the exact trap
 * `installGlobalSchedules` documents for schedules, where it is survivable
 * because that runs at deploy time. A preference toggle is a hot path and
 * read-then-write is not safe there.
 *
 * So a preference row names an **audience**: exactly one of a company or a
 * practice, never both and never neither. The database enforces it with a
 * check constraint, and the uniqueness is over the whole shape.
 *
 * And **a topic belongs to exactly one kind of audience**, written down here as
 * named data. A company topic stored against a practice would be a preference
 * nothing ever reads, which is worse than no preference at all: the person set
 * it, and believes they are covered.
 *
 * Nothing here touches the database or the clock.
 */

export type Audience =
  | { kind: 'company'; companyId: string }
  | { kind: 'practice'; practiceId: string }

export type AudienceKind = Audience['kind']

/**
 * Which kind of audience each topic belongs to.
 *
 * Everything Phase 8 through Phase 33 added is a company's business. The brief
 * is the first that is a firm's, and listing them all here rather than
 * defaulting means the next one has to make the choice deliberately.
 */
export const TOPIC_AUDIENCE: Record<NotificationTopic, AudienceKind> = {
  transactions_to_review: 'company',
  proposal_decided: 'company',
  invoice_paid: 'company',
  compliance_expiring: 'company',
  reconciliation_ready: 'company',
  remittance_due: 'company',
  follow_up_due: 'company',
  background_failures: 'company',
  books_disagree: 'company',
  // Phase 88. About a firm's whole roster, addressed to the firm, and about no
  // single client — which is why it needed this phase before it could have a
  // switch at all.
  practice_brief: 'practice',
}

/** Raised when a topic is asked for against the wrong kind of audience. */
export class WrongAudienceError extends Error {
  constructor(topic: NotificationTopic, kind: AudienceKind) {
    super(
      `${topic} is a ${TOPIC_AUDIENCE[topic]} topic and cannot be set for a ${kind}.`,
    )
    this.name = 'WrongAudienceError'
  }
}

/**
 * The audience a preference row names, or a refusal.
 *
 * Both ids or neither is a programming error rather than a user one, so it
 * throws: a row that named two owners would be read by whichever query asked
 * first, and a row that named none would be read by nobody.
 */
export function audienceOf(row: {
  companyId: string | null
  practiceId: string | null
}): Audience {
  if (row.companyId && row.practiceId) {
    throw new Error('A notification preference names one owner, not two.')
  }
  if (row.companyId) return { kind: 'company', companyId: row.companyId }
  if (row.practiceId) return { kind: 'practice', practiceId: row.practiceId }
  throw new Error('A notification preference names an owner.')
}

/** The two columns a row carries, from an audience. */
export function columnsFor(audience: Audience): {
  companyId: string | null
  practiceId: string | null
} {
  return audience.kind === 'company'
    ? { companyId: audience.companyId, practiceId: null }
    : { companyId: null, practiceId: audience.practiceId }
}

/**
 * Checks a topic against the audience it is being set for.
 *
 * The one rule worth enforcing rather than trusting: a company topic stored
 * against a practice is a preference nothing ever reads, and the person who set
 * it believes they are covered.
 */
export function assertTopicBelongs(topic: NotificationTopic, audience: Audience): void {
  if (TOPIC_AUDIENCE[topic] !== audience.kind) {
    throw new WrongAudienceError(topic, audience.kind)
  }
}

/** The topics that belong to one kind of audience, in enum order. */
export function topicsFor(
  kind: AudienceKind,
  all: readonly NotificationTopic[],
): NotificationTopic[] {
  return all.filter((topic) => TOPIC_AUDIENCE[topic] === kind)
}
