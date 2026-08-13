import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { currentActor, currentSession } from '@/lib/current-user'
import { PermissionError } from '@/modules/permissions'
import { applyOperation, reviewQueue, type OperationName } from '@/modules/mobile/operations'
import {
  IdempotencyConflictError,
  InFlightError,
  isReplayableOperation,
} from '@/modules/mobile/idempotency'
import { touchDevice } from '@/modules/mobile/devices'
import { categorizableAccounts } from '@/modules/coa/service'
import { inboxCounts } from '@/modules/bookkeeping/transactions'

/**
 * The mobile sync endpoint (spec §18 versioned contracts, §19 idempotency).
 *
 *   POST /api/mobile/v1/sync
 *
 * One round trip does both halves of a sync: it drains the client's outbox and
 * returns fresh state. That is deliberate — a phone on a train gets one window
 * of connectivity, and spending it on two round trips is how a sync fails
 * half-done.
 *
 * ## Versioned in the path
 *
 * `v1` is in the URL rather than a header because the client that most needs
 * the guarantee is the one that cannot be updated: an installed PWA with a
 * stale service worker, or a native app on a phone somebody has not opened the
 * store on in a year. A URL that stops existing is a clear failure; a header
 * that is silently ignored is not.
 *
 * ## Authentication is the ordinary session
 *
 * No bearer tokens, no separate mobile credential. The PWA is the same origin
 * as the app, so it carries the same signed httpOnly cookie, and there is no
 * second authentication path to get wrong. A native client would sign in the
 * same way and keep the cookie.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** The contract version. Bumping the path is a breaking change; this is not. */
const API_VERSION = '1.3.0'

const operationSchema = z.object({
  key: z.string().uuid(),
  operation: z.string(),
  payload: z.record(z.unknown()),
})

const requestSchema = z.object({
  /** Queued operations, oldest first. An empty array is a pull-only sync. */
  operations: z.array(operationSchema).max(50).default([]),
  /** True once the PWA reports itself running installed rather than in a tab. */
  installed: z.boolean().optional(),
})

type OperationOutcome = {
  key: string
  status: 'applied' | 'replayed' | 'rejected'
  result?: Record<string, unknown>
  error?: string
  /** Machine-readable, so the client's outbox can tell retry from permanent. */
  code?: string
}

export async function POST(request: NextRequest) {
  const actor = await currentActor()
  if (!actor) {
    return NextResponse.json(
      { error: 'Not signed in.', code: 'unauthenticated' },
      { status: 401 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Expected a JSON body.', code: 'bad_request' },
      { status: 400 },
    )
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' },
      { status: 400 },
    )
  }

  const session = await currentSession()
  if (session?.deviceId) {
    await touchDevice(session.deviceId, { isInstalled: parsed.data.installed })
  }

  /**
   * Operations are applied one at a time, in order, and a failure does not
   * abort the batch.
   *
   * Both halves matter. In order, because two decisions about the same
   * transaction have to land in the order the person made them. Without
   * aborting, because one transaction that was deleted on the web should not
   * strand the other five behind it — the client needs a verdict on each so it
   * can park exactly the one that failed.
   */
  const results: OperationOutcome[] = []

  for (const operation of parsed.data.operations) {
    if (!isReplayableOperation(operation.operation)) {
      results.push({
        key: operation.key,
        status: 'rejected',
        error: `Unknown operation "${operation.operation}".`,
        code: 'unknown_operation',
      })
      continue
    }

    try {
      const outcome = await applyOperation(actor, {
        key: operation.key,
        operation: operation.operation as OperationName,
        payload: operation.payload,
      })

      results.push({
        key: operation.key,
        status: outcome.executed ? 'applied' : 'replayed',
        result: outcome.result,
      })
    } catch (error) {
      results.push({ key: operation.key, ...describeFailure(error) })
    }
  }

  // Fresh state, after the queue has been applied, so the client's next render
  // reflects its own writes without a second request.
  const [queue, accounts, counts] = await Promise.all([
    reviewQueue(actor, { limit: 100 }),
    categorizableAccounts(actor),
    inboxCounts(actor),
  ])

  return NextResponse.json(
    {
      version: API_VERSION,
      syncedAt: new Date().toISOString(),
      results,
      state: {
        transactions: queue,
        accounts: accounts.map((account) => ({
          id: account.id,
          number: account.number,
          name: account.name,
          type: account.type,
        })),
        counts,
      },
    },
    {
      // A sync response is per-user, per-moment state. Nothing may cache it,
      // including the service worker.
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}

/** Maps a thrown error onto the status and code the outbox classifies on. */
function describeFailure(error: unknown): Omit<OperationOutcome, 'key'> {
  if (error instanceof InFlightError) {
    return { status: 'rejected', error: error.message, code: 'in_flight' }
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 'rejected', error: error.message, code: 'key_conflict' }
  }
  if (error instanceof PermissionError) {
    return { status: 'rejected', error: error.message, code: 'forbidden' }
  }

  return {
    status: 'rejected',
    error: error instanceof Error ? error.message : 'That operation failed.',
    code: 'rejected',
  }
}
