import { desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries } from '@/db/schema'
import { DomainError } from '@/modules/errors'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { entryWithLines, listPeriods, reverseEntry, voidEntry } from './journal'
import {
  correctionFor,
  mayUse,
  type ClosedPeriod,
  type CorrectableEntry,
  type CorrectionMethod,
  type CorrectionVerdict,
} from './corrections'

/**
 * Correcting a journal entry (spec §2, §13, §19, Phase 51).
 *
 * ## Which void is which
 *
 * There are two, and the difference is the whole safety of this phase.
 *
 * - `voidJournalEntry` is the internal one. A document voids **its own** entry
 *   through it — void an invoice and `receivables/service.ts` voids the entry
 *   behind it in the same transaction, so both halves move together. That must
 *   keep working exactly as it does.
 * - `voidEntry` is the user-initiated one, and it checked a permission and an
 *   open period and nothing else. Its only caller was a server action no
 *   screen had ever called, which is the only reason this has not already gone
 *   wrong: a person could void the entry behind INV-1002 and leave the invoice
 *   claiming $24,000 that Accounts Receivable no longer carried.
 *
 * So the guard goes on the user-initiated path, and the internal one is left
 * alone.
 */

/** A closed period, as the pure core wants it. `reopened` ones do not count. */
async function closedPeriodsFor(ctx: ActorContext): Promise<ClosedPeriod[]> {
  const periods = await listPeriods(ctx)

  return periods
    .filter((period) => period.status === 'closed')
    .map((period) => ({ periodStart: period.periodStart, periodEnd: period.periodEnd }))
}

/** Entry numbers of the reversals already on the books, by what they reverse. */
async function reversalsBySource(ctx: ActorContext): Promise<Map<string, number>> {
  const rows = await db
    .select({
      reversalOfId: journalEntries.reversalOfId,
      entryNumber: journalEntries.entryNumber,
    })
    .from(journalEntries)
    .where(
      scoped(
        ctx,
        journalEntries,
        isNotNull(journalEntries.reversalOfId),
        eq(journalEntries.status, 'posted'),
      ),
    )

  const map = new Map<string, number>()
  for (const row of rows) {
    if (row.reversalOfId) map.set(row.reversalOfId, row.entryNumber)
  }
  return map
}

export type CorrectableRow = CorrectableEntry & {
  memo: string | null
  /** What may be done about it, decided by the pure core. */
  correction: CorrectionVerdict
  /** The entry number of the reversal already posted against it, if any. */
  reversedBy: number | null
}

/**
 * The journal, with what may be done about each entry.
 *
 * The verdict is computed here rather than in the browser because the closed
 * periods and the reversals already posted both live in the database, and a
 * screen that guessed at them would offer buttons the service then refuses.
 */
export async function correctableEntries(
  ctx: ActorContext,
  opts: { limit?: number; today?: string } = {},
): Promise<CorrectableRow[]> {
  requirePermission(ctx, 'accounting:view')

  const today = opts.today ?? new Date().toISOString().slice(0, 10)

  const [rows, closedPeriods, reversals] = await Promise.all([
    db
      .select()
      .from(journalEntries)
      .where(scoped(ctx, journalEntries))
      .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNumber))
      .limit(opts.limit ?? 100),
    closedPeriodsFor(ctx),
    reversalsBySource(ctx),
  ])

  return rows.map((row) => {
    const entry: CorrectableEntry = {
      id: row.id,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      status: row.status === 'void' ? 'void' : 'posted',
      source: row.source,
      sourceType: row.sourceType,
      reversalOfId: row.reversalOfId,
    }

    const reversedBy = reversals.get(row.id) ?? null

    return {
      ...entry,
      memo: row.memo,
      reversedBy,
      correction: correctionFor({ entry, closedPeriods, today, reversedBy }),
    }
  })
}

