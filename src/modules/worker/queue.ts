import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { backgroundJobs } from '@/db/schema'
import { CLAIM_TIMEOUT_MS, nextAttemptAt } from './backoff'

/**
 * The queue (spec §18).
 *
 * ## At least once, never exactly once
 *
 * This is the only promise the queue makes, and stating it plainly is more
 * useful than the machinery below. A worker can be killed in the window
 * between finishing the work and recording that it finished. No schema closes
 * that window — the work and the record of it are on opposite sides of a
 * commit no matter how they are arranged.
 *
 * So: **every handler must be safe to run twice.** Phase 8 already imposed
 * that discipline on the mobile client, and the handlers here reuse its
 * idempotency machinery rather than inventing a second kind.
 *
 * The alternative — trying for exactly-once — is a well-known way to build
 * something that is neither.
 */

export type EnqueueInput = {
  kind: string
  /** Null for housekeeping that spans every tenant. */
  companyId?: string | null
  payload?: Record<string, unknown>
  /** Not before this. Defaults to now. */
  runAt?: Date
  maxAttempts?: number
  priority?: number
  /**
   * De-duplication key. A second enqueue with the same key while the first is
   * still queued or running is dropped rather than stacked.
   */
  dedupeKey?: string
  scheduleId?: string
  eventId?: string
}

export type EnqueueResult = {
  id: string | null
  /** False when a dedupe key meant this was already queued. */
  enqueued: boolean
}

/**
 * Adds a job.
 *
 * Takes an executor, because the point of most enqueues is to be in the same
 * transaction as the change that justified them — the same reasoning as the
 * outbox, applied one level down.
 *
 * De-duplication is enforced by the unique index rather than by reading first.
 * Two schedule ticks racing both pass a `SELECT ... WHERE NOT EXISTS`; only one
 * survives an `INSERT`.
 */
export async function enqueue(
  input: EnqueueInput,
  exec: Executor = db,
): Promise<EnqueueResult> {
  const rows = await exec
    .insert(backgroundJobs)
    .values({
      companyId: input.companyId ?? null,
      kind: input.kind,
      payload: input.payload ?? {},
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
      priority: input.priority ?? 0,
      dedupeKey: input.dedupeKey ?? null,
      scheduleId: input.scheduleId ?? null,
      eventId: input.eventId ?? null,
    })
    // The conflict target is the dedupe key, and doing nothing on conflict is
    // the whole feature: "already queued" is success, not an error.
    .onConflictDoNothing({ target: backgroundJobs.dedupeKey })
    .returning({ id: backgroundJobs.id })

  return rows.length > 0 ? { id: rows[0].id, enqueued: true } : { id: null, enqueued: false }
}

export type ClaimedJob = {
  id: string
  companyId: string | null
  kind: string
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

/**
 * Claims up to `limit` due jobs for this worker.
 *
 * ## `FOR UPDATE SKIP LOCKED`
 *
 * This is the load-bearing line. Two workers polling the same queue would
 * otherwise either block on each other (`FOR UPDATE` alone — the second waits
 * for the first's transaction) or hand the same job to both (no locking at
 * all). `SKIP LOCKED` makes the second worker step over rows the first has
 * taken and claim different ones, which is what "add another worker and it
 * goes faster" requires.
 *
 * ## Stealing an expired claim
 *
 * A worker killed mid-job leaves a row in `running` that nothing would ever
 * reclaim. The `OR` in the predicate lets a job whose lock has aged past
 * `CLAIM_TIMEOUT_MS` be taken again. That is a deliberate second execution —
 * safe only because handlers tolerate it, which is the same reason the queue
 * can promise at-least-once at all.
 */
export async function claimJobs(
  workerId: string,
  limit = 5,
  now: Date = new Date(),
): Promise<ClaimedJob[]> {
  // Bound as ISO text and cast in SQL rather than as `Date`: postgres-js
  // serializes parameters itself and rejects a Date inside a raw template,
  // where drizzle's query builder would have converted it. Raw SQL means
  // handling the driver's parameter rules too.
  const nowIso = now.toISOString()
  const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString()

  const rows = await db.execute(sql`
    WITH claimed AS (
      SELECT id
      FROM ${backgroundJobs}
      WHERE run_at <= ${nowIso}::timestamptz
        AND (
          status IN ('queued', 'failed')
          OR (status = 'running' AND (locked_at IS NULL OR locked_at < ${staleBefore}::timestamptz))
        )
      ORDER BY priority DESC, run_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${backgroundJobs} AS j
    SET status = 'running',
        locked_by = ${workerId},
        locked_at = ${nowIso}::timestamptz,
        started_at = COALESCE(j.started_at, ${nowIso}::timestamptz),
        attempts = j.attempts + 1,
        updated_at = ${nowIso}::timestamptz
    FROM claimed
    WHERE j.id = claimed.id
    RETURNING j.id, j.company_id, j.kind, j.payload, j.attempts, j.max_attempts
  `)

  return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    kind: String(row.kind),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  }))
}

