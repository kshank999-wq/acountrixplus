import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { workerHeartbeats } from '@/db/schema'
import { claimJobs, completeJob, failJob, type ClaimedJob } from './queue'
import { getHandler, UnknownJobKindError, type JobContext } from './registry'
import { relayPendingEvents } from './outbox'
import { runDueSchedules } from './schedules'
import { ensureSchedules } from './defaults'
import { systemActor } from './system-actor'
import './handlers'

/**
 * The worker loop.
 *
 * ## One tick
 *
 * Relay events into jobs, materialize due schedules into jobs, then drain a
 * batch of jobs. In that order, so an event recorded a moment ago and a
 * schedule due a moment ago are both eligible in the same tick rather than
 * waiting for the next one.
 *
 * ## Why a tick is a function
 *
 * `runOnce` does exactly one pass and returns what it did. The tests drive it
 * directly — no timers, no sleeping, no waiting for a loop to maybe have got
 * around to something. A background system that can only be tested by waiting
 * is a background system nobody tests.
 *
 * `runForever` is the thin part on top: call `runOnce`, sleep, repeat.
 */

export type TickResult = {
  /** Schedules that did not exist yet and now do. Zero on a steady state. */
  schedulesInstalled: number
  eventsRelayed: number
  schedulesFired: number
  jobsRun: number
  jobsSucceeded: number
  jobsFailed: number
  jobsDead: number
}

export type RunnerOptions = {
  workerId?: string
  /** How many jobs to claim per tick. */
  batchSize?: number
  /** Injected for the tests, which cannot wait for real backoff. */
  now?: () => Date
}

/**
 * One pass.
 *
 * A handler that throws fails its job and the loop continues. That is the
 * whole error policy, and it is deliberate: one broken job kind must not stop
 * every other kind from running, which is what an unguarded `await` in a loop
 * would produce.
 */
export async function runOnce(options: RunnerOptions = {}): Promise<TickResult> {
  const workerId = options.workerId ?? defaultWorkerId()
  const now = options.now ?? (() => new Date())
  const batchSize = options.batchSize ?? 10

  const result: TickResult = {
    schedulesInstalled: 0,
    eventsRelayed: 0,
    schedulesFired: 0,
    jobsRun: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    jobsDead: 0,
  }

  // Before anything is due, make sure it exists. A company created through the
  // sign-up form got no schedules at all until Phase 33 — see `ensureSchedules`
  // — so this runs first, writes only what is missing, and costs two reads on a
  // steady state.
  const topUp = await ensureSchedules()
  result.schedulesInstalled = topUp.installed

  const relayed = await relayPendingEvents()
  result.eventsRelayed = relayed.relayed

  const scheduled = await runDueSchedules(now())
  result.schedulesFired = scheduled.fired

  const jobs = await claimJobs(workerId, batchSize, now())

  for (const job of jobs) {
    result.jobsRun++
    const outcome = await runJob(job, now())
    if (outcome === 'succeeded') result.jobsSucceeded++
    else if (outcome === 'dead') result.jobsDead++
    else result.jobsFailed++
  }

  await heartbeat(workerId, result.jobsRun, now())

  return result
}

/** Runs one claimed job and records the outcome. Never throws. */
async function runJob(job: ClaimedJob, now: Date): Promise<'succeeded' | 'failed' | 'dead'> {
  const definition = getHandler(job.kind)

  if (!definition) {
    // Retrying cannot fix a missing handler — usually a deploy that removed
    // one while jobs of that kind were still queued. Burning five attempts and
    // an hour of backoff to rediscover that costs time and hides the real
    // problem behind a "retrying" status, so this goes straight to dead.
    await failJob({ ...job, attempts: job.maxAttempts }, new UnknownJobKindError(job.kind), now)
    return 'dead'
  }

  try {
    const context: JobContext = {
      // A global handler gets no actor at all, rather than one for a company
      // it does not belong to. The type makes a handler that wants tenant data
      // deal with the null instead of assuming.
      actor:
        definition.global || !job.companyId ? null : await systemActor(job.companyId),
      companyId: job.companyId,
      payload: job.payload,
      attempt: job.attempts,
      jobId: job.id,
    }

    if (!definition.global && !job.companyId) {
      throw new Error(
        `Job "${job.kind}" needs a company and has none. Enqueue it with a companyId, or register the handler as global.`,
      )
    }

    const outcome = await definition.handler(context)
    await completeJob(job.id, outcome ?? {}, now)
    return 'succeeded'
  } catch (error) {
    const { willRetry } = await failJob(job, error, now)
    return willRetry ? 'failed' : 'dead'
  }
}

