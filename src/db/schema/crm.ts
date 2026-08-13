import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  date,
  boolean,
  jsonb,
  index,
  unique,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'

/**
 * CRM: organizations, contacts, opportunities, and proposals (spec §6, §9).
 *
 * ## The unified party record
 *
 * Spec §6 asks for "unified contact/company records with lead, prospect,
 * active client, former client, vendor, or strategic-target status", while
 * spec §16 lists Customer and Vendor as their own entities. Both are satisfied
 * by treating `organizations` as the one party record and customer/vendor as
 * *accounting roles* an organization plays: `customers.organizationId` and
 * `vendors.organizationId` point back here.
 *
 * That resolves a case a single merged table handles badly — a firm you both
 * buy from and sell to is one organization with two accounting roles, not two
 * conflicting rows.
 */

/** Where an organization sits in the sales lifecycle (spec §6). */
export const lifecycleStageEnum = pgEnum('lifecycle_stage', [
  'lead',
  'prospect',
  'active_client',
  'former_client',
  'vendor',
  'strategic_target',
])

/** Opportunity pipeline stages, in the order spec §6 lists them. */
export const opportunityStageEnum = pgEnum('opportunity_stage', [
  'new_inquiry',
  'qualified',
  'proposal_draft',
  'proposal_sent',
  'viewed',
  'follow_up',
  'negotiation',
  'won',
  'lost',
  'dormant',
])

/** Loss reasons for analytics (spec §6, §9). */
export const lossReasonEnum = pgEnum('loss_reason', [
  'price',
  'timing',
  'competitor',
  'no_response',
  'scope',
  'internal_cancellation',
  'other',
])

/** Proposal statuses reported on in spec §9. */
export const proposalStatusEnum = pgEnum('proposal_status', [
  'draft',
  'sent',
  'viewed',
  'won',
  'lost',
  'expired',
  'no_decision',
])

/**
 * Marketing consent (spec §10, §19).
 *
 * Captured here in Phase 3 so the record exists from the moment a lead
 * arrives; Phase 5 is what acts on it. Defaults to `unknown` rather than
 * `subscribed` — consent is something a person gives, not something absence of
 * information implies.
 */
export const consentStatusEnum = pgEnum('consent_status', [
  'unknown',
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
])

/** A company or individual the business deals with — the unified party record. */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lifecycleStage: lifecycleStageEnum('lifecycle_stage').notNull().default('lead'),

    /**
     * High-value recurring-service target (spec §10), tracked separately from
     * the lifecycle stage because an existing client can also be strategic.
     */
    isStrategicAccount: boolean('is_strategic_account').notNull().default(false),

    website: text('website'),
    phone: text('phone'),
    email: text('email'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    country: text('country'),

    /** Segmentation dimensions reported on in spec §9. */
    industry: text('industry'),
    sizeBand: text('size_band'),
    /** How this organization first arrived, e.g. "website", "referral". */
    source: text('source'),

    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNameIdx: index('organizations_company_name_idx').on(t.companyId, t.name),
    stageIdx: index('organizations_stage_idx').on(t.companyId, t.lifecycleStage),
  }),
)

/** A person, usually attached to an organization. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),

    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    phone: text('phone'),
    title: text('title'),
    isPrimary: boolean('is_primary').notNull().default(false),

    /** Consent state and its provenance (spec §10, §19). */
    emailConsent: consentStatusEnum('email_consent').notNull().default('unknown'),
    consentSource: text('consent_source'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    /** Set when suppressed; a suppressed contact is never marketed to. */
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('contacts_company_idx').on(t.companyId),
    organizationIdx: index('contacts_organization_idx').on(t.organizationId),
    emailIdx: index('contacts_email_idx').on(t.companyId, t.email),
  }),
)

/**
 * A potential piece of business (spec §6).
 *
 * Carries everything the win/loss analytics in spec §9 report on: source,
 * owner, expected value, probability, dates, and — when it ends badly — a
 * structured loss reason.
 */
