import type { PartySide } from './addresses'
import type { Standing } from './duplicates'

/**
 * Putting two records of one business together (Phase 96).
 *
 * ## The answer that was a shrug
 *
 * Phase 95 taught the customers screen to explain a shared address and say what
 * could be done about it. For two records that had both traded it said
 * **merge** — and the application had no merge. That was honest, and it was a
 * dead end on the case most worth fixing: two live customers on one inbox, both
 * being chased, neither letter saying which account it is about.
 *
 * ## The judgement: a merge that misses a table is worse than no merge
 *
 * Twenty-two places refer to a party — fourteen to a customer, eight to a
 * supplier — and they arrived one phase at a time across ninety-five phases. A
 * merge that repoints twenty-one of them leaves a document attached to a record
 * the screens have hidden. That is not a visible failure somebody can act on;
 * it is an invoice that has quietly stopped existing, found months later by
 * somebody reconciling a balance that will not tie.
 *
 * A merge that refuses to run is a nuisance. A merge that half-runs is data
 * loss, and it is irreversible data loss, because the record it came from has
 * been archived by the same operation.
 *
 * So the references are **named here, in one list**, and a test reads the
 * database's own catalogue and fails when it finds a foreign key this list does
 * not mention. The list is the decision; the test is what stops the decision
 * silently rotting the next time somebody adds a table with a `customer_id` on
 * it. Deriving the list from the catalogue instead would have no such moment —
 * a new column would join the merge without anybody deciding it should.
 *
 * ## The judgement: it cannot be undone, so it must say why
 *
 * Phase 70's vocabulary asks what a correction *reaches*: money, somebody
 * outside, or only our own screens. A merge is the third — nothing leaves, no
 * letter goes out — which under the rule as written would mean no reason is
 * required.
 *
 * That is the rule reaching its edge rather than the merge being an exception.
 * Every other correction on that list can be taken back; this one cannot, and
 * the reason is the only surviving record of **why somebody believed these two
 * were one business**. Nobody can reconstruct that from the ledger afterwards,
 * because afterwards there is only one record. So Phase 70's `Reach` gains a
 * fourth value and its rule gains a clause.
 *
 * ## What a merge is not
 *
 * It is not a deletion. The losing record stays, archived, pointing at the one
 * that absorbed it.
 *
 * This paragraph used to claim the pointer meant such a record "lands somewhere
 * that explains itself". It did not: nothing read `merged_into_id`, so an
 * absorbed record showed as a bare archived row with no documents on it.
 * Phase 97 made the claim true and `merged.ts` records the correction.
 *
 * It is not a guess. Phase 95 refuses to say two records are the same business;
 * so does this. A person decides, and the reason they type is what says so.
 *
 * Nothing here touches the database or the clock.
 */

/** One place a party is referred to. Table and column, as the database has them. */
export type Reference = { table: string; column: string }

/**
 * Every reference a merge must repoint, per side.
 *
 * Verified against the catalogue by a test rather than by reading. If you are
 * adding a table that refers to a customer or a supplier, this is the list it
 * belongs on, and the test will say so before you forget.
 */
export const PARTY_REFERENCES: Record<PartySide, Reference[]> = {
  customer: [
    { table: 'appointments', column: 'customer_id' },
    { table: 'billable_expenses', column: 'customer_id' },
    { table: 'communications', column: 'customer_id' },
    { table: 'contributions', column: 'donor_id' },
    { table: 'credit_notes', column: 'customer_id' },
    { table: 'customer_statements', column: 'customer_id' },
    { table: 'gift_cards', column: 'purchaser_customer_id' },
    { table: 'invoices', column: 'customer_id' },
    { table: 'leases', column: 'customer_id' },
    { table: 'payments', column: 'customer_id' },
    { table: 'recurring_invoices', column: 'customer_id' },
    { table: 'repair_orders', column: 'customer_id' },
    { table: 'retainers', column: 'customer_id' },
    { table: 'vehicles', column: 'customer_id' },
  ],
  vendor: [
    { table: 'bills', column: 'vendor_id' },
    { table: 'communications', column: 'vendor_id' },
    { table: 'credit_notes', column: 'vendor_id' },
    { table: 'fixed_assets', column: 'vendor_id' },
    { table: 'goods_receipts', column: 'vendor_id' },
    { table: 'payments', column: 'vendor_id' },
    { table: 'purchase_orders', column: 'vendor_id' },
    { table: 'subcontractors', column: 'vendor_id' },
  ],
}

