/**
 * The offline outbox (spec §3 mobile workflow, §18 PWA, §19 idempotency).
 *
 * ## What this file is, and what it deliberately is not
 *
 * Everything here is a pure function over plain data. There is no IndexedDB,
 * no `fetch`, and no `window` — those live in `app/m/outbox-client.ts`, which
 * is a thin shell around these functions.
 *
 * The split is not tidiness. The parts of an offline queue that go wrong are
 * the ordering rules, the retry policy, and the decision about which failures
 * are worth retrying — and every one of those is a decision about a piece of
 * data, testable in milliseconds. The parts that need a browser are `await
 * store.put()` and `await fetch()`, which are not where the bugs are.
 *
 * ## The one rule that matters
 *
 * A queued operation carries a key generated when it was *queued*, not when it
 * is sent. Retrying reuses it. That is what makes the server's idempotency
 * table able to tell a retry from a new request — see
 * `modules/mobile/idempotency.ts`.
 */

import type { ReplayableOperation } from './idempotency'

export type OutboxStatus = 'pending' | 'sending' | 'failed' | 'done'

export type OutboxEntry = {
  /** Also the idempotency key. Generated once, at enqueue. */
  id: string
  operation: ReplayableOperation
  payload: Record<string, unknown>
  /** The entity this operates on, for collapsing supersedable duplicates. */
  entityId: string
  status: OutboxStatus
  attempts: number
  /** Epoch millis. Queue order is by this, so operations replay in order. */
  queuedAt: number
  /** Epoch millis before which this entry must not be retried. */
  nextAttemptAt: number
  lastError?: string
}

/**
 * How many times an entry is retried before it is parked.
 *
 * Parked, not dropped: an operation somebody performed and that never landed
 * is something they need to be told about, and a queue that silently discards
 * work is worse than one that stops.
 */
export const MAX_ATTEMPTS = 6

/** Backoff in milliseconds by attempt number: ~1s, 2s, 8s, 30s, 2m, 5m. */
const BACKOFF_MS = [1_000, 2_000, 8_000, 30_000, 120_000, 300_000]

export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
}

/**
 * Operations where a later entry replaces an earlier one for the same entity.
 *
 * Categorizing a transaction three times offline should send the answer the
 * person settled on, not all three. Notes are the same. Splits are not
 * collapsible in general, but a split *is* the whole state of a transaction's
 * lines, so the last one wins too.
 *
 * `receipt.attach` is absent on purpose: two photos of two receipts are two
 * attachments, and collapsing them would throw one away.
 */
const SUPERSEDING_OPERATIONS = new Set<ReplayableOperation>([
  'transaction.categorize',
  'transaction.note',
  'transaction.split',
  'transaction.exclude',
])

export function supersedes(operation: ReplayableOperation): boolean {
  return SUPERSEDING_OPERATIONS.has(operation)
}

/**
 * Adds an entry, collapsing anything it supersedes.
 *
 * Only *pending* entries are collapsed. One already in flight has possibly
 * reached the server, so removing it locally would lose the ability to reason
 * about what the server did with it — it is left alone and the new entry
 * queues behind it.
 */
export function enqueue(
  queue: OutboxEntry[],
  entry: Omit<OutboxEntry, 'status' | 'attempts' | 'nextAttemptAt'>,
): OutboxEntry[] {
  const next: OutboxEntry = {
    ...entry,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: entry.queuedAt,
  }

  if (!supersedes(entry.operation)) return [...queue, next]

  const kept = queue.filter(
    (existing) =>
      !(
        existing.status === 'pending' &&
        existing.operation === entry.operation &&
        existing.entityId === entry.entityId
      ),
  )

  return [...kept, next]
}

/**
 * The entries ready to send, oldest first.
 *
 * At most one per entity. Two operations on the same transaction have to go in
 * order — a categorize followed by a note must not race, or the note can land
 * on a transaction the server has not categorized yet and the audit trail
 * reads backwards.
 */