/**
 * Records that this worker is alive.
 *
 * Without it, "the queue is empty" and "nothing is draining the queue" render
 * identically, and the second is an outage that looks like calm.
 */
export async function heartbeat(
  workerId: string,
  processed: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId,
      hostname: hostname(),
      startedAt: now,
      lastSeenAt: now,
      jobsProcessed: processed,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        lastSeenAt: now,
        jobsProcessed: sql`${workerHeartbeats.jobsProcessed} + ${processed}`,
      },
    })
}

export type WorkerStatus = {
  workerId: string
  lastSeenAt: Date
  startedAt: Date
  jobsProcessed: number
  hostname: string | null
  /** False once a worker has missed enough ticks to be presumed gone. */
  isAlive: boolean
}

/** How long without a heartbeat before a worker is presumed dead. */
export const HEARTBEAT_STALE_MS = 2 * 60 * 1000

export async function workerStatuses(now: Date = new Date()): Promise<WorkerStatus[]> {
  const rows = await db
    .select()
    .from(workerHeartbeats)
    .orderBy(sql`${workerHeartbeats.lastSeenAt} DESC`)

  return rows.map((row) => ({
    workerId: row.workerId,
    lastSeenAt: row.lastSeenAt,
    startedAt: row.startedAt,
    jobsProcessed: row.jobsProcessed,
    hostname: row.hostname,
    isAlive: now.getTime() - row.lastSeenAt.getTime() < HEARTBEAT_STALE_MS,
  }))
}

/** Forgets workers that have not reported in a long time. */
export async function pruneWorkers(before: Date): Promise<number> {
  const deleted = await db
    .delete(workerHeartbeats)
    .where(sql`${workerHeartbeats.lastSeenAt} < ${before}`)
    .returning({ workerId: workerHeartbeats.workerId })

  return deleted.length
}

function defaultWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
}

/**
 * The long-running loop.
 *
 * Stops on SIGINT and SIGTERM, and **finishes the tick it is in** before
 * exiting. Killing a worker mid-job is survivable — the claim expires and
 * another worker picks it up — but survivable is not free, so a graceful stop
 * is worth the few seconds.
 */
export async function runForever(
  options: RunnerOptions & { intervalMs?: number } = {},
): Promise<void> {
  const workerId = options.workerId ?? defaultWorkerId()
  const intervalMs = options.intervalMs ?? 5_000
  let stopping = false

  const stop = (signal: string) => {
    if (stopping) {
      console.log(`  ${signal} again — exiting now.`)
      process.exit(1)
    }
    stopping = true
    console.log(`  ${signal} received. Finishing the current tick…`)
  }

  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  console.log(`Worker ${workerId} started. Polling every ${intervalMs}ms.`)

  while (!stopping) {
    try {
      const tick = await runOnce({ ...options, workerId })

      if (tick.jobsRun > 0 || tick.schedulesFired > 0 || tick.eventsRelayed > 0) {
        console.log(
          `  ${tick.jobsRun} jobs (${tick.jobsSucceeded} ok, ${tick.jobsFailed} retrying, ` +
            `${tick.jobsDead} dead), ${tick.schedulesFired} scheduled, ${tick.eventsRelayed} events relayed`,
        )
      }
    } catch (error) {
      // The loop itself failing is different from a job failing: usually the
      // database is unreachable. Log and keep ticking rather than exiting,
      // because a worker that dies on a transient outage needs a supervisor
      // this deployment does not have.
      console.error('  Tick failed:', error instanceof Error ? error.message : error)
    }

    if (!stopping) await sleep(intervalMs)
  }

  await db.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, workerId))
  console.log(`Worker ${workerId} stopped.`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
