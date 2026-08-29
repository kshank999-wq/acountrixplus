import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '@/db'
import { creditNotes, payments, refunds, retainers } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { listPeriods, voidJournalEntry } from '@/modules/ledger/journal'
import { DomainError } from '@/modules/errors'
import type { ClosedPeriod } from './payment-void'
import {
  describeReversal,
  refundVoidability,
  reversalOf,
  type RefundTies,
  type VoidableRefund,
} from './refund-void'

/**
 * Taking a refund back (spec §13, §16, Phase 69).
 *
 * ## One function for three refunds
 *
 * This is the payoff of Phase 68 collapsing `retainer_refunds` and two
 * unrecorded paths into one `refunds` table. A retainer given back, a
 * customer's overpayment returned and a supplier's credit recovered are three
 * different operations to record and **one** operation to undo, because what
 * undoing means is the same in all three: put the balance back, put the
 * functional half back, void the entry, and unwind the realised gap.
 *
 * Written three times it would be three places for the sign to drift.
 *
 * ## The ledger half
 *
 * `voidJournalEntry`, the internal path, inside this transaction — exactly as
 * Phase 52 voids a payment and as `voidDocument` has since Phase 51. It marks
 * the original entry `status = 'void'` and every balance query filters on
 * posted. Nothing is deleted and no mirror entry is posted, so the books keep
 * one answer to whether the refund happened.
 *
 * It also calls `assertPeriodOpen`, which means the closed-period rule is
 * enforced twice: once here with a sentence naming the date, and once in the
 * ledger as the guard of last resort. That is deliberate — the first is for the
 * person, the second is for the books.
 */

async function closedPeriodsFor(ctx: ActorContext): Promise<ClosedPeriod[]> {
  const periods = await listPeriods(ctx)

  return periods
    .filter((period) => period.status === 'closed')
    .map((period) => ({ periodStart: period.periodStart, periodEnd: period.periodEnd }))
}

/**
 * Whether the balance this refund came out of still exists, and what to call it.
 *
 * A retainer has no void of its own, so it is always live; the other two can be
 * cancelled underneath a refund, which is the case the refusal is for.
 */
async function tiesFor(ctx: ActorContext, refund: VoidableRefund): Promise<RefundTies> {
  if (refund.subjectType === 'credit_note') {
    const [note] = await db
      .select({ number: creditNotes.number, status: creditNotes.status })
      .from(creditNotes)
      .where(scoped(ctx, creditNotes, eq(creditNotes.id, refund.subjectId)))
      .limit(1)

    return {
      subjectVoided: note?.status === 'void',
      subjectLabel: note ? `Vendor credit ${note.number}` : 'That credit',
    }
  }

  if (refund.subjectType === 'payment') {
    const [payment] = await db
      .select({ status: payments.status, reference: payments.reference })
      .from(payments)
      .where(scoped(ctx, payments, eq(payments.id, refund.subjectId)))
      .limit(1)

    return {
      subjectVoided: payment?.status === 'void',
      subjectLabel: payment?.reference
        ? `The receipt ${payment.reference}`
        : 'The receipt it came from',
    }
  }

  return { subjectVoided: false, subjectLabel: 'The retainer' }
}

export type RefundRow = VoidableRefund & {
  subjectLabel: string
  journalEntryId: string | null
}

/**
 * The refunds on these books, newest first, with what each one is against.
 *
 * Refunds have never been listed anywhere: they are recorded from the time
 * screen and the credits screen and then vanish into balances, so "did that
 * €500 go back twice?" was a question with no screen behind it — the same gap
 * Phase 52 closed for payments.
 */
export async function listRefunds(
  ctx: ActorContext,
  opts: { limit?: number } = {},
): Promise<RefundRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(refunds)
    .where(scoped(ctx, refunds))
    .orderBy(desc(refunds.refundedOn), desc(refunds.createdAt))
    .limit(opts.limit ?? 50)

  return Promise.all(
    rows.map(async (row) => {
      const refund = toVoidable(row)
      const ties = await tiesFor(ctx, refund)
      return { ...refund, subjectLabel: ties.subjectLabel, journalEntryId: row.journalEntryId }
    }),
  )
}

function toVoidable(row: typeof refunds.$inferSelect): VoidableRefund {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    direction: row.direction,
    refundedOn: row.refundedOn,
    amountCents: row.amountCents,
    currency: row.currency,
    carriedCents: row.carriedCents,
    cashCents: row.cashCents,
    realisedCents: row.realisedCents,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    reference: row.reference,
  }
}