export function readyToSend(queue: OutboxEntry[], now: number): OutboxEntry[] {
  const claimed = new Set<string>()
  const ready: OutboxEntry[] = []

  for (const entry of [...queue].sort((a, b) => a.queuedAt - b.queuedAt)) {
    if (entry.status === 'done') continue

    // An entity with anything in flight or parked is blocked: sending past it
    // would reorder the person's decisions.
    if (entry.status === 'sending' || entry.status === 'failed') {
      claimed.add(entry.entityId)
      continue
    }
    if (claimed.has(entry.entityId)) continue
    if (entry.nextAttemptAt > now) {
      claimed.add(entry.entityId)
      continue
    }

    claimed.add(entry.entityId)
    ready.push(entry)
  }

  return ready
}

/**
 * What a send outcome does to an entry.
 *
 * The interesting case is `permanent`. A 4xx that is not a timeout or a
 * conflict means the server understood the request and refused it — retrying
 * will refuse it again, so retrying is just a slower way to fail. Those are
 * parked immediately rather than after six attempts.
 */
export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'retry'; error: string }
  | { kind: 'permanent'; error: string }

export function applyOutcome(
  entry: OutboxEntry,
  outcome: SendOutcome,
  now: number,
): OutboxEntry {
  if (outcome.kind === 'ok') {
    return { ...entry, status: 'done', attempts: entry.attempts + 1, lastError: undefined }
  }

  const attempts = entry.attempts + 1

  if (outcome.kind === 'permanent' || attempts >= MAX_ATTEMPTS) {
    return { ...entry, status: 'failed', attempts, lastError: outcome.error }
  }

  return {
    ...entry,
    status: 'pending',
    attempts,
    nextAttemptAt: now + backoffFor(attempts),
    lastError: outcome.error,
  }
}

/**
 * Classifies an HTTP response into an outcome.
 *
 * 409 is the subtle one. The server returns it both for "that idempotency key
 * was used with different arguments" (a client bug — permanent) and for "the
 * original is still in flight" (retry in a moment). They are told apart by the
 * error code in the body, because guessing wrong either loses work or retries
 * forever.
 */
export function classifyResponse(
  status: number,
  body?: { error?: string; code?: string },
): SendOutcome {
  if (status >= 200 && status < 300) return { kind: 'ok' }

  if (status === 409 && body?.code === 'in_flight') {
    return { kind: 'retry', error: body.error ?? 'Still processing.' }
  }

  // 408 and 429 are explicitly "try again"; 5xx is the server having a bad
  // time, which is usually temporary.
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: 'retry', error: body?.error ?? `Server returned ${status}.` }
  }

  // Everything else in 4xx: the server understood and refused. A closed
  // accounting period, a deleted transaction, a permission that was taken
  // away. Retrying cannot help.
  return { kind: 'permanent', error: body?.error ?? `Request failed with ${status}.` }
}

/** A network error — no response at all. Always worth retrying. */
export function networkOutcome(message: string): SendOutcome {
  return { kind: 'retry', error: message || 'No connection.' }
}

export type QueueSummary = {
  pending: number
  sending: number
  failed: number
  total: number
  /** True when there is anything the person should be told about. */
  needsAttention: boolean
}

export function summarize(queue: OutboxEntry[]): QueueSummary {
  const live = queue.filter((entry) => entry.status !== 'done')
  const pending = live.filter((entry) => entry.status === 'pending').length
  const sending = live.filter((entry) => entry.status === 'sending').length
  const failed = live.filter((entry) => entry.status === 'failed').length

  return {
    pending,
    sending,
    failed,
    total: live.length,
    needsAttention: failed > 0,
  }
}

/** Clears completed entries. Called after a successful drain. */
export function compact(queue: OutboxEntry[]): OutboxEntry[] {
  return queue.filter((entry) => entry.status !== 'done')
}

/** Puts a parked entry back in the queue, for a "try again" button. */
export function retryFailed(queue: OutboxEntry[], now: number): OutboxEntry[] {
  return queue.map((entry) =>
    entry.status === 'failed'
      ? { ...entry, status: 'pending' as const, attempts: 0, nextAttemptAt: now }
      : entry,
  )
}

/** Drops a parked entry the person has decided to abandon. */
export function discard(queue: OutboxEntry[], id: string): OutboxEntry[] {
  return queue.filter((entry) => entry.id !== id)
}
