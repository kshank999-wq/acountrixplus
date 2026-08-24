import { createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { idempotencyKeys } from '@/db/schema'
import type { ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'

/**
 * Replay-safe operations (spec §19 "idempotent bank imports and
 * payment/accounting operations").
 *
 * ## The problem this exists for
 *
 * A phone on a train categorizes six transactions, loses signal mid-send, and
 * retries when it comes back. From the device's side, "the request never
 * arrived" and "the request arrived and the response was lost" are the same
 * event: silence. It has to retry, and if retrying can double-post a journal
 * entry then an offline queue is a liability rather than a feature.
 *
 * So every mutation the mobile client can queue carries a client-generated
 * key, and this module makes running it twice indistinguishable from running
 * it once.
 *
 * ## Why the key row is written inside the same transaction
 *
 * The naive shape is: check for the key, run the work, record the key. Two
 * concurrent retries both pass the check, and both post. Writing the key
 * *inside* the operation's own transaction makes the database's unique
 * constraint the arbiter — the second one fails to insert, its transaction
 * rolls back, and no work of its survives.
 *
 * The failed insert is then read back as "somebody else already did this",
 * and the stored result is returned. The loser of the race gets the winner's
 * answer, which is the correct answer.
 *
 * ## Why the request is fingerprinted
 *
 * A key reused with *different* arguments is not a retry — it is a client bug,
 * and silently returning the first result would discard the second request
 * without telling anyone. Comparing a hash of the arguments turns that into a
 * 409 the client can act on.
 */

/** Operations the mobile client is allowed to queue and replay. */
export const REPLAYABLE_OPERATIONS = [
  'transaction.categorize',
  'transaction.exclude',
  'transaction.note',
  'transaction.split',
  'receipt.attach',
  'suggestion.accept',
] as const

export type ReplayableOperation = (typeof REPLAYABLE_OPERATIONS)[number]

export function isReplayableOperation(value: string): value is ReplayableOperation {
  return (REPLAYABLE_OPERATIONS as readonly string[]).includes(value)
}

/** Raised when a key is reused with different arguments. Maps to HTTP 409. */
export class IdempotencyConflictError extends DomainError {
  readonly status = 409
  constructor(readonly key: string) {
    super(
      `Idempotency key ${key} was already used for a different request. ` +
        'Generate a new key for a new operation.',
    )
    this.name = 'IdempotencyConflictError'
  }
}

/**
 * A stable hash of the request arguments.
 *
 * Keys are sorted before hashing, so `{a:1,b:2}` and `{b:2,a:1}` fingerprint
 * identically — a client that serializes its queue in a different key order on
 * retry is still retrying, not sending something new.
 */
export function fingerprint(operation: string, payload: unknown): string {
  return createHash('sha256').update(`${operation}:${stableStringify(payload)}`).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined is absent, not a value: `{a:1}` and `{a:1,b:undefined}` are the
    // same request, and JSON.stringify already drops b.
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
}

export type IdempotentOutcome<T> = {
  result: T
  /** True when this call did the work; false when it replayed a stored result. */
  executed: boolean
}

/**
 * Runs `work` at most once for a given key.
 *
 * `work` receives the transaction the key row is written in, so any database
 * change it makes commits with the key or not at all. A caller that opens its
 * own transaction inside `work` would break that — pass the executor down
 * instead, the same convention `createJournalEntry` and `createInvoice` use.
 */
export async function runOnce<T extends Record<string, unknown>>(
  ctx: ActorContext,
  input: {
    key: string
    operation: ReplayableOperation
    payload: unknown
  },
  work: (tx: Executor) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const requestFingerprint = fingerprint(input.operation, input.payload)

  const existing = await findKey(ctx, input.key)
  if (existing) {
    return replay<T>(existing, input.key, requestFingerprint)
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Inserted first: a concurrent retry that gets here at the same moment
      // fails on the unique constraint before doing any work, rather than
      // after.
      await tx.insert(idempotencyKeys).values({
        companyId: ctx.companyId,
        key: input.key,
        operation: input.operation,
        requestFingerprint,
        userId: ctx.userId,
        result: null,
      })

      const produced = await work(tx)

      await tx
        .update(idempotencyKeys)
        .set({ result: produced })
        .where(
          and(
            eq(idempotencyKeys.companyId, ctx.companyId),
            eq(idempotencyKeys.key, input.key),
          ),
        )

      return produced
    })

    return { result, executed: true }
  } catch (error) {
    // Lost the race. The winner's work is committed; return its answer.
    if (isUniqueViolation(error)) {
      const winner = await findKey(ctx, input.key)
      if (winner) return replay<T>(winner, input.key, requestFingerprint)
    }
    throw error
  }
}

function replay<T>(
  row: typeof idempotencyKeys.$inferSelect,
  key: string,
  requestFingerprint: string,
): IdempotentOutcome<T> {
  if (row.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyConflictError(key)
  }

  // A null result means the winner is still mid-flight — its transaction has
  // inserted the key but not yet committed the outcome. Telling the client to
  // retry is honest; inventing a result would not be.
  if (row.result === null) {
    throw new InFlightError(key)
  }

  return { result: row.result as T, executed: false }
}

/** Raised when a retry arrives while the original is still running. HTTP 409. */
export class InFlightError extends DomainError {
  readonly status = 409
  constructor(readonly key: string) {
    super('That operation is still being processed. Retry in a moment.')
    this.name = 'InFlightError'
  }
}

async function findKey(ctx: ActorContext, key: string) {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(eq(idempotencyKeys.companyId, ctx.companyId), eq(idempotencyKeys.key, key)),
    )
    .limit(1)

  return row ?? null
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  )
}

/**
 * How long a key is honoured.
 *
 * Long enough that a phone left in a drawer over a long weekend still replays
 * safely, short enough that the table does not grow without bound. Past the
 * window a replayed key is treated as a new operation, which is why the window
 * is generous rather than tight.
 */
export const IDEMPOTENCY_RETENTION_DAYS = 14

/** Deletes expired keys. Called by whatever runs maintenance; safe to re-run. */
export async function pruneIdempotencyKeys(before?: Date): Promise<number> {
  const cutoff =
    before ?? new Date(Date.now() - IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const removed = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, cutoff))
    .returning({ id: idempotencyKeys.id })

  return removed.length
}
