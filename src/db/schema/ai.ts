import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  unique,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'

/**
 * The optional AI module (spec §11, §12).
 *
 * Three rules shape this schema, and they are the reason it exists at all
 * rather than being a few columns bolted onto existing tables:
 *
 *  1. **The module is off until somebody turns it on.** Every table here is
 *     empty on a fresh company, and the core accounting product never reads
 *     any of them. Spec §23 requires AI to be additive; an empty schema is
 *     what that looks like on disk.
 *  2. **A suggestion is not an action.** Model output lands in
 *     `ai_suggestions` and stays there until a person accepts it. Applying it
 *     then goes through the same service a human uses, and is audited as that
 *     person's action — not the model's.
 *  3. **Every call is metered before it is made.** `ai_requests` is the usage
 *     ledger spec §12 asks for, and the cost ceiling is enforced against it.
 */

/** The capabilities spec §11 names. One row of the usage ledger per call. */
export const aiFeatureEnum = pgEnum('ai_feature', [
  'bookkeeping_categorize',
  'bookkeeping_anomalies',
  'bookkeeping_rule',
  'bookkeeping_summary',
  'reconciliation_explain',
  'proposal_draft',
  'marketing_draft',
  'business_insights',
])

/**
 * What became of a call.
 *
 * `blocked_quota` and `blocked_disabled` are recorded even though no provider
 * was reached: a marketer who hits a ceiling should see why in the same place
 * they see everything else, not get silence.
 */
export const aiOutcomeEnum = pgEnum('ai_outcome', [
  'ok',
  'invalid_output',
  'provider_error',
  'refused',
  'blocked_quota',
  'blocked_disabled',
])

export const aiSuggestionStatusEnum = pgEnum('ai_suggestion_status', [
  'pending',
  'accepted',
  'rejected',
  'superseded',
])

/**
 * Per-company configuration for the module (spec §11 "sold as an optional
 * module", §12 quotas and cost ceilings).
 *
 * A company with no row here has AI switched off, which is the default for
 * every company the onboarding flow creates.
 */
export const aiSettings = pgTable('ai_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),

  enabled: boolean('enabled').notNull().default(false),

  /** Adapter key, resolved through the provider registry. */
  provider: text('provider').notNull().default('mock'),
  /** Model id passed to the adapter. Empty means the adapter's default. */
  model: text('model').notNull().default(''),

  /**
   * Spend ceiling for the current period, in millionths of a dollar.
   *
   * Not cents: a single call can cost a small fraction of one, and rounding
   * every call up to a cent would overstate a month's usage by more than the
   * usage itself. This is a meter, not an accounting figure — money that
   * reaches the ledger is still integer cents everywhere else.
   */
  monthlyCeilingMicros: bigint('monthly_ceiling_micros', { mode: 'number' })
    .notNull()
    .default(2_000_000),

  /** Calls per hour per company, a floor under a runaway loop. */
  hourlyRequestLimit: integer('hourly_request_limit').notNull().default(120),

  /**
   * Features switched off individually, by enum value.
   *
   * Spec §12 asks for feature-level metering; being able to disable one
   * capability without losing the rest is the other half of that.
   */
  disabledFeatures: jsonb('disabled_features').$type<string[]>().notNull().default([]),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
})

/**
 * The usage ledger (spec §12).
 *
 * Append-only, like the audit log, and for the same reason: it is the record
 * that answers "what did this cost, and what did it do". A row is written for
 * every call, including the ones that never reached a provider.
 */
export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Null for a scheduled or system-initiated call. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    feature: aiFeatureEnum('feature').notNull(),
    promptKey: text('prompt_key').notNull(),
    promptVersion: integer('prompt_version').notNull(),

    provider: text('provider').notNull(),
    model: text('model').notNull(),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Tokens served from the provider's cache, billed at a lower rate. */
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),

    /** Estimated cost in millionths of a dollar — see `aiSettings`. */
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),

    latencyMs: integer('latency_ms').notNull().default(0),
    outcome: aiOutcomeEnum('outcome').notNull(),
    /** Why a call failed, or why it was blocked. Never the prompt itself. */
    detail: text('detail'),

    /** True when this call was answered from our own cache, unbilled. */
    cacheHit: boolean('cache_hit').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_requests_company_created_idx').on(table.companyId, table.createdAt),
    index('ai_requests_company_feature_idx').on(table.companyId, table.feature),
  ],
)

/**
 * A proposal awaiting a person's decision (spec §11 "User approval required
 * for material accounting actions", §12 human-in-the-loop).
 *
 * The payload is whatever the feature's schema validated — a category, a
 * draft, a set of rule conditions. Nothing here has taken effect.
 */
export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id').references(() => aiRequests.id, { onDelete: 'set null' }),

    feature: aiFeatureEnum('feature').notNull(),
    /** What the suggestion is about — 'bank_transaction', 'proposal', … */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),

    status: aiSuggestionStatusEnum('status').notNull().default('pending'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    /** The model's own confidence, in basis points. Advisory only. */
    confidenceBp: integer('confidence_bp'),
    /** One or two sentences the reviewer reads before deciding. */
    rationale: text('rationale'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Free text a reviewer may leave when rejecting. */
    decisionNote: text('decision_note'),
  },
  (table) => [
    index('ai_suggestions_company_status_idx').on(table.companyId, table.status),
    index('ai_suggestions_entity_idx').on(table.companyId, table.entityType, table.entityId),
  ],
)

/**
 * The prompt registry (spec §12 "Central prompt/template registry with
 * versioning, testing, and rollback").
 *
 * Prompts are data, not string literals scattered through services. Built-in
 * versions are installed from code; a company may add its own version and
 * activate it, and rolling back is activating the previous one — the same
 * shape as the clause library in Company Studio.
 */
export const aiPrompts = pgTable(
  'ai_prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Null for a built-in shipped with the application; set when a company
     * has written its own version of a prompt.
     */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),

    /** Stable identifier, e.g. 'bookkeeping.categorize'. */
    key: text('key').notNull(),
    version: integer('version').notNull(),

    /** What the model is told about its role and constraints. */
    systemPrompt: text('system_prompt').notNull(),
    /** The instruction template, with {{placeholders}} filled at call time. */
    template: text('template').notNull(),

    /** Why this version exists — read when deciding whether to roll back. */
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(false),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ai_prompts_scope_key_version_key').on(table.companyId, table.key, table.version),
    index('ai_prompts_key_idx').on(table.key),
  ],
)
