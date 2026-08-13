import { pgTable, uuid, text, timestamp, jsonb, index, boolean } from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'

/**
 * Append-only audit log (spec §14, §19). Rows are never updated or deleted:
 * an undo is recorded as a *new* event that points back at the one it
 * reverses, so the history stays a complete record of what happened.
 *
 * Audit rows are written inside the same database transaction as the change
 * they describe, so a change can never be committed without its audit trail.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /**
     * Null only for events with no acting user (system sync jobs). User
     * deletion nulls this rather than removing the row — the event survives.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Denormalized so history stays readable after a user is removed. */
    actorName: text('actor_name'),

    /** Dotted verb, e.g. "transaction.categorize" or "rule.create". */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),

    /** Field-level snapshots. `before` is what undo restores. */
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),

    /** True when this event is itself the undo of another. */
    isUndo: boolean('is_undo').notNull().default(false),
    /** Set on the original event once it has been undone. */
    undoneByEventId: uuid('undone_by_event_id'),
    /** Groups events written by one bulk action so they undo together. */
    batchId: uuid('batch_id'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('audit_events_company_idx').on(t.companyId, t.createdAt),
    entityIdx: index('audit_events_entity_idx').on(t.companyId, t.entityType, t.entityId),
    batchIdx: index('audit_events_batch_idx').on(t.batchId),
  }),
)