export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    primaryContactId: uuid('primary_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),

    title: text('title').notNull(),
    stage: opportunityStageEnum('stage').notNull().default('new_inquiry'),

    /** Expected value in minor units. Never a float. */
    expectedValueCents: bigint('expected_value_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** 0–100. Combined with expected value to weight the forecast. */
    probability: integer('probability').notNull().default(0),
    /**
     * True once someone sets the probability by hand. Until then it tracks the
     * stage default, so moving a deal to Negotiation actually raises its
     * forecast weight instead of leaving it at the value it entered with.
     */
    probabilityOverridden: boolean('probability_overridden').notNull().default(false),

    source: text('source'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    expectedCloseDate: date('expected_close_date'),

    /** Set when the opportunity reaches a terminal stage. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lossReason: lossReasonEnum('loss_reason'),
    lossNotes: text('loss_notes'),

    /**
     * Whether a lost or dormant opportunity may be routed into marketing
     * nurture (spec §6, §9). Decided at close from the contact's consent, so
     * Phase 5 does not have to re-derive it.
     */
    marketingEligible: boolean('marketing_eligible').notNull().default(false),

    /** Set by conversion when the win becomes a client and a job (spec §6). */
    convertedCustomerId: uuid('converted_customer_id'),
    convertedProjectId: uuid('converted_project_id'),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pipelineIdx: index('opportunities_pipeline_idx').on(t.companyId, t.stage),
    organizationIdx: index('opportunities_organization_idx').on(t.organizationId),
    ownerIdx: index('opportunities_owner_idx').on(t.companyId, t.ownerId),
    probabilityRange: check(
      'opportunities_probability_range',
      sql`${t.probability} >= 0 AND ${t.probability} <= 100`,
    ),
  }),
)

/**
 * Activity history on an opportunity (spec §6).
 *
 * Distinct from the audit log: audit records *who changed what* for
 * accountability, this records *what happened with the customer* for the
 * salesperson. A logged call belongs here, not in the audit trail.
 */
export const opportunityActivities = pgTable(
  'opportunity_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),

    /** e.g. "stage_change", "note", "call", "email", "proposal_sent". */
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name'),
  },
  (t) => ({
    opportunityIdx: index('opportunity_activities_opportunity_idx').on(
      t.opportunityId,
      t.occurredAt,
    ),
  }),
)

/**
 * A proposal or estimate (spec §7 structure, §9 statuses).
 *
 * Phase 3 covers the commercial lifecycle — pricing, statuses, versioning, and
 * view tracking. The visual designer is Phase 4 and will attach layout to
 * these same records rather than replacing them.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),

    number: text('number').notNull(),
    title: text('title').notNull(),
    status: proposalStatusEnum('status').notNull().default('draft'),

    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),

    /** Narrative sections. Phase 4 replaces these with designed content. */
    executiveSummary: text('executive_summary'),
    scope: text('scope'),
    exclusions: text('exclusions'),
    terms: text('terms'),

    /**
     * Unguessable token for the client-facing link. Random per proposal, so
     * possessing one link reveals nothing about any other.
     */
    publicToken: text('public_token').notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresOn: date('expires_on'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('proposals_company_number_unique').on(t.companyId, t.number),
    tokenUnique: unique('proposals_public_token_unique').on(t.publicToken),
    statusIdx: index('proposals_status_idx').on(t.companyId, t.status),
    opportunityIdx: index('proposals_opportunity_idx').on(t.opportunityId),
  }),
)

export const proposalItems = pgTable(
  'proposal_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),

    description: text('description').notNull(),
    /** Thousandths, so fractional quantities stay exact. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull().default(1000),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull().default(0),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),

    /**
     * Optional items the client can decline (spec §7). Excluded from the
     * proposal total until selected.
     */
    isOptional: boolean('is_optional').notNull().default(false),
    isSelected: boolean('is_selected').notNull().default(true),

    /** Revenue account used when a won proposal becomes an invoice. */
    chartAccountId: uuid('chart_account_id'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    proposalIdx: index('proposal_items_proposal_idx').on(t.proposalId),
  }),
)

