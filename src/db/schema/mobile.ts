import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  unique,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { companies, devices, users } from './tenancy'
import { practices } from './practice'
import { transactionalMessages } from './notify'

/**
 * The mobile app (spec §3 mobile workflow, §18 responsive/PWA before native,
 * §19 idempotency and least privilege).
 *
 * The premise of the whole phase is that a phone is sometimes offline and a
 * pocket is sometimes emptied. Everything here follows from those two facts:
 * operations must survive being replayed, and a device must be revocable on
 * its own.
 */

/**
 * The outcome of an operation, keyed so replaying it is free.
 *
 * A phone that categorizes six transactions in a lift and reconnects at the
 * top has six queued writes. It may also have *already* sent one and lost the
 * response — from the client's side those two situations are identical, so it
 * has to retry, and the server has to make retrying safe.
 *
 * The row is written in the same transaction as the work it describes, so
 * "the operation happened" and "the operation is recorded as having happened"
 * cannot come apart. Replaying returns the stored result without touching the
 * ledger again.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Client-generated, unique per operation. A uuid from the device. */
    key: text('key').notNull(),
    /** The operation this key belongs to, e.g. "transaction.categorize". */
    operation: text('operation').notNull(),

    /**
     * Hash of the request body.
     *
     * A key reused with *different* arguments is a client bug, not a retry,
     * and returning the first result would silently discard the second
     * request. Comparing fingerprints turns that into an error.
     */
    requestFingerprint: text('request_fingerprint').notNull(),

    /** The response the first execution produced, replayed verbatim. */
    result: jsonb('result').$type<Record<string, unknown>>(),

    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The guarantee, enforced by the database rather than by a check-then-act
    // that two concurrent retries could both pass.
    keyUnique: unique('idempotency_keys_unique').on(t.companyId, t.key),
    createdIdx: index('idempotency_keys_created_idx').on(t.createdAt),
  }),
)

/**
 * A Web Push subscription, one per device per browser.
 *
 * The endpoint and keys come from the browser's push service. They are
 * credentials for sending to that device and nothing else — they grant no
 * access to the account, which is why losing one is a nuisance rather than a
 * breach.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),

    /** The push service URL. Unique: re-subscribing replaces rather than adds. */
    endpoint: text('endpoint').notNull(),
    /** Client public key and auth secret, used to encrypt the payload. */
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),

    provider: text('provider').notNull().default('mock'),

    /**
     * Consecutive delivery failures. A push service that keeps returning 410
     * has a subscription that no longer exists; after a few we stop trying.
     */
    failureCount: integer('failure_count').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    endpointUnique: unique('push_subscriptions_endpoint_unique').on(t.endpoint),
    userIdx: index('push_subscriptions_user_idx').on(t.companyId, t.userId),
  }),
)

/** Notification categories a person can switch off individually. */
export const notificationTopicEnum = pgEnum('notification_topic', [
  'transactions_to_review',
  'proposal_decided',
  'invoice_paid',
  'compliance_expiring',
  'reconciliation_ready',
  // Added in Phase 10, when something finally existed to send it. A reminder
  // about money owed to an agency is not the same kind of interruption as a
  // review queue, and folding it into one would mean somebody switching off
  // nudges also switches off the one that costs penalties.
  'remittance_due',
  // Added in Phase 24, for the same reason `remittance_due` was added in Phase
  // 10: something finally exists to send them, and each is a different kind of
  // interruption from the others.
  //
  // A promise somebody made on a call is not a review queue, and a background
  // failure is not either — folding any of these together would mean somebody
  // switching off the noisy one also switching off the one that matters.
  'follow_up_due',
  'background_failures',
  // Added in Phase 33, on the same reasoning that added the two above: the
  // books disagreeing with themselves is not a background failure. One is
  // "the machinery stopped", the other is "the numbers are wrong", and
  // somebody who silences a noisy queue must not thereby silence the ledger.
  'books_disagree',
  // Added in Phase 89, for the message Phase 88 introduced with no way to
  // switch it off. The first topic here that belongs to a *practice* rather
  // than a company, and the reason `notification_preferences` had to learn
  // that a preference names an audience — see `modules/mobile/audience`.
  'practice_brief',
])