/**
 * One entry with its lines, and what may be done about it.
 *
 * `entryWithLines` has existed since Phase 2 with **no caller anywhere in
 * `src/app`**, so the journal screen showed a number, a date, a memo and a
 * status and no money at all. An accountant could not read their own ledger.
 */
export async function entryDetail(ctx: ActorContext, entryId: string) {
  requirePermission(ctx, 'accounting:view')

  const detail = await entryWithLines(ctx, entryId)
  if (!detail) return null

  const [closedPeriods, reversals] = await Promise.all([
    closedPeriodsFor(ctx),
    reversalsBySource(ctx),
  ])

  const entry: CorrectableEntry = {
    id: detail.entry.id,
    entryNumber: detail.entry.entryNumber,
    entryDate: detail.entry.entryDate,
    status: detail.entry.status === 'void' ? 'void' : 'posted',
    source: detail.entry.source,
    sourceType: detail.entry.sourceType,
    reversalOfId: detail.entry.reversalOfId,
  }

  const reversedBy = reversals.get(entry.id) ?? null

  return {
    entry: detail.entry,
    lines: detail.lines,
    reversedBy,
    correction: correctionFor({
      entry,
      closedPeriods,
      today: new Date().toISOString().slice(0, 10),
      reversedBy,
    }),
  }
}

export type CorrectionResult = {
  method: CorrectionMethod
  entryNumber: number
  /** The number of the reversing entry, when one was posted. */
  reversalNumber?: number
  message: string
}

/**
 * Corrects one entry, the way the books allow.
 *
 * The method is checked against `mayUse` rather than trusted, because the
 * screen offers a recommendation and this receives whatever arrived on the
 * wire. Both refusals it can produce are ones a person should see: the entry
 * belongs to a document, or the period it falls in has been reported on.
 */
export async function correctEntry(
  ctx: ActorContext,
  input: { entryId: string; method: CorrectionMethod; memo?: string },
): Promise<CorrectionResult> {
  requirePermission(ctx, 'accounting:journal')

  const [row] = await db
    .select()
    .from(journalEntries)
    .where(scoped(ctx, journalEntries, eq(journalEntries.id, input.entryId)))
    .limit(1)

  if (!row) throw new DomainError('That entry is not on these books.')

  const entry: CorrectableEntry = {
    id: row.id,
    entryNumber: row.entryNumber,
    entryDate: row.entryDate,
    status: row.status === 'void' ? 'void' : 'posted',
    source: row.source,
    sourceType: row.sourceType,
    reversalOfId: row.reversalOfId,
  }

  const [closedPeriods, reversals] = await Promise.all([
    closedPeriodsFor(ctx),
    reversalsBySource(ctx),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const reversedBy = reversals.get(entry.id) ?? null

  const permitted = mayUse({
    entry,
    method: input.method,
    closedPeriods,
    today,
    reversedBy,
  })

  if (!permitted.ok) throw new DomainError(permitted.why)

  if (input.method === 'void') {
    await voidEntry(ctx, entry.id)

    return {
      method: 'void',
      entryNumber: entry.entryNumber,
      message: `Entry #${entry.entryNumber} is void. It stays listed, struck through.`,
    }
  }

  // The pure core already worked out where a reversal belongs; asking it again
  // rather than recomputing keeps one answer to the question.
  const verdict = correctionFor({ entry, closedPeriods, today, reversedBy })
  const reversalDate =
    verdict.ok && verdict.method === 'reverse' ? verdict.reversalDate : entry.entryDate

  const reversal = await reverseEntry(
    ctx,
    entry.id,
    reversalDate,
    input.memo || `Reversal of entry #${entry.entryNumber}`,
  )

  return {
    method: 'reverse',
    entryNumber: entry.entryNumber,
    reversalNumber: reversal.entryNumber,
    message:
      `Entry #${entry.entryNumber} is reversed by #${reversal.entryNumber}, dated ` +
      `${reversalDate}. Both stay on the books — that is what makes the correction visible.`,
  }
}
