import { and, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { bankTransactions, financialAccounts, journalLines } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import { reasonFor } from '@/modules/corrections/vocabulary'
import { bankTransactionFunctional } from '@/modules/fx/carriers'
import { mayRestate, restatement } from '@/modules/fx/restate'
import { createJournalEntry, entryForSource, type JournalLineInput } from './journal'

/**
 * Putting a posting right that went into the books at the wrong rate
 * (Phase 130).
 *
 * ADR 0127, ADR 0128 and ADR 0129 each end by saying a repair is a dated
 * correction and then declining to build one. This is the correction. The
 * decision about *how* was already made three times over and is kept exactly:
 *
 * - **A second entry, not a re-post.** The original stays where it is.
 *   Rewriting it is the defect Phase 129 stopped, and it would make a period
 *   somebody has already reported on change without saying so.
 * - **Dated when the decision is made**, not when the money moved. That is what
 *   makes it a correction rather than a quiet edit, and it is what lets Phase
 *   92's closed-period machinery refuse it without a second rule here.
 * - **With a reason.** `posting.restate` reaches `restates_the_past`, and
 *   `mustSayWhy` asks for one because that reach is not `internal`.
 */

/** What a restatement did, for the notice afterwards. */
export type RestatementResult = {
  entryId: string
  /** The correcting entry's own magnitude, signed against the original. */
  deltaCents: number
  /** What the books carried before, and what they carry now. */
  fromCents: number
  toCents: number
}

export type RestateInput = {
  transactionId: string
  /** What a person says the movement should have been converted at. */
  toRateMillionths: number
  reason: string
  /** The day the decision is made. Never the day the money moved. */
  correctionDate: string
}

export async function restatePosting(
  ctx: ActorContext,
  input: RestateInput,
): Promise<RestatementResult> {
  requirePermission(ctx, 'accounting:journal')

  const verdict = reasonFor({ kind: 'posting.restate', reason: input.reason })
  if (!verdict.ok) throw new DomainError(verdict.why)

  return db.transaction(async (tx) => {
    const [transaction] = await tx
      .select()
      .from(bankTransactions)
      .where(
        scoped(ctx, bankTransactions, eq(bankTransactions.id, input.transactionId)),
      )
      .limit(1)

    if (!transaction) throw missing('transaction')

    const allowed = mayRestate({
      rateMillionths: transaction.rateMillionths,
      functionalAmountCents: transaction.functionalAmountCents,
    })
    if (!allowed.ok) throw new DomainError(allowed.why)

    const entry = await entryForSource(ctx, 'bank_transaction', transaction.id, tx)
    if (!entry) {
      throw new DomainError(
        'The entry this transaction posted is no longer in the books, so there is nothing to ' +
          'restate. Re-categorise it and it will post again at the rate it carries.',
      )
    }

    const glAccountId = await bankGlAccount(transaction.financialAccountId, tx)

    const lines = await tx
      .select({
        chartAccountId: journalLines.chartAccountId,
        debitCents: journalLines.debitCents,
        creditCents: journalLines.creditCents,
        projectId: journalLines.projectId,
        costCodeId: journalLines.costCodeId,
      })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.journalEntryId, entry.id),
          eq(journalLines.companyId, ctx.companyId),
        ),
      )
      .orderBy(journalLines.sortOrder)

    // The bank's own line is the movement; everything else is what it was
    // spent on. A split has several of the second and exactly one of the first.
    const categoryLines = lines.filter((line) => line.chartAccountId !== glAccountId)
    const bankLines = lines.filter((line) => line.chartAccountId === glAccountId)

    if (bankLines.length !== 1 || categoryLines.length === 0) {
      throw new DomainError(
        'This entry is not the shape the bank feed posts, so restating it would be guessing at ' +
          'what the parts mean. Correct it with a journal entry instead.',
      )
    }

    const magnitudeOf = (line: { debitCents: number; creditCents: number }) =>
      line.debitCents + line.creditCents

    const decided = restatement({
      categoryCents: categoryLines.map(magnitudeOf),
      fromCents: magnitudeOf(bankLines[0]),
      toCents: Math.abs(
        bankTransactionFunctional(transaction.amountCents, input.toRateMillionths) as number,
      ),
    })
    if (!decided.ok) throw new DomainError(decided.why)

    const { categoryDeltas, deltaCents, fromCents, toCents } = decided.restatement

    // Each line keeps the side it was posted on. A negative delta therefore
    // posts on the opposite side rather than a negative amount, because a
    // journal line carries a magnitude and a side, never a signed figure.
    const correctingLines: JournalLineInput[] = categoryLines.map((line, index) => {
      const delta = categoryDeltas[index]
      const dimensions = { projectId: line.projectId, costCodeId: line.costCodeId }
      const onDebit = line.debitCents > 0 ? delta > 0 : delta < 0

      return onDebit
        ? { chartAccountId: line.chartAccountId, debitCents: Math.abs(delta), ...dimensions }
        : { chartAccountId: line.chartAccountId, creditCents: Math.abs(delta), ...dimensions }
    })

    const bankOnDebit = bankLines[0].debitCents > 0 ? deltaCents > 0 : deltaCents < 0
    correctingLines.push(
      bankOnDebit
        ? { chartAccountId: glAccountId, debitCents: Math.abs(deltaCents) }
        : { chartAccountId: glAccountId, creditCents: Math.abs(deltaCents) },
    )

    const correcting = await createJournalEntry(
      ctx,
      {
        entryDate: input.correctionDate,
        memo: `Restated: ${transaction.merchantName ?? transaction.description}`,
        source: 'adjusting',
        // Its own source type, so `entryForSource(ctx, 'bank_transaction', …)`
        // still finds the original and nothing else has to change.
        sourceType: 'bank_transaction_restatement',
        sourceId: transaction.id,
        lines: correctingLines.filter(
          (line) => (line.debitCents ?? 0) + (line.creditCents ?? 0) > 0,
        ),
      },
      tx,
    )

    // The pair now carries what the books carry, which is what every other
    // paired column in the schema does. Phase 129's rule that a posted rate is
    // fixed stops it changing as a *side effect*; this is the decision itself.
    const functionalAmountCents = transaction.amountCents < 0 ? -toCents : toCents
    await tx
      .update(bankTransactions)
      .set({ rateMillionths: input.toRateMillionths, functionalAmountCents })
      .where(eq(bankTransactions.id, transaction.id))

    await recordAudit(
      ctx,
      {
        action: 'posting.restate',
        entityType: 'bank_transaction',
        entityId: transaction.id,
        before: {
          rate: transaction.rateMillionths,
          functionalAmountCents: transaction.functionalAmountCents,
        },
        after: {
          rate: input.toRateMillionths,
          functionalAmountCents,
          entryId: correcting.id,
          reason: verdict.reason,
        },
      },
      tx,
    )

    return { entryId: correcting.id, deltaCents, fromCents, toCents }
  })
}

/** The GL account a bank account posts through. */
async function bankGlAccount(financialAccountId: string, exec: Executor) {
  const [account] = await exec
    .select({ chartAccountId: financialAccounts.chartAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, financialAccountId))
    .limit(1)

  if (!account) throw missing('financialAccount')
  return account.chartAccountId
}