/**
 * An immutable snapshot taken each time a proposal is sent (spec §7, §18).
 *
 * Once a proposal is in front of a client, what they were shown must not
 * change underneath them. Editing and resending produces a new version rather
 * than mutating the old one.
 */
export const proposalVersions = pgTable(
  'proposal_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),

    versionNumber: integer('version_number').notNull(),
    /** Full snapshot of the proposal and its items at send time. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    proposalVersionUnique: unique('proposal_versions_unique').on(t.proposalId, t.versionNumber),
  }),
)

/**
 * A client-side view of a proposal (spec §9: track opens and views).
 *
 * Deliberately coarse: a timestamp, a truncated address, and a user agent. No
 * cross-site identifiers and no behavioural profiling — spec §9 qualifies view
 * tracking with "where technically and legally appropriate".
 */
export const proposalViews = pgTable(
  'proposal_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),

    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Truncated to the network prefix — enough to spot abuse, not to identify. */
    ipPrefix: text('ip_prefix'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    proposalIdx: index('proposal_views_proposal_idx').on(t.proposalId, t.viewedAt),
  }),
)

/**
 * A job or project (spec §6: a won proposal creates one; spec §13: an
 * accounting dimension).
 *
 * Serves both roles, which is why it lives here rather than being duplicated
 * on the accounting side.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'on_hold', 'complete', 'cancelled'] })
      .notNull()
      .default('active'),

    startDate: date('start_date'),
    endDate: date('end_date'),
    /** Contract value in minor units, carried over from the won proposal. */
    contractValueCents: bigint('contract_value_cents', { mode: 'number' })
      .notNull()
      .default(0),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: unique('projects_company_code_unique').on(t.companyId, t.code),
    companyIdx: index('projects_company_idx').on(t.companyId, t.status),
  }),
)

/**
 * A public key that lets a website submit leads (spec §6).
 *
 * The key identifies the tenant on an unauthenticated endpoint. It is
 * write-only by design: possessing it allows creating a lead and nothing else
 * — no reads, no updates, no access to any other record.
 */
export const leadIntakeKeys = pgTable(
  'lead_intake_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    name: text('name').notNull(),

    /**
     * Origins permitted to call the endpoint from a browser. Empty means any
     * origin, which is the workable default for a widget dropped onto a site
     * whose domain the operator has not enumerated.
     */
    allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
    /** Submissions accepted per hour before the endpoint starts refusing. */
    hourlyLimit: integer('hourly_limit').notNull().default(60),

    isActive: boolean('is_active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    submissionCount: integer('submission_count').notNull().default(0),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    publicKeyUnique: unique('lead_intake_keys_public_key_unique').on(t.publicKey),
    companyIdx: index('lead_intake_keys_company_idx').on(t.companyId),
  }),
)

/**
 * Every intake attempt, accepted or not.
 *
 * Serves two purposes on a public write endpoint: it is the counter the rate
 * limiter reads, and it is the record an operator needs to investigate abuse.
 * Rejected attempts are logged precisely because those are the interesting
 * ones.
 */
export const leadSubmissions = pgTable(
  'lead_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    intakeKeyId: uuid('intake_key_id').references(() => leadIntakeKeys.id, {
      onDelete: 'cascade',
    }),

    accepted: boolean('accepted').notNull(),
    /** Why it was refused: "rate_limited", "honeypot", "invalid", "origin". */
    rejectionReason: text('rejection_reason'),

    ipPrefix: text('ip_prefix'),
    userAgent: text('user_agent'),
    origin: text('origin'),

    createdOpportunityId: uuid('created_opportunity_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The rate limiter's read path: recent rows for one key.
    rateLimitIdx: index('lead_submissions_rate_limit_idx').on(t.intakeKeyId, t.receivedAt),
    companyIdx: index('lead_submissions_company_idx').on(t.companyId, t.receivedAt),
  }),
)