/** Records that a job finished. */
export async function completeJob(
  jobId: string,
  result: Record<string, unknown> = {},
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({
      status: 'succeeded',
      result,
      lockedBy: null,
      lockedAt: null,
      lastError: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(backgroundJobs.id, jobId))
}

/**
 * Records that a job failed, and decides whether it gets another go.
 *
 * A job out of attempts becomes `dead` rather than being deleted or retried
 * forever. Both alternatives are worse: deleting destroys the evidence of why,
 * and retrying forever turns one broken job into a permanent load that hides
 * the healthy queue behind it.
 */
export async function failJob(
  job: { id: string; attempts: number; maxAttempts: number },
  error: unknown,
  now: Date = new Date(),
  random: () => number = Math.random,
): Promise<{ willRetry: boolean; nextRunAt: Date | null }> {
  const message = error instanceof Error ? error.message : String(error)
  const exhausted = job.attempts >= job.maxAttempts

  if (exhausted) {
    await db
      .update(backgroundJobs)
      .set({
        status: 'dead',
        lastError: truncate(message),
        lockedBy: null,
        lockedAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(backgroundJobs.id, job.id))

    return { willRetry: false, nextRunAt: null }
  }

  const runAt = nextAttemptAt(job.attempts, now, random)

  await db
    .update(backgroundJobs)
    .set({
      status: 'failed',
      lastError: truncate(message),
      runAt,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(eq(backgroundJobs.id, job.id))

  return { willRetry: true, nextRunAt: runAt }
}

/**
 * Error messages are stored, and a stack trace from a driver can be enormous.
 * A column that occasionally holds a megabyte makes every listing query slow
 * for the sake of detail nobody reads past the first lines of.
 */
function truncate(message: string, limit = 2_000): string {
  return message.length > limit ? `${message.slice(0, limit)}…` : message
}

/**
 * Puts a dead or failed job back in the queue.
 *
 * Resets `attempts`, because a person pressing retry has usually just fixed
 * the thing that broke it, and starting from the old count would give it one
 * grudging attempt before dying again.
 */
export async function retryJob(jobId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({
      status: 'queued',
      attempts: 0,
      runAt: now,
      lockedBy: null,
      lockedAt: null,
      finishedAt: null,
      updatedAt: now,
    })
    .where(and(eq(backgroundJobs.id, jobId), inArray(backgroundJobs.status, ['dead', 'failed'])))
}

export async function cancelJob(jobId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({ status: 'cancelled', lockedBy: null, lockedAt: null, finishedAt: now, updatedAt: now })
    .where(
      and(eq(backgroundJobs.id, jobId), inArray(backgroundJobs.status, ['queued', 'failed', 'dead'])),
    )
}

export type JobFilter = {
  companyId?: string
  status?: Array<'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled'>
  kind?: string
  limit?: number
}

/** Jobs for the operations page. Not tenant-scoped by itself — callers scope it. */
export async function listJobs(filter: JobFilter = {}) {
  return db
    .select()
    .from(backgroundJobs)
    .where(
      and(
        filter.companyId
          ? or(
              eq(backgroundJobs.companyId, filter.companyId),
              // Housekeeping jobs have no tenant, and hiding them from every
              // company means nobody ever sees them fail.
              isNull(backgroundJobs.companyId),
            )
          : undefined,
        filter.status?.length ? inArray(backgroundJobs.status, filter.status) : undefined,
        filter.kind ? eq(backgroundJobs.kind, filter.kind) : undefined,
      ),
    )
    .orderBy(desc(backgroundJobs.createdAt))
    .limit(filter.limit ?? 50)
}

export type QueueCounts = Record<string, number>

/** How many jobs sit in each state. */
export async function queueCounts(companyId?: string): Promise<QueueCounts> {
  const rows = await db
    .select({
      status: backgroundJobs.status,
      count: sql<string>`count(*)`,
    })
    .from(backgroundJobs)
    .where(
      companyId
        ? or(eq(backgroundJobs.companyId, companyId), isNull(backgroundJobs.companyId))
        : undefined,
    )
    .groupBy(backgroundJobs.status)

  // Every state present with a zero rather than absent. A dashboard reading
  // `counts.dead` and getting `undefined` renders "NaN dead" — the exact bug
  // Phase 8 shipped once already.
  const counts: QueueCounts = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    cancelled: 0,
  }

  for (const row of rows) counts[row.status] = Number(row.count)
  return counts
}

/** The oldest thing still waiting, which is the number that says "behind". */
export async function oldestQueuedAt(companyId?: string): Promise<Date | null> {
  const [row] = await db
    .select({ runAt: backgroundJobs.runAt })
    .from(backgroundJobs)
    .where(
      and(
        inArray(backgroundJobs.status, ['queued', 'failed']),
        lte(backgroundJobs.runAt, new Date()),
        companyId
          ? or(eq(backgroundJobs.companyId, companyId), isNull(backgroundJobs.companyId))
          : undefined,
      ),
    )
    .orderBy(asc(backgroundJobs.runAt))
    .limit(1)

  return row?.runAt ?? null
}

/**
 * Deletes finished jobs older than a cutoff.
 *
 * `dead` is never swept. A job nobody retried is a job nobody looked at, and
 * quietly deleting the evidence a fortnight later means the failure is
 * discovered by its consequences instead.
 */
export async function pruneFinishedJobs(before: Date): Promise<number> {
  const deleted = await db
    .delete(backgroundJobs)
    .where(
      and(
        inArray(backgroundJobs.status, ['succeeded', 'cancelled']),
        lte(backgroundJobs.finishedAt, before),
      ),
    )
    .returning({ id: backgroundJobs.id })

  return deleted.length
}