/**
 * References that allow one row per party, and so can collide on a merge.
 *
 * `subcontractors` has carried `subcontractors_vendor_unique` since Phase 52. If
 * both suppliers are subcontractors, repointing produces two rows where one is
 * allowed — and the database would refuse the whole transaction with a
 * constraint name, which is not a sentence anybody can act on.
 *
 * So the collision is found first and refused in words. Silently dropping one
 * would be worse than either: a subcontractor row carries insurance expiry and
 * licence numbers, and losing the one nobody chose to lose is exactly the
 * quiet data loss this module exists to prevent.
 */
export const EXCLUSIVE_REFERENCES: Reference[] = [
  { table: 'subcontractors', column: 'vendor_id' },
]

/** What the merge would move, counted per table, for a person to read first. */
export type MergeTally = { table: string; rows: number }

export type MergeInput = {
  side: PartySide
  /** The record that survives, and everything ends up on. */
  winner: { id: string; name: string; standing: Standing; isActive: boolean }
  /** The record that is archived, and everything moves off. */
  loser: { id: string; name: string; standing: Standing; isActive: boolean }
  /**
   * Tables where both parties already hold a row that must be unique.
   *
   * Named by the caller because only the database knows, and passed in rather
   * than looked up here so the rule stays readable and testable.
   */
  collisions?: string[]
}

export type MergeVerdict = { ok: true } | { ok: false; why: string }

const NOUN: Record<PartySide, string> = { customer: 'customer', vendor: 'supplier' }

/**
 * Whether these two may be put together.
 *
 * Every refusal names the records rather than the rule, because a person
 * reading it is looking at two rows and needs to know which one is the problem
 * (Phase 47).
 */
export function mergeCheck(input: MergeInput): MergeVerdict {
  const noun = NOUN[input.side]

  if (input.winner.id === input.loser.id) {
    return { ok: false, why: `A ${noun} cannot be merged into itself. Pick two records.` }
  }

  if (!input.winner.isActive) {
    return {
      ok: false,
      why: `${input.winner.name} is archived. Bring it back first, or merge the other way round — everything would move onto a record nobody can reach.`,
    }
  }

  if (!input.loser.isActive) {
    return {
      ok: false,
      why: `${input.loser.name} is already archived, so there is nothing on it to move.`,
    }
  }

  const collisions = input.collisions ?? []
  if (collisions.length > 0) {
    return {
      ok: false,
      why: `Both ${input.winner.name} and ${input.loser.name} have their own ${collisions.join(' and ')} record, and only one is allowed per ${noun}. Sort that out first — deciding which to keep is not something this can do for you.`,
    }
  }

  return { ok: true }
}

/**
 * What is about to happen, in a sentence, before anybody presses anything.
 *
 * Counts rather than a bare warning: "12 invoices, 3 payments" is a number
 * somebody can check against the record in front of them, and an operation that
 * cannot be undone should show its work first.
 */
/**
 * A table name as a person would say it, for a count.
 *
 * Dropping the trailing `s` is enough for every name in the registry — a test
 * asserts that, so a future table whose plural is irregular fails there rather
 * than printing "1 people" at somebody. Found in the browser, which rendered
 * *"1 recurring invoices"*.
 */
function noun(table: string, rows: number): string {
  const words = table.replace(/_/g, ' ')
  return rows === 1 ? words.replace(/s$/, '') : words
}

export function describeMerge(input: {
  side: PartySide
  winnerName: string
  loserName: string
  tally: MergeTally[]
}): string {
  const moving = input.tally.filter((one) => one.rows > 0)
  const total = moving.reduce((sum, one) => sum + one.rows, 0)

  const what =
    total === 0
      ? `${input.loserName} has nothing on it`
      : `${total} record${total === 1 ? '' : 's'} (${moving
          .map((one) => `${one.rows} ${noun(one.table, one.rows)}`)
          .join(', ')})`

  return `${what} will move to ${input.winnerName}, and ${input.loserName} will be archived. This cannot be undone.`
}