/**
 * Per-user notification preferences.
 *
 * Absent means *on* for these, unlike the AI module: a person who installed
 * the app and granted notification permission has already opted in, and making
 * them opt in twice is how a useful reminder never arrives. Switching one off
 * writes a row.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Exactly one of these two, never both and never neither (Phase 89).
     *
     * A preference belongs to an **audience**, and this application has two
     * kinds: a company, and — since Phase 88's firm brief — a practice. The
     * check constraint in the migration enforces the exclusivity, and the
     * unique index is declared `NULLS NOT DISTINCT` so that two rows with the
     * same null column cannot both exist and turn an upsert into an insert.
     */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    practiceId: uuid('practice_id').references(() => practices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topic: notificationTopicEnum('topic').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Declared here for drizzle's benefit; the migration creates it with
     * `NULLS NOT DISTINCT`, which drizzle's builder cannot express and which is
     * the whole reason this works.
     */
    topicUnique: unique('notification_preferences_unique').on(
      t.userId,
      t.companyId,
      t.practiceId,
      t.topic,
    ),
  }),
)

/**
 * Every notification **decision**, delivered or not.
 *
 * The same reasoning as the AI usage ledger: "why did I not get told about
 * that" is a question a support conversation starts with, and it needs an
 * answer that is not a guess.
 *
 * The word is *decision* rather than *attempt* since Phase 90, because the
 * boundary against `transactional_messages` had become load-bearing and was
 * nowhere written down. That table records a transmission — this address, this
 * provider, did the hop succeed. This one records a choice: we told this person,
 * or we chose not to, and here is why. A suppression has no transmission at all,
 * which is exactly why it belongs here and not there. See `mobile/decision`.
 */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Exactly one of these two, never both and never neither (Phase 90), the
     * same shape `notification_preferences` took in Phase 89 and for the same
     * reason: the firm's brief is about no single company, and filing it under
     * one would put a firm's business on that client's record.
     */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    practiceId: uuid('practice_id').references(() => practices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    subscriptionId: uuid('subscription_id'),

    /**
     * The letter this decision produced (Phase 91).
     *
     * The join Phase 90 left unmade: that phase separated the decision from the
     * transmission and then had no way to get from one to the other. Null for a
     * suppression, which has no letter by construction, and for every push row.
     *
     * `ON DELETE SET NULL`, because retention sweeps letters at a year and the
     * record of the decision must outlive the letter. "We told you, and the
     * letter has since expired" is a true answer; the row vanishing is not.
     */
    messageId: uuid('message_id').references(() => transactionalMessages.id, {
      onDelete: 'set null',
    }),

    topic: notificationTopicEnum('topic').notNull(),
    /** push | mail — see below, and `mobile/decision`. */
    channel: text('channel').notNull().default('push'),
    title: text('title').notNull(),
    /**
     * The message text, for push only.
     *
     * A mail-backed notification's words belong to the letter rather than to
     * the decision about it; a second copy here is the two-answers-to-one-
     * question defect, where an edit to the wording fixes one and leaves the
     * other lying. `channel` is what tells a reader that a null body means
     * "the text is in the other table" rather than "there was no text".
     *
     * Phase 90 said the text was already in `transactional_messages`. It was
     * not — that table kept no body until Phase 91 gave it one, so for one
     * phase this comment described a place that did not exist.
     */
    body: text('body'),
    url: text('url'),

    /** sent | suppressed | failed | no_subscription */
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    provider: text('provider').notNull().default('mock'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('notification_log_company_idx').on(t.companyId, t.createdAt),
    practiceIdx: index('notification_log_practice_idx').on(t.practiceId, t.createdAt),
  }),
)
