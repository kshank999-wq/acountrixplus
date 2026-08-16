import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users, roleEnum } from './tenancy'

/**
 * Accountant practice mode (spec §14: "can later allow one accountant to
 * switch securely among multiple client companies").
 *
 * The last thing §14 asked for, and the one the whole tenancy design was built
 * to survive. Since Phase 1 every service has taken an explicit `ActorContext`
 * and there has been no ambient "current company" anywhere — a decision whose
 * only real test is a human who legitimately belongs to twenty companies at
 * once. This is that human.
 */

/**
 * Where an engagement is in its life.
 *
 * `pending` is the important one. Access to a company's books is never a thing
 * one party can simply take: whichever side asks, the *other* side has to
 * agree, and until it does the engagement grants nothing at all.
 */
export const engagementStatusEnum = pgEnum('engagement_status', [
  'pending',
  'active',
  'declined',
  'ended',
])

/** Which side asked. The other side is the one that must accept. */
export const engagementInitiatorEnum = pgEnum('engagement_initiator', ['practice', 'client'])

/** An accounting firm. */
export const practices = pgTable(
  'practices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Shown to a client deciding whether to accept an engagement. */
    contactEmail: text('contact_email'),
    website: text('website'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    activeIdx: index('practices_active_idx').on(t.isActive, t.name),
  }),
)

/**
 * Somebody who works at the firm.
 *
 * `defaultRole` is what this person gets at each client, and it is capped at
 * the engagement's own role by `grantedRole` below — a practice cannot promote
 * its staff above what the client agreed to.
 */
export const practiceMembers = pgTable(
  'practice_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `owner` may sign engagements and add staff; `staff` may not. */
    practiceRole: text('practice_role', { enum: ['owner', 'staff'] })
      .notNull()
      .default('staff'),
    /** The role this person takes at a client, subject to the engagement's cap. */
    defaultRole: roleEnum('default_role').notNull().default('accountant'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memberUnique: unique('practice_members_unique').on(t.practiceId, t.userId),
    userIdx: index('practice_members_user_idx').on(t.userId, t.isActive),
  }),
)

/**
 * One firm's access to one company's books.
 *
 * ## Access is granted, never claimed
 *
 * `initiatedBy` records which side asked, and the service refuses to let that
 * same side accept. An accountant cannot add themselves to a company's books,
 * and a company cannot conscript an accountant — both are ways of describing
 * the same rule, which is that an engagement needs two signatures.
 *
 * The alternative, "the practice adds the client and the client is notified",
 * is how a support tool ends up able to read every customer's ledger. It is
 * also, more mundanely, how one wrong email address gives a stranger the books.
 */
export const practiceEngagements = pgTable(
  'practice_engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    practiceId: uuid('practice_id')
      .notNull()
      .references(() => practices.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    status: engagementStatusEnum('status').notNull().default('pending'),
    initiatedBy: engagementInitiatorEnum('initiated_by').notNull(),

    /**
     * The most this engagement may grant. A practice member whose default role
     * is `owner` still arrives as whatever the client agreed to — the client's
     * decision caps the firm's, not the other way round.
     */
    grantedRole: roleEnum('granted_role').notNull().default('accountant'),

    /** Why the firm wants access, or why the client is asking. Free text. */
    note: text('note'),

    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    respondedBy: uuid('responded_by').references(() => users.id, { onDelete: 'set null' }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: uuid('ended_by').references(() => users.id, { onDelete: 'set null' }),
    endedReason: text('ended_reason'),
  },
  (t) => ({
    // One live engagement per firm per company. A second pending request while
    // one is already active is a duplicate, not a second relationship.
    //
    // Enforced as a **partial** unique index — `WHERE status IN
    // ('pending','active')` — added by hand in the migration, because
    // drizzle-kit cannot express one and the constraint is worth more than the
    // tidiness. Without it, two clicks on "invite" produce two engagements,
    // accepting both produces two sets of memberships, and ending one leaves
    // the firm still holding the books. The partial part matters too: a
    // company must be able to re-engage a firm it once let go.
    companyIdx: index('practice_engagements_company_idx').on(t.companyId, t.status),
    practiceIdx: index('practice_engagements_practice_idx').on(t.practiceId, t.status),
    // A settled engagement knows when it settled.
    respondedComplete: check(
      'practice_engagements_responded',
      sql`(${t.status} = 'pending') = (${t.respondedAt} IS NULL)`,
    ),
    endedComplete: check(
      'practice_engagements_ended',
      sql`(${t.status} = 'ended') = (${t.endedAt} IS NOT NULL)`,
    ),
  }),
)