export type VoidRefundResult = {
  refundId: string
  message: string
  balanceCents: number
  currency: string
  realisedCents: number
}

/**
 * Takes a refund back, whichever of the three it was.
 *
 * Every figure comes off the row rather than being re-derived — see
 * `reversalOf` for why that is the decision this phase makes rather than a
 * shortcut it takes.
 */
export async function voidRefund(
  ctx: ActorContext,
  input: { refundId: string; reason?: string },
): Promise<VoidRefundResult> {
  requirePermission(ctx, 'accounting:journal')

  const [row] = await db
    .select()
    .from(refunds)
    .where(scoped(ctx, refunds, eq(refunds.id, input.refundId)))
    .limit(1)

  if (!row) throw new DomainError('That refund is not on these books.')

  const refund = toVoidable(row)
  const [ties, closedPeriods] = await Promise.all([tiesFor(ctx, refund), closedPeriodsFor(ctx)])

  const today = new Date().toISOString().slice(0, 10)
  const verdict = refundVoidability({ refund, ties, closedPeriods, today })
  if (!verdict.ok) throw new DomainError(verdict.why)

  const back = reversalOf(refund)

  await db.transaction(async (tx) => {
    /**
     * Conditional on the refund still being open, so two people pressing at
     * once produce one void and the second finds nothing — the database
     * arbitrates, as it does everywhere in this system two people can act at
     * once.
     */
    const claimed = await tx
      .update(refunds)
      .set({ voidedAt: new Date(), voidedBy: ctx.userId })
      .where(and(eq(refunds.id, row.id), isNull(refunds.voidedAt)))
      .returning({ id: refunds.id })

    if (claimed.length === 0) {
      throw new DomainError('That refund was taken back by somebody else a moment ago.')
    }

    if (row.journalEntryId) {
      await voidJournalEntry(ctx, row.journalEntryId, tx)
    }

    // Both halves of the balance, together — the rule every phase since 63 has
    // kept. `carriedCents` is what left the functional column, so putting the
    // same figure back cannot strand a cent against the face amount.
    if (refund.subjectType === 'retainer') {
      await tx
        .update(retainers)
        .set({
          remainingCents: sqlAdd(retainers.remainingCents, back.balanceCents),
          functionalRemainingCents: sqlAdd(
            retainers.functionalRemainingCents,
            back.carriedCents,
          ),
          updatedAt: new Date(),
        })
        .where(scoped(ctx, retainers, eq(retainers.id, refund.subjectId)))
    } else if (refund.subjectType === 'payment') {
      await tx
        .update(payments)
        .set({
          unappliedCents: sqlAdd(payments.unappliedCents, back.balanceCents),
          functionalUnappliedCents: sqlAdd(
            payments.functionalUnappliedCents,
            back.carriedCents,
          ),
        })
        .where(scoped(ctx, payments, eq(payments.id, refund.subjectId)))
    } else {
      await tx
        .update(creditNotes)
        .set({
          remainingCents: sqlAdd(creditNotes.remainingCents, back.balanceCents),
          functionalRemainingCents: sqlAdd(
            creditNotes.functionalRemainingCents,
            back.carriedCents,
          ),
          // Money is available again, so it is open again — 'applied' is what a
          // spent credit is called, and this one is no longer spent.
          status: 'open',
          updatedAt: new Date(),
        })
        .where(scoped(ctx, creditNotes, eq(creditNotes.id, refund.subjectId)))
    }

    await recordAudit(
      ctx,
      {
        action: 'refund.void',
        entityType: 'refund',
        entityId: row.id,
        after: {
          subjectType: refund.subjectType,
          amountCents: refund.amountCents,
          currency: refund.currency,
          carriedCents: back.carriedCents,
          realisedUnwoundCents: back.realisedCents,
          reason: input.reason ?? null,
        },
      },
      tx,
    )
  })

  return {
    refundId: row.id,
    message: describeReversal(refund),
    balanceCents: back.balanceCents,
    currency: refund.currency,
    realisedCents: back.realisedCents,
  }
}

/**
 * `column + n`, so the restore is one statement.
 *
 * Read-then-write would let two reversals of different refunds against the same
 * balance overwrite each other; letting the database do the addition means the
 * order they arrive in does not matter.
 */
function sqlAdd(column: AnyPgColumn, cents: number): SQL<number> {
  return sql`${column} + ${cents}`
}
