import type { PartySide } from './addresses'
import type { MergeTally } from './merge'

/**
 * What a merged-away record says about itself (Phase 97).
 *
 * ## The pointer nobody followed
 *
 * Phase 96 gave the losing record a `merged_into_id` and justified the column
 * like this, in its ADR and in `merge.ts`:
 *
 * > It stays, archived, pointing at the record that absorbed it, so a bookmark,
 * > an export or somebody's memory of the old name still lands somewhere that
 * > explains itself.
 *
 * That was false when it was written. The column was set once by `mergeParties`
 * and read by nothing at all, so what somebody actually found was an archived
 * customer with no documents on it and no explanation — strictly worse than
 * before the merge, when it at least had its invoices. The record did not
 * explain itself; it just sat there looking like an abandoned duplicate, which
 * is exactly what Phase 94 exists to report.
 *
 * The correction is in ADR 0096 as well as here, on Phase 91's reasoning: a
 * wrong reason written down is more dangerous than none, because the next
 * person builds on it.
 *
 * ## The judgement: evidence of what moved belongs on the act, not on each
 * thing moved
 *
 * Phase 96 recorded that a merge happened and counted the rows per table. It
 * did not record *which* rows. So the audit trail could say "5 invoices moved"
 * and could not answer "did **this** invoice move" — which is the question
 * somebody actually asks, months later, when a customer says an invoice was
 * never theirs.
 *
 * The alternative was an audit row per document. That is rejected: a merge of
 * two long-standing customers would write hundreds of rows saying the same
 * thing on the same day, burying every other entry in both records' histories
 * and in the company feed. The act is one act. What it touched is a property of
 * the act.
 *
 * So the ids go on the merge event, and because that is a JSON column and not a
 * table, they are **capped** — with the cap stated in the record rather than the
 * list silently ending. A truncated list that does not say it is truncated is
 * worse than a count, because somebody reading it concludes an invoice did not
 * move when it did.
 *
 * Nothing here touches the database or the clock.
 */

/** Where an archived record went, when it went somewhere. */
export type MergedInto = { id: string; name: string }

/**
 * The most document ids one merge event will carry.
 *
 * Enough for any merge a person would do by hand — two customers of a real
 * business, with years of trading each — and small enough that the audit row
 * stays a row rather than a document. Past it, the count is still exact; only
 * the list stops.
 */
export const MOVED_ID_LIMIT = 500

export type MovedRecord = {
  table: string
  rows: number
  /** The ids that moved, up to the cap. */
  ids: string[]
  /**
   * True when there were more than the cap.
   *
   * Carried as its own field rather than left to be inferred from
   * `ids.length === MOVED_ID_LIMIT`, because that inference is wrong for a
   * merge of exactly 500 and silently wrong is the failure this exists to
   * prevent.
   */
  truncated: boolean
}

/** Packs what moved into what the audit event will hold. */
export function movedRecordFor(input: { table: string; ids: string[] }): MovedRecord {
  return {
    table: input.table,
    rows: input.ids.length,
    ids: input.ids.slice(0, MOVED_ID_LIMIT),
    truncated: input.ids.length > MOVED_ID_LIMIT,
  }
}

/** The tally Phase 96's preview and notice already speak in. */
export function tallyOf(moved: MovedRecord[]): MergeTally[] {
  return moved.map(({ table, rows }) => ({ table, rows }))
}

/**
 * Whether the trail can answer "did this document move".
 *
 * The honest answer for a truncated record is *we do not know from here*, and
 * saying so is the point of carrying `truncated` at all.
 */
export function movedIdsAreComplete(moved: MovedRecord[]): boolean {
  return moved.every((one) => !one.truncated)
}

const NOUN: Record<PartySide, string> = { customer: 'customer', vendor: 'supplier' }

/**
 * What the archived row says, in place of a bare "archived".
 *
 * Names the surviving record, because "merged" on its own leaves somebody
 * exactly where the missing pointer left them: knowing something happened and
 * not where to look.
 */
export function describeArchived(input: {
  side: PartySide
  isActive: boolean
  mergedInto: MergedInto | null
}): string | null {
  if (input.isActive) return null
  if (!input.mergedInto) return 'archived'

  return `merged into ${input.mergedInto.name}`
}

/**
 * The line on the surviving record's own history entry.
 *
 * Phase 96 recorded the merge on both records and this is the sentence for the
 * one that stayed: without it, its history begins mid-story with documents that
 * were never raised against it.
 */
export function describeAbsorbed(input: {
  side: PartySide
  loserName: string
  moved: MergeTally[]
}): string {
  const total = input.moved.reduce((sum, one) => sum + one.rows, 0)
  const noun = NOUN[input.side]

  return total === 0
    ? `Absorbed ${input.loserName}, a ${noun} with nothing on it.`
    : `Absorbed ${input.loserName}, and ${total} record${total === 1 ? '' : 's'} with it.`
}
