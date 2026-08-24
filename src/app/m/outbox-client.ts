'use client'

import {
  applyOutcome,
  classifyResponse,
  compact,
  discard,
  enqueue,
  networkOutcome,
  readyToSend,
  retryFailed,
  summarize,
  type OutboxEntry,
  type QueueSummary,
} from '@/modules/mobile/outbox'
import type { ReplayableOperation } from '@/modules/mobile/idempotency'
import { messageFor } from '@/modules/errors'

/**
 * The browser half of the offline outbox.
 *
 * A thin shell around `modules/mobile/outbox.ts`, which holds every decision
 * worth testing. This file does the two things that need a browser — talk to
 * IndexedDB and talk to the network — and nothing else. If a change here needs
 * a new rule about ordering or retries, that rule belongs in the pure module.
 */

const DB_NAME = 'accountrix-outbox'
const DB_VERSION = 1
const STORE = 'entries'

/** Opens the queue database, creating the store on first run. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = run(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readQueue(): Promise<OutboxEntry[]> {
  const db = await openDb()
  const entries = await transact<OutboxEntry[]>(db, 'readonly', (store) => store.getAll())
  db.close()
  return entries
}

async function writeQueue(entries: OutboxEntry[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)

  store.clear()
  for (const entry of entries) store.put(entry)

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/**
 * Queues an operation.
 *
 * The id generated here *is* the idempotency key, and it is generated once —
 * every retry of this entry reuses it. That single fact is what makes the
 * queue safe; see `modules/mobile/idempotency.ts` for the other half.
 */
export async function queueOperation(input: {
  operation: ReplayableOperation
  entityId: string
  payload: Record<string, unknown>
}): Promise<QueueSummary> {
  const queue = await readQueue()

  const next = enqueue(queue, {
    id: crypto.randomUUID(),
    operation: input.operation,
    entityId: input.entityId,
    payload: input.payload,
    queuedAt: Date.now(),
  })

  await writeQueue(next)
  return summarize(next)
}

export type DrainResult = {
  summary: QueueSummary
  /** Server state from the sync response, when one came back. */
  state?: unknown
  /** True when nothing was sent because there was nothing ready. */
  idle: boolean
}

let draining = false

/**
 * Sends everything ready and applies the outcomes.
 *
 * Guarded against re-entry: `online`, the visibility change, the periodic
 * timer, and the service worker's sync message can all fire within a second of
 * each other, and two concurrent drains would send the same entry twice. That
 * is survivable — the server is idempotent — but it wastes a round trip on a
 * connection that just came back, which is the worst moment to waste one.
 */
export async function drainOutbox(opts: { installed?: boolean } = {}): Promise<DrainResult> {
  if (draining) {
    return { summary: summarize(await readQueue()), idle: true }
  }
  draining = true

  try {
    const queue = await readQueue()
    const now = Date.now()
    const ready = readyToSend(queue, now)

    // A pull-only sync still happens with an empty queue: opening the app
    // should refresh what it shows even when there is nothing to send.
    const marked = queue.map((entry) =>
      ready.some((candidate) => candidate.id === entry.id)
        ? { ...entry, status: 'sending' as const }
        : entry,
    )
    if (ready.length > 0) await writeQueue(marked)

    let response: Response
    try {
      response = await fetch('/api/mobile/v1/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operations: ready.map((entry) => ({
            key: entry.id,
            operation: entry.operation,
            payload: entry.payload,
          })),
          installed: opts.installed,
        }),
      })
    } catch (error) {
      // No response at all. Every entry goes back to pending with backoff.
      const outcome = networkOutcome(messageFor(error, ''))
      const reverted = marked.map((entry) =>
        ready.some((candidate) => candidate.id === entry.id)
          ? applyOutcome({ ...entry, status: 'pending' }, outcome, now)
          : entry,
      )
      await writeQueue(reverted)
      return { summary: summarize(reverted), idle: ready.length === 0 }
    }

    if (!response.ok) {
      // The whole request failed rather than individual operations — an
      // expired session, a 500. Classify once and apply to everything sent.
      const body = await response.json().catch(() => ({}))
      const outcome = classifyResponse(response.status, body)
      const applied = marked.map((entry) =>
        ready.some((candidate) => candidate.id === entry.id)
          ? applyOutcome({ ...entry, status: 'pending' }, outcome, now)
          : entry,
      )
      await writeQueue(applied)
      return { summary: summarize(applied), idle: false }
    }

    const body = (await response.json()) as {
      results: Array<{ key: string; status: string; error?: string; code?: string }>
      state?: unknown
    }

    const byKey = new Map(body.results.map((result) => [result.key, result]))

    const applied = marked.map((entry) => {
      const result = byKey.get(entry.id)
      if (!result) return entry

      // `replayed` is a success: the server had already done it. That is the
      // whole point of the idempotency key, and treating it as a failure would
      // make the queue retry work that is already committed.
      if (result.status === 'applied' || result.status === 'replayed') {
        return applyOutcome({ ...entry, status: 'pending' }, { kind: 'ok' }, now)
      }

      const outcome = classifyResponse(result.code === 'in_flight' ? 409 : 400, result)
      return applyOutcome({ ...entry, status: 'pending' }, outcome, now)
    })

    const compacted = compact(applied)
    await writeQueue(compacted)

    return { summary: summarize(compacted), state: body.state, idle: ready.length === 0 }
  } finally {
    draining = false
  }
}

/** Puts every parked entry back in the queue. */
export async function retryParked(): Promise<QueueSummary> {
  const queue = retryFailed(await readQueue(), Date.now())
  await writeQueue(queue)
  return summarize(queue)
}

/** Abandons one parked entry. */
export async function discardEntry(id: string): Promise<QueueSummary> {
  const queue = discard(await readQueue(), id)
  await writeQueue(queue)
  return summarize(queue)
}

export { summarize }
export type { OutboxEntry, QueueSummary }
