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
  check,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'

/**
 * Background work and the outbox (spec §18: "background worker/queue for bank
 * sync, document generation, campaign sends, and AI jobs"; "event/outbox
 * pattern for reliable cross-module handoffs").
 *
 * ## Why this is a phase rather than a utility
 *
 * Four ADRs in a row have ended with "the missing piece is a background
 * worker" — the campaign scheduler (0005), the WIP adjusting entry (0007), the
 * review nudge and key pruning (0008), and a remittance reminder (0009). Each
 * time the feature was built to the point where the only thing left was
 * something calling it on a clock, and each time that was deferred.
 *
 * The tables here are the clock, and the record of what it did.
 *
 * ## The property that matters
 *
 * A job runs **at least once**, never exactly once. A worker can be killed
 * between finishing the work and recording that it finished, and no amount of
 * schema prevents that. So every handler must be safe to run twice, which is
 * the same discipline Phase 8 imposed on the mobile client — and this reuses
 * its machinery rather than inventing a second one.
 */

export const jobStatusEnum = pgEnum('background_job_status', [
  /** Waiting for its `run_at`, or waiting for a worker. */
  'queued',
  /** Claimed by a worker. Carries a lock that expires. */
  'running',
  'succeeded',
  /** Failed, and will be retried. */
  'failed',
  /** Out of attempts. A person has to look at it. */
  'dead',
  'cancelled',
])

export const jobCadenceEnum = pgEnum('job_cadence', ['hourly', 'daily', 'weekly', 'monthly'])

/**
 * A unit of background work.
 *
 * `company_id` is nullable, which is the one place in this codebase a row
 * legitimately has no tenant: pruning expired idempotency keys is housekeeping
 * across every company, and pretending it belongs to one of them would be a
 * lie that `scoped()` would then enforce. Every *other* job carries its tenant
 * and the handler runs inside that tenant's context.
 */
export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),

    /** Which handler runs this, e.g. "campaign.send_scheduled". */
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * Optional de-duplication key.
     *
     * A schedule that fires while the previous run is still queued must not
     * stack up a second copy. Unique across the table, so the database
     * arbitrates rather than a read-then-write race.
     */
    dedupeKey: text('dedupe_key'),

    status: jobStatusEnum('status').notNull().default('queued'),

    /** Not before this. Backoff pushes it forward on each failure. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),

    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    /**
     * Higher runs first among jobs that are due.
     *
     * A campaign send behind a thousand pruning jobs is a campaign that goes
     * out tomorrow.
     */
    priority: integer('priority').notNull().default(0),

    /**
     * Which worker holds this, and since when.
     *
     * Both together: a worker that is killed mid-job leaves `running` behind
     * forever without a timestamp to expire it against.
     */
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),

    lastError: text('last_error'),
    result: jsonb('result').$type<Record<string, unknown>>(),

    /** Set when a schedule or an outbox event produced this job. */
    scheduleId: uuid('schedule_id'),
    eventId: uuid('event_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    // The claim query's index: due, queued, best priority first. Every worker
    // runs this every tick, so it is the one query worth an index shaped for.
    claimIdx: index('background_jobs_claim_idx').on(t.status, t.runAt, t.priority),
    companyIdx: index('background_jobs_company_idx').on(t.companyId, t.createdAt),
    kindIdx: index('background_jobs_kind_idx').on(t.kind, t.status),
    dedupeUnique: unique('background_jobs_dedupe_key_unique').on(t.dedupeKey),
    attemptsSane: check('background_jobs_attempts_sane', sql`${t.attempts} >= 0`),
    maxAttemptsSane: check('background_jobs_max_attempts_sane', sql`${t.maxAttempts} >= 1`),
  }),
)

/**
 * A recurring job.
 *
 * Deliberately not cron syntax. A cadence and an hour covers every case this
 * product actually has, and a cron string is a small language nobody validates
 * until it silently never fires. If a real cron requirement turns up, this is
 * the row to add a column to.
 */
export const jobSchedules = pgTable(
  'job_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

    cadence: jobCadenceEnum('cadence').notNull(),
    /** Hour of the day, UTC. Ignored by `hourly`. */
    hourUtc: integer('hour_utc').notNull().default(0),
    /** 0 = Sunday. Used by `weekly` only. */
    dayOfWeek: integer('day_of_week').notNull().default(1),
    /** Used by `monthly` only; clamped to the length of short months. */
    dayOfMonth: integer('day_of_month').notNull().default(1),

    isActive: boolean('is_active').notNull().default(true),

    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('job_schedules_due_idx').on(t.isActive, t.nextRunAt),
    // One schedule per kind per company. A second "daily review nudge" is
    // never what anybody meant.
    kindUnique: unique('job_schedules_company_kind_unique').on(t.companyId, t.kind),
    hourRange: check('job_schedules_hour_range', sql`${t.hourUtc} >= 0 AND ${t.hourUtc} <= 23`),
    dowRange: check('job_schedules_dow_range', sql`${t.dayOfWeek} >= 0 AND ${t.dayOfWeek} <= 6`),
    domRange: check('job_schedules_dom_range', sql`${t.dayOfMonth} >= 1 AND ${t.dayOfMonth} <= 28`),
  }),
)

/**
 * The outbox (spec §18 "event/outbox pattern for reliable cross-module
 * handoffs").
 *
 * ## What it fixes
 *
 * `announceAcceptance` in `modules/crm/acceptance.ts` carries the comment
 * *"failures are swallowed by the caller — a notification is a courtesy, the
 * acceptance is the record"*. That is the right call given the alternative:
 * a push provider having a bad afternoon must not roll back a signed proposal.
 *
 * But swallowing means losing. The client signed, nobody was told, and no
 * trace of the attempt survives.
 *
 * An event row written **inside the acceptance's own transaction** removes the
 * choice. If the acceptance commits, the event exists; if it rolls back, the
 * event never did. Delivery then happens afterwards, with retries, and a
 * failure is visible instead of silent.
 *
 * ## Why this is not the message bus it looks like
 *
 * Handlers are in-process functions in this repository. The table buys
 * durability across a crash and a place to see what happened, not distribution.
 * When a queue server is warranted the relay is the only thing that changes.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** e.g. "proposal.accepted". Past tense: an event is a thing that happened. */
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

    /** What it happened to, for finding every event about one record. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    /** Who caused it, when there was a person. Null for system-caused events. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /** Null until the relay has turned it into jobs. The whole query is this. */
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
    relayAttempts: integer('relay_attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => ({
    // Partial index: the relay only ever asks for unrelayed events, and
    // without `WHERE` this index grows with history rather than with backlog.
    pendingIdx: index('domain_events_pending_idx')
      .on(t.occurredAt)
      .where(sql`${t.relayedAt} IS NULL`),
    companyIdx: index('domain_events_company_idx').on(t.companyId, t.occurredAt),
    entityIdx: index('domain_events_entity_idx').on(t.entityType, t.entityId),
  }),
)

/**
 * Proof a worker is alive.
 *
 * Without this, "nothing in the queue" and "nothing draining the queue" look
 * identical on a dashboard, and the second one is an outage. A worker writes
 * here every tick; the operations page reads the freshness of the newest row.
 */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Cumulative, since this worker started. Reset when it restarts. */
  jobsProcessed: integer('jobs_processed').notNull().default(0),
  hostname: text('hostname'),
})
