import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { domainEvents } from '@/db/schema'
import { enqueue } from './queue'

/**
 * The transactional outbox (spec §18: "event/outbox pattern for reliable
 * cross-module handoffs").
 *
 * ## The exact problem, from this codebase
 *
 * `modules/crm/acceptance.ts` carries this comment above `announceAcceptance`:
 *
 * > Failures are swallowed by the caller. A notification is a courtesy; the
 * > acceptance is the record.
 *
 * That is the right call against the alternative. A push service having a bad
 * afternoon must not roll back a proposal a client just signed.
 *
 * But swallowing is losing. The client signed, the phone stayed quiet, and
 * nothing anywhere records that a notification was even attempted. The
 * comment describes a trade-off that only looks forced because there were two
 * options.
 *
 * ## The third option
 *
 * Write an event row **inside the acceptance's own transaction**. If the
 * acceptance commits, the event exists; if it rolls back, so does the event.
 * They cannot come apart, and no external service is on the critical path of a
 * signature. Delivery happens afterwards, with retries, and a delivery that
 * fails five times is visible on a page instead of gone.
 *
 * ## What this is not
 *
 * Handlers are ordinary functions in this repository. This table buys
 * durability across a crash and a place to look, not distribution. If a real
 * broker is ever warranted, `relayPendingEvents` is the only thing that
 * changes — which is the point of writing the events down rather than calling
 * the subscribers directly.
 */

/**
 * Event types, closed.
 *
 * A union rather than free text so a typo in a publisher is a compile error
 * rather than an event with no subscribers, which is indistinguishable from a
 * working system until somebody asks why nobody was told.
 */
export const EVENT_TYPES = [
  'proposal.accepted',
  'proposal.declined',
  'invoice.paid',
  'opportunity.won',
  'payroll.posted',
  'compliance.expiring',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export type EventInput = {
  type: EventType
  payload?: Record<string, unknown>
  entityType?: string
  entityId?: string
}

/**
 * Records that something happened.
 *
 * **Always pass the executor of the transaction that caused it.** Calling this
 * with the default `db` handle from inside a transaction defeats the entire
 * mechanism: the event commits independently, and a rolled-back change leaves
 * an event claiming it happened. That is worse than the swallowed notification
 * this replaces, because it is wrong rather than merely missing.
 */
export async function recordEvent(
  /**
   * `userId` is nullable, unlike everywhere else in this codebase.
   *
   * The two events that matter most are caused by people who are not signed
   * in: a client accepting a proposal from a public link, and an unsubscribe.
   * Requiring an actor would mean inventing one, and "the system accepted this
   * proposal" is a worse record than an honest null.
   */
  ctx: { companyId: string; userId: string | null },
  input: EventInput,
  exec: Executor = db,
): Promise<{ id: string }> {
  const [event] = await exec
    .insert(domainEvents)
    .values({
      companyId: ctx.companyId,
      type: input.type,
      payload: input.payload ?? {},
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actorId: ctx.userId,
    })
    .returning({ id: domainEvents.id })

  return event
}

/**
 * Which job kinds run for each event type.
 *
 * A plain table rather than a subscription API. Two reasons: the whole set is
 * visible in one screenful, and adding a subscriber is a diff somebody reviews
 * rather than a registration that happens at import time in a file nobody
 * opened.
 */
const SUBSCRIBERS: Record<EventType, string[]> = {
  'proposal.accepted': ['notify.proposal_decided'],
  'proposal.declined': ['notify.proposal_decided'],
  'invoice.paid': ['notify.invoice_paid'],
  'opportunity.won': [],
  'payroll.posted': [],
  'compliance.expiring': ['notify.compliance_expiring'],
}

/**
 * Turns unrelayed events into jobs.
 *
 * ## Why relaying is separate from handling
 *
 * The relay does no work of its own — it only fans an event out into queued
 * jobs and marks it relayed. That keeps the retry semantics in one place: a
 * notification that fails retries as a *job*, with the queue's backoff and
 * dead-lettering, rather than as an event with a second, parallel retry
 * policy that would inevitably disagree with the first.
 *
 * An event with no subscribers is marked relayed immediately. It is not
 * useless — it is a durable record of something that happened, and a
 * subscriber added later is a code change, not a backfill.
 */
export async function relayPendingEvents(limit = 100): Promise<{
  relayed: number
  jobsQueued: number
}> {
  const pending = await db
    .select()
    .from(domainEvents)
    .where(isNull(domainEvents.relayedAt))
    .orderBy(asc(domainEvents.occurredAt))
    .limit(limit)

  let relayed = 0
  let jobsQueued = 0

  for (const event of pending) {
    const kinds = SUBSCRIBERS[event.type as EventType] ?? []

    try {
      for (const kind of kinds) {
        const result = await enqueue({
          kind,
          companyId: event.companyId,
          payload: { ...event.payload, eventId: event.id },
          eventId: event.id,
          // One job per (event, handler), forever. A relay that runs twice
          // because a worker died between enqueueing and marking relayed must
          // not send the notification twice.
          dedupeKey: `event:${event.id}:${kind}`,
        })
        if (result.enqueued) jobsQueued++
      }

      await db
        .update(domainEvents)
        .set({ relayedAt: new Date(), lastError: null })
        .where(eq(domainEvents.id, event.id))

      relayed++
    } catch (error) {
      // Left unrelayed so the next pass tries again. The attempt counter is
      // what stops this being invisible if it never succeeds.
      await db
        .update(domainEvents)
        .set({
          relayAttempts: sql`${domainEvents.relayAttempts} + 1`,
          lastError: error instanceof Error ? error.message : String(error),
        })
        .where(eq(domainEvents.id, event.id))
    }
  }

  return { relayed, jobsQueued }
}

/** Events for a company, newest first. */
export async function listEvents(companyId: string, limit = 50) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.companyId, companyId))
    .orderBy(sql`${domainEvents.occurredAt} DESC`)
    .limit(limit)
}

/** Every event about one record, for the audit story of a proposal or invoice. */
export async function eventsFor(companyId: string, entityType: string, entityId: string) {
  return db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.companyId, companyId),
        eq(domainEvents.entityType, entityType),
        eq(domainEvents.entityId, entityId),
      ),
    )
    .orderBy(asc(domainEvents.occurredAt))
}

/** How many events are waiting to be relayed. Non-zero for long means trouble. */
export async function pendingEventCount(companyId?: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(domainEvents)
    .where(
      and(
        isNull(domainEvents.relayedAt),
        companyId ? eq(domainEvents.companyId, companyId) : undefined,
      ),
    )

  return Number(row?.count ?? 0)
}
