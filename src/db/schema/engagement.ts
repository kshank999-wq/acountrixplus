import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  pgEnum,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { contacts, opportunities, organizations } from './crm'
import { transactionalMessages } from './notify'

/**
 * Communications (spec §16 `Communication`, §6, §17 "Notification/Task
 * Service").
 *
 * §6 says an opportunity stores "source, owner, expected value, probability,
 * proposed services/products, dates, **communications, files, and activity
 * history**". Files arrived in Phase 20 and activity history has existed since
 * Phase 3. This is the third one, and it is not the same thing as either.
 *
 * ## An activity is not a communication
 *
 * `opportunity_activities` records what the *software* did: a stage changed, a
 * proposal was sent, a lead arrived. It is complete, it is generated, and
 * nobody writes it.
 *
 * A communication records what a *person said to somebody outside the company*
 * — a phone call, a site visit, a reply to an email. It is written by hand,
 * it is incomplete by nature, and it is the thing somebody reads before
 * picking up the phone. Same distinction Phase 20 drew between the audit log
 * and an accountant's note, for the same reason: one answers *what happened*
 * and the other answers *what was said*.
 */

/** How the exchange happened. Not a channel the system sends on — a medium. */
export const communicationChannelEnum = pgEnum('communication_channel', [
  'email',
  'call',
  'meeting',
  'note',
  'letter',
  'message',
])

export const communicationDirectionEnum = pgEnum('communication_direction', [
  'outbound',
  'inbound',
  /** A note to self about the relationship, addressed to nobody. */
  'internal',
])

/**
 * One exchange with somebody outside the company.
 *
 * ## Real columns, not a polymorphic reference
 *
 * Phase 20's evidence links hang off eleven kinds of record through a registry,
 * because a receipt genuinely can belong to a bill or a payroll run or a fixed
 * asset. A communication cannot. It is always with a *party* — an
 * organization, one of its people, and optionally the deal being discussed —
 * and those are three foreign keys the database can actually enforce.
 *
 * Reusing the evidence registry here would have been the tempting symmetry and
 * the wrong one: it would make "log a phone call against a bank transaction"
 * expressible, and a polymorphic reference cannot be constrained.
 */
export const communications = pgTable(
  'communications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),

    channel: communicationChannelEnum('channel').notNull(),
    direction: communicationDirectionEnum('direction').notNull(),

    /** One line, for a list. Required — an entry nobody can skim is noise. */
    summary: text('summary').notNull(),
    /** What was actually said, when somebody bothered to write it down. */
    body: text('body'),

    /**
     * When it happened, not when it was typed.
     *
     * A call logged on Monday about Friday's conversation belongs on Friday, or
     * the timeline lies about the order things happened in.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * The letter this records, when the system sent it (Phase 19).
     *
     * Set for mail this application produced; null for anything a person
     * logged. It is what makes "did we ever actually send them that?"
     * answerable rather than a matter of memory.
     */
    transactionalMessageId: uuid('transactional_message_id'),

    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    /** Frozen, so an exchange keeps its author after they leave. */
    actorName: text('actor_name').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    organizationIdx: index('communications_organization_idx').on(
      t.companyId,
      t.organizationId,
      t.occurredAt,
    ),
    opportunityIdx: index('communications_opportunity_idx').on(
      t.companyId,
      t.opportunityId,
      t.occurredAt,
    ),
    contactIdx: index('communications_contact_idx').on(t.contactId, t.occurredAt),

    /**
     * An exchange is with somebody. A row naming no party at all belongs to no
     * timeline and would be visible on no screen — which is a silent way to
     * lose what somebody wrote down.
     */
    hasParty: check(
      'communications_has_party',
      sql`${t.organizationId} IS NOT NULL OR ${t.contactId} IS NOT NULL OR ${t.opportunityId} IS NOT NULL`,
    ),
    summaryNotEmpty: check(
      'communications_summary_not_empty',
      sql`length(btrim(${t.summary})) > 0`,
    ),
    // Named explicitly: the generated name would be 67 bytes and Postgres
    // truncates at 63 without saying so.
    transactionalMessageFk: foreignKey({
      name: 'communications_transactional_message_fk',
      columns: [t.transactionalMessageId],
      foreignColumns: [transactionalMessages.id],
    }).onDelete('set null'),
  }),
)

/**
 * Follow-up work lives in `src/db/schema/marketing.ts`, where Phase 5 put it.
 *
 * Phase 22 adds columns to that table rather than creating a second one here:
 * a follow-up raised by a campaign and one somebody typed are the same kind of
 * thing, and two tables is how the first stops appearing on the list anybody
 * reads.
 */
