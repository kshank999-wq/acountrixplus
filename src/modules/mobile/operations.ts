import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { bankTransactions } from '@/db/schema'
import type { ActorContext } from '@/modules/tenancy/context'
import {
  categorize,
  excludeTransaction,
  setNote,
  splitTransaction,
} from '@/modules/bookkeeping/transactions'
import { acceptCategorization } from '@/modules/ai/bookkeeping'
import { attachReceipt } from './receipts'
import { runOnce, type ReplayableOperation } from './idempotency'

/**
 * The operations the mobile client may queue offline (spec §18 versioned
 * contracts, §19 idempotency).
 *
 * Each one is a thin, validated call into the *same service a browser uses*.
 * The mobile API is a different door into the building, not a different
 * building — a categorization from a phone and one from a laptop produce the
 * same journal entry and the same audit event, attributed to the same person.
 *
 * The registry shape is deliberate: it is the list the route validates
 * against, so a client cannot name an operation that was never meant to be
 * replayable and have the route dispatch it.
 */

const uuid = z.string().uuid()

const schemas = {
  'transaction.categorize': z.object({
    transactionId: uuid,
    chartAccountId: uuid,
    projectId: uuid.nullish(),
    costCodeId: uuid.nullish(),
    rememberVendor: z.boolean().optional(),
  }),
  'transaction.exclude': z.object({
    transactionId: uuid,
    reason: z.string().trim().max(200).optional(),
  }),
  'transaction.note': z.object({
    transactionId: uuid,
    note: z.string().trim().max(2000).nullable(),
  }),
  'transaction.split': z.object({
    transactionId: uuid,
    lines: z
      .array(
        z.object({
          chartAccountId: uuid,
          amountCents: z.number().int(),
          memo: z.string().trim().max(200).optional(),
          projectId: uuid.nullish(),
          costCodeId: uuid.nullish(),
        }),
      )
      .min(2),
  }),
  'receipt.attach': z.object({
    transactionId: uuid,
    assetId: uuid,
  }),
  'suggestion.accept': z.object({
    suggestionId: uuid,
  }),
} satisfies Record<ReplayableOperation, z.ZodTypeAny>

export type OperationName = keyof typeof schemas

export function schemaFor(operation: OperationName) {
  return schemas[operation]
}

/**
 * Runs one operation inside the caller's transaction.
 *
 * Every branch passes `tx` down, so the work and the idempotency key that
 * records it commit together. A branch that opened its own transaction would
 * quietly break the replay guarantee, which is why none of them do.
 */
async function execute(
  ctx: ActorContext,
  operation: OperationName,
  payload: unknown,
  tx: Executor,
): Promise<Record<string, unknown>> {
  switch (operation) {
    case 'transaction.categorize': {
      const input = schemas['transaction.categorize'].parse(payload)
      await categorize(
        ctx,
        input.transactionId,
        input.chartAccountId,
        {
          projectId: input.projectId ?? undefined,
          costCodeId: input.costCodeId ?? undefined,
          // Rule creation is deliberately not replayed from the queue: it
          // writes outside this transaction and creating the same rule twice
          // is a mess to undo. The phone offers the checkbox only when online.
          rememberVendor: false,
        },
        tx,
      )
      return { transactionId: input.transactionId, reviewState: 'categorized' }
    }

    case 'transaction.exclude': {
      const input = schemas['transaction.exclude'].parse(payload)
      await excludeTransaction(ctx, input.transactionId, input.reason, tx)
      return { transactionId: input.transactionId, reviewState: 'excluded' }
    }

    case 'transaction.note': {
      const input = schemas['transaction.note'].parse(payload)
      await setNote(ctx, input.transactionId, input.note, tx)
      return { transactionId: input.transactionId }
    }

    case 'transaction.split': {
      const input = schemas['transaction.split'].parse(payload)
      const result = await splitTransaction(ctx, input.transactionId, input.lines, tx)
      return { transactionId: input.transactionId, lines: result.lines }
    }

    case 'receipt.attach': {
      const input = schemas['receipt.attach'].parse(payload)
      const attached = await attachReceipt(ctx, input.transactionId, input.assetId, tx)
      return { transactionId: input.transactionId, attachmentId: attached.documentId }
    }

    case 'suggestion.accept': {
      const input = schemas['suggestion.accept'].parse(payload)
      const result = await acceptCategorization(ctx, input.suggestionId, tx)
      return { suggestionId: input.suggestionId, ...result }
    }
  }
}

export type OperationResult = {
  operation: OperationName
  key: string
  result: Record<string, unknown>
  /** False when the server replayed a stored result instead of doing the work. */
  executed: boolean
}

/**
 * Validates, then runs an operation at most once for its key.
 *
 * Validation happens *before* `runOnce` so a malformed payload never claims a
 * key — otherwise a client that fixed its bug and retried with the same key
 * would get a fingerprint conflict for its trouble.
 */
export async function applyOperation(
  ctx: ActorContext,
  input: { key: string; operation: OperationName; payload: unknown },
): Promise<OperationResult> {
  const parsed = schemas[input.operation].parse(input.payload)

  const { result, executed } = await runOnce(
    ctx,
    { key: input.key, operation: input.operation, payload: parsed },
    (tx) => execute(ctx, input.operation, parsed, tx),
  )

  return { operation: input.operation, key: input.key, result, executed }
}

/**
 * The transactions a phone should show: everything still awaiting a decision.
 *
 * Kept small on purpose. This is the payload a phone downloads over a mobile
 * connection and holds for offline review, so it carries what a review screen
 * needs and nothing else — no raw provider payload, no attachments, no notes.
 */
export async function reviewQueue(
  ctx: ActorContext,
  opts: { limit?: number } = {},
) {
  return db
    .select({
      id: bankTransactions.id,
      postedDate: bankTransactions.postedDate,
      amountCents: bankTransactions.amountCents,
      description: bankTransactions.description,
      merchantName: bankTransactions.merchantName,
      reviewState: bankTransactions.reviewState,
      chartAccountId: bankTransactions.chartAccountId,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.isTransfer, false),
      ),
    )
    .orderBy(bankTransactions.postedDate)
    .limit(opts.limit ?? 100)
}
