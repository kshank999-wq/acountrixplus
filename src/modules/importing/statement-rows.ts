import { createHash } from 'node:crypto'

/**
 * Giving a statement row an identity it does not have (spec §3, §17).
 *
 * ## The problem this exists to solve
 *
 * `bank_transactions` dedups on
 * `(company_id, financial_account_id, provider_transaction_id)`, and the schema
 * comment says why that works: *"the provider's id is immutable, so
 * re-importing the same window is a no-op at the database level rather than
 * something application code has to remember to check."*
 *
 * A CSV statement has no such id. A bank gives you a date, a description and an
 * amount, and nothing that survives being exported twice. So the row has to
 * identify itself by what it is.
 *
 * ## Why a content hash alone is wrong
 *
 * Hashing `(date, amount, description)` looks sufficient and quietly loses
 * money. Somebody who buys two identical coffees on the same day has two
 * transactions, and one hash. The second disappears — not with an error, but by
 * being silently deduplicated against the first, which is the worst way for
 * bookkeeping software to be wrong.
 *
 * So the fingerprint carries an **ordinal**: the position of this row among the
 * rows in the same statement that are otherwise identical to it. Two identical
 * coffees are `#1` and `#2`, and stay two transactions. Re-importing the same
 * file produces the same two ordinals and imports nothing, which is the whole
 * point.
 */

/** What a row means once the columns have been read. */
export type StatementRow = {
  /** ISO date, already coerced. */
  postedDate: string
  /**
   * Signed minor units, in *our* convention: negative leaves the account.
   *
   * Not the bank's convention. See `signedAmountCents`.
   */
  amountCents: number
  description: string
}

/**
 * Turns a bank's idea of an amount into ours.
 *
 * Banks disagree about how to say "money left the account", and getting this
 * backwards inverts every figure on the profit and loss:
 *
 *  - **One signed column.** `-4.50` is a spend. Taken as-is.
 *  - **Two columns**, `Debit`/`Withdrawal` and `Credit`/`Deposit`, each holding
 *    an unsigned figure. A debit *on a bank statement* is money leaving your
 *    account — the opposite of a debit in your own ledger, because the
 *    statement is written from the bank's side of the relationship, where your
 *    balance is their liability.
 *
 * Returns null when the row says nothing, and treats a row with figures in both
 * columns as a refusal rather than a sum: a statement that fills both is one
 * this parser does not understand, and guessing at a net figure would be
 * inventing a transaction that does not appear on the statement.
 */
export function signedAmountCents(input: {
  amount?: number | null
  debit?: number | null
  credit?: number | null
}): { ok: true; cents: number } | { ok: false; reason: 'empty' | 'both' } {
  const debit = nonZero(input.debit)
  const credit = nonZero(input.credit)

  if (debit !== null && credit !== null) return { ok: false, reason: 'both' }

  // The two-column layout. Magnitudes are used, because a statement that
  // writes "-4.50" in a column already labelled Withdrawal means the same
  // thing as "4.50" and negating it twice would turn a spend into income.
  if (debit !== null) return { ok: true, cents: -Math.abs(debit) }
  if (credit !== null) return { ok: true, cents: Math.abs(credit) }

  const amount = nonZero(input.amount)
  if (amount !== null) return { ok: true, cents: amount }

  return { ok: false, reason: 'empty' }
}

function nonZero(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value)) return null
  if (value === 0) return null
  return Math.trunc(value)
}

/**
 * Normalises a description for identity purposes only.
 *
 * The stored description keeps whatever the bank wrote. This is the version the
 * fingerprint sees, so that a bank re-exporting the same row with different
 * spacing or capitalisation does not produce a second transaction.
 *
 * Deliberately conservative: case and whitespace only. Stripping punctuation or
 * digits would collapse "CHQ 001234" and "CHQ 001235" into one identity, and
 * two different cheques are two transactions.
 */
export function normalizeDescription(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The identity of a row within an account.
 *
 * Prefixed so it is obvious in the database where a transaction came from, and
 * so it can never collide with a real provider's id namespace.
 *
 * Truncated to 32 hex characters — 128 bits, which for the number of rows a
 * small business's statement holds is a collision probability far below the
 * chance of the file being wrong in the first place.
 */
export function fingerprint(input: {
  financialAccountId: string
  row: StatementRow
  ordinal: number
}): string {
  const parts = [
    input.financialAccountId,
    input.row.postedDate,
    String(input.row.amountCents),
    normalizeDescription(input.row.description),
    String(input.ordinal),
  ]

  // Length-prefixed, so a description ending in the separator cannot be made
  // to look like the next field and forge a collision.
  const canonical = parts.map((part) => `${part.length}:${part}`).join('|')
  return `csv:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

/**
 * Assigns each row its ordinal among otherwise-identical rows, then fingerprints.
 *
 * Order matters and is the file's own. Two exports of the same day list that
 * day's rows in the same order, so the same coffee gets the same ordinal both
 * times and re-importing is a no-op.
 */
export function fingerprintRows(
  financialAccountId: string,
  rows: StatementRow[],
): Array<{ row: StatementRow; ordinal: number; fingerprint: string }> {
  const seen = new Map<string, number>()

  return rows.map((row) => {
    const identity = [row.postedDate, row.amountCents, normalizeDescription(row.description)].join('|')
    const ordinal = (seen.get(identity) ?? 0) + 1
    seen.set(identity, ordinal)

    return { row, ordinal, fingerprint: fingerprint({ financialAccountId, row, ordinal }) }
  })
}
