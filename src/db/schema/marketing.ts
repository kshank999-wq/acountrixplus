import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  date,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { contacts, opportunities, organizations } from './crm'
import { designDocuments } from './design'

/**
 * Marketing (spec §8, §10).
 *
 * Two rules run through everything here:
 *
 *  1. **Consent is checked at send time, not at segment time.** A segment is a
 *     query; a send is an action. Someone who unsubscribed after a campaign
 *     was built must not receive it, so the check happens as late as possible.
 *  2. **Suppression is company-wide and address-based.** Unsubscribing removes
 *     one person from everything, not from one campaign, and it survives the
 *     contact record being recreated by a later lead-intake submission.
 */

export const campaignKindEnum = pgEnum('campaign_kind', ['broadcast', 'nurture'])

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'paused',
  'cancelled',
])

/** What happened to one recipient of one step. */
export const recipientStatusEnum = pgEnum('recipient_status', [
  'pending',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'unsubscribed',
  'skipped',
  /**
   * The provider would not take the message (Phase 83).
   *
   * Distinct from `bounced`, which is the receiving server rejecting it after
   * the provider accepted it. One is ours and usually transient; the other is
   * a fact about the address.
   */
  'failed',
])

/**
 * A saved audience definition (spec §10).
 *
 * `definition` holds the filter rules; matching logic lives in
 * `modules/marketing/segments` as pure functions. Segments are evaluated on
 * demand rather than materialized, so an audience is always current.
 */
export const segments = pgTable(
  'segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Shape validated by `segmentDefinitionSchema`. */
    definition: jsonb('definition').$type<unknown>().notNull(),
    isActive: boolean('is_active').notNull().default(true),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('segments_company_idx').on(t.companyId, t.isActive),
  }),
)

/**
 * A campaign (spec §10).
 *
 * A broadcast has one step; a nurture sequence has several, each with a delay.
 * Modelling both the same way means the send pipeline and the analytics have
 * one shape to handle rather than two.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: campaignKindEnum('kind').notNull().default('broadcast'),
    status: campaignStatusEnum('status').notNull().default('draft'),

    segmentId: uuid('segment_id').references(() => segments.id, { onDelete: 'set null' }),

    fromName: text('from_name'),
    fromEmail: text('from_email'),
    replyTo: text('reply_to'),

    /** Calendar placement (spec §10 campaign calendar). */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyStatusIdx: index('campaigns_company_status_idx').on(t.companyId, t.status),
    calendarIdx: index('campaigns_calendar_idx').on(t.companyId, t.scheduledFor),
  }),
)

/**
 * One message in a campaign (spec §10 recurring nurture sequences).
 *
 * The creative is a `design_document` with `kind: 'marketing'` — the same
 * engine that renders proposals (spec §8).
 */
export const campaignSteps = pgTable(
  'campaign_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),

    stepNumber: integer('step_number').notNull(),
    /** Days after the previous step. Zero means immediately. */
    delayDays: integer('delay_days').notNull().default(0),

    subject: text('subject').notNull(),
    previewText: text('preview_text'),
    designDocumentId: uuid('design_document_id').references(() => designDocuments.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignStepUnique: unique('campaign_steps_unique').on(t.campaignId, t.stepNumber),
  }),
)

/**
 * One recipient of one step.
 *
 * `unsubscribeToken` is per-recipient and unguessable: it identifies who is
 * unsubscribing without the link carrying an email address, and it means one
 * leaked link cannot be used to unsubscribe anybody else.
 */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id').references(() => campaignSteps.id, { onDelete: 'cascade' }),

    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    /** Snapshotted so history survives the contact being edited or removed. */
    email: text('email').notNull(),

    status: recipientStatusEnum('status').notNull().default('pending'),
    /** Why a recipient was skipped: "no_consent", "suppressed", "no_email". */
    skipReason: text('skip_reason'),
    /**
     * What the provider said when it would not take the message (Phase 83).
     *
     * Its own column: this used to go into `skipReason`, which answers a
     * different question, and the two shared a field only because there was
     * nowhere else to put it.
     */
    failureReason: text('failure_reason'),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),

    unsubscribeToken: text('unsubscribe_token').notNull(),
    /** Provider's own id, for reconciling delivery webhooks later. */
    providerMessageId: text('provider_message_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: unique('campaign_recipients_token_unique').on(t.unsubscribeToken),
    // One contact receives one step once.
    stepContactUnique: unique('campaign_recipients_step_contact_unique').on(
      t.stepId,
      t.contactId,
    ),
    campaignIdx: index('campaign_recipients_campaign_idx').on(t.campaignId, t.status),
  }),
)

/**
 * An engagement event (spec §10).
 *
 * Appended rather than only stamping the recipient row, so repeat opens and
 * multiple clicks on different links are all on the record.
 */
export const campaignEvents = pgTable(
  'campaign_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => campaignRecipients.id, { onDelete: 'cascade' }),

    /** "sent", "open", "click", "bounce", "complaint", "unsubscribe". */
    kind: text('kind').notNull(),
    /** For a click, the destination. */
    url: text('url'),
    ipPrefix: text('ip_prefix'),
    userAgent: text('user_agent'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    recipientIdx: index('campaign_events_recipient_idx').on(t.recipientId, t.occurredAt),
    companyKindIdx: index('campaign_events_company_kind_idx').on(t.companyId, t.kind),
  }),
)

/**
 * The company-wide suppression list (spec §10, §19).
 *
 * Keyed by address rather than contact, so unsubscribing survives the contact
 * record being deleted and recreated — which lead intake will do if the same
 * person fills in the form again.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Stored lower-cased; matching is exact on the normalized value. */
    email: text('email').notNull(),
    /** "unsubscribe", "bounce", "complaint", "manual". */
    reason: text('reason').notNull(),
    /** The campaign it came from, when it came from one. */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyEmailUnique: unique('suppressions_company_email_unique').on(t.companyId, t.email),
  }),
)

/**
 * A follow-up task (spec §10 marketing-to-sales loop, §16 Task).
 *
 * Deliberately minimal: enough to close the loop from an engagement back to a
 * person, without inventing a project-management surface Phase 5 does not ask
 * for.
 */
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'normal', 'high'])

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    detail: text('detail'),
    dueOn: date('due_on'),
    status: text('status', { enum: ['open', 'done', 'cancelled'] })
      .notNull()
      .default('open'),

    /** What the task is about, when it is about something. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),

    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // --- Phase 22 -----------------------------------------------------------
    //
    // Added here rather than in a second table: a follow-up raised by a
    // campaign and one somebody typed are the same kind of thing, and two
    // tables is how the first stops appearing on the list anybody reads.
    priority: taskPriorityEnum('priority').notNull().default('normal'),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    /** How it ended. A task that simply vanishes teaches nobody anything. */
    outcome: text('outcome'),
  },
  (t) => ({
    companyStatusIdx: index('tasks_company_status_idx').on(t.companyId, t.status, t.dueOn),
    /** The "what is on my desk" query: mine, open, soonest first. */
    assigneeIdx: index('tasks_assignee_idx').on(t.companyId, t.assignedTo, t.status, t.dueOn),
    titleNotEmpty: check('tasks_title_not_empty', sql`length(btrim(${t.title})) > 0`),
    /**
     * A finished task records when it finished; an open one cannot claim to.
     *
     * Without this a completion that half-failed leaves a row that is open and
     * has a completion date, and every count of "done this week" disagrees
     * with every list of open work.
     */
    completionShape: check(
      'tasks_completion_shape',
      sql`(${t.status} = 'open') = (${t.completedAt} IS NULL)`,
    ),
  }),
)
