import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users, roleEnum } from './tenancy'
import { practices } from './practice'

/**
 * Transactional email and the links it carries (spec §19, §14).
 *
 * Two named gaps closed at once. Password reset has been absent since Phase 13
 * because "a half-built reset flow is a bypass for everything above it", and
 * practice invitations were listed in Phase 18 as waiting on transactional
 * mail. They wanted the same two things: a way to send a letter, and a link in
 * it that proves the reader owns the address.
 */

export const actionTokenPurposeEnum = pgEnum('action_token_purpose', [
  'password_reset',
  'company_invitation',
  'practice_invitation',
])

/**
 * A single-use link.
 *
 * ## Hashed at rest, like a password
 *
 * The column is `token_hash`, and the plaintext exists only in the email. A
 * database backup, a leaked query log, or a support engineer with read access
 * gets a list of hashes and no way in — the same reasoning as Phase 13's
 * recovery codes, and for a stronger reason: a reset token *is* a password for
 * the sixty minutes it lives.
 *
 * A `lookupPrefix` makes it findable without making it searchable. Phase 13's
 * recovery codes are checked by trying every unhashed candidate, which is fine
 * for ten codes belonging to one user and hopeless for every live token in the
 * system. The prefix is the first eight characters of the plaintext, stored in
 * the clear; it narrows the search to a handful of rows, and the remaining
 * entropy — 32 bytes' worth minus those eight characters — is still far more
 * than anyone will guess.
 */
export const actionTokens = pgTable(
  'action_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: actionTokenPurposeEnum('purpose').notNull(),

    /** The first characters of the plaintext, so the row can be found. */
    lookupPrefix: text('lookup_prefix').notNull(),
    /** The whole plaintext, hashed the way a password is. */
    tokenHash: text('token_hash').notNull(),

    /**
     * The address this token was sent to, lowercased.
     *
     * Recorded because an invitation may have no user yet, and because a reset
     * that lands on a changed address should not still work. Checked at
     * redemption.
     */
    email: text('email').notNull(),

    /** Set for a password reset; null for an invitation to somebody new. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Set for a company invitation. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    /** Set for a practice invitation. */
    practiceId: uuid('practice_id').references(() => practices.id, { onDelete: 'cascade' }),

    /** The role an invitation grants. Null for a reset. */
    role: roleEnum('role'),
    /** Display name offered to an invitee, so they do not retype it. */
    invitedName: text('invited_name'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set the moment it is spent. A token is good exactly once. */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    /** Set when superseded or withdrawn, so it is dead without being deleted. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Truncated, as everywhere else: the network, never the household. */
    requestedIp: text('requested_ip'),
  },
  (t) => ({
    prefixIdx: index('action_tokens_prefix_idx').on(t.lookupPrefix, t.purpose),
    emailIdx: index('action_tokens_email_idx').on(t.email, t.purpose),
    companyIdx: index('action_tokens_company_idx').on(t.companyId),
    practiceIdx: index('action_tokens_practice_idx').on(t.practiceId),
    // An invitation names where it invites somebody to; a reset names neither.
    purposeShape: check(
      'action_tokens_purpose_shape',
      sql`(${t.purpose} = 'company_invitation') = (${t.companyId} IS NOT NULL)
          AND (${t.purpose} = 'practice_invitation') = (${t.practiceId} IS NOT NULL)
          AND (${t.purpose} <> 'password_reset' OR ${t.userId} IS NOT NULL)`,
    ),
  }),
)

export const deliveryOutcomeEnum = pgEnum('delivery_outcome', ['sent', 'failed'])

/**
 * Every transactional message, whether it went or not.
 *
 * Kept apart from `campaign_events` on purpose: mixing the two would let a
 * marketing report count password resets as engagement, and would let a
 * suppression sweep over "all mail to this address" catch the letters that
 * must always get through.
 *
 * A failure here is not a suppression. When a campaign bounces, the right
 * answer is to stop mailing that address; when a password reset bounces, the
 * right answer is that somebody is locked out of their books and nobody knows.
 * So this table records it and the security page surfaces it, and nothing
 * anywhere adds it to a suppression list.
 */
export const transactionalMessages = pgTable(
  'transactional_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null when the message concerns no company, such as a practice invite. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),
    email: text('email').notNull(),
    subject: text('subject').notNull(),

    outcome: deliveryOutcomeEnum('outcome').notNull(),
    providerKey: text('provider_key').notNull(),
    providerMessageId: text('provider_message_id'),
    error: text('error'),

    /** The token or record this message was about. */
    reference: text('reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index('transactional_messages_email_idx').on(t.email, t.createdAt),
    companyIdx: index('transactional_messages_company_idx').on(t.companyId, t.createdAt),
    failureIdx: index('transactional_messages_failed_idx').on(t.outcome, t.createdAt),
  }),
)
