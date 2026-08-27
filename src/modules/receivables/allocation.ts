/**
 * Deciding what a payment settles (spec §13, §19).
 *
 * ## Why this is a decision at all
 *
 * `recordPayment` takes applications that must sum *exactly* to the amount —
 * deliberately, because a payment that half-lands is worse than one refused.
 * That pushes the decision up to the caller: a customer sends £1,000 against
 * three open invoices and, most of the time, does not say which.
 *
 * Somebody has to answer that, and the wrong answers cost money:
 *
 *  - **Applying more than a document's balance** leaves a negative balance, an
 *    invoice that looks overpaid, and a receivables control account that no
 *    longer equals the sum of open balances.
 *  - **Silently absorbing the remainder** records cash against nothing. The
 *    bank agrees, the customer's statement does not, and nobody finds out
 *    until the customer asks why they are still being chased.
 *
 * So this function never does either. It fills documents in order until the
 * money runs out, never past a balance, and hands back whatever it could not
 * place for the caller to say something about.
 */

/** An open document a payment could be applied to. */
export type OpenDocument = {
  id: string
  /** What the customer or supplier sees. Only used for reporting back. */
  number: string
  /** Remaining unpaid amount, in minor units. Never negative. */
  balanceCents: number
  /** ISO date. Oldest is settled first — see `byOldest`. */
  dueDate: string
  /** ISO date, the tie-break when two documents fall due the same day. */
  issueDate: string
}

export type Application = {
  documentId: string
  number: string
  amountCents: number
}

export type Allocation = {
  applications: Application[]
  /** What was applied. Always the amount less `unappliedCents`. */
  appliedCents: number
  /**
   * What the payment could not place, because every open document is settled.
   *
   * Handed back rather than absorbed. A receipt with money left over is a
   * customer who has overpaid, and that is a conversation, not a rounding.
   */
  unappliedCents: number
}

/**
 * Oldest first, which is the convention every ledger uses and the one a
 * customer expects when they pay without saying.
 *
 * Due date, then issue date, then number. The last is not arbitrary — two
 * invoices raised on one day for one customer are distinguished by nothing
 * else, and an allocation that flips between two orderings on the same data
 * would make the same payment settle different invoices on different runs.
 */
export function byOldest(a: OpenDocument, b: OpenDocument): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
  if (a.issueDate !== b.issueDate) return a.issueDate < b.issueDate ? -1 : 1
  return a.number.localeCompare(b.number)
}

/**
 * Spreads a payment across open documents.
 *
 * `documents` is taken in the order given when `respectOrder` is set — which
 * is how somebody says "this cheque is for invoice 1043" — and sorted oldest
 * first otherwise.
 *
 * A document with no balance left is skipped rather than given a zero
 * application: a payment row against an invoice it did not touch is noise on
 * that invoice's history for ever.
 */
export function allocate(
  amountCents: number,
  documents: OpenDocument[],
  opts: { respectOrder?: boolean } = {},
): Allocation {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { applications: [], appliedCents: 0, unappliedCents: Math.max(0, amountCents) }
  }

  const ordered = opts.respectOrder ? [...documents] : [...documents].sort(byOldest)

  const applications: Application[] = []
  let remaining = amountCents

  for (const document of ordered) {
    if (remaining <= 0) break

    // Defensive: a balance that has gone negative through some other route is
    // not an invitation to take money off this payment.
    const available = Math.max(0, Math.trunc(document.balanceCents))
    if (available === 0) continue

    const amount = Math.min(available, remaining)
    applications.push({ documentId: document.id, number: document.number, amountCents: amount })
    remaining -= amount
  }

  return {
    applications,
    appliedCents: amountCents - remaining,
    unappliedCents: remaining,
  }
}

/**
 * What to tell somebody about a payment that did not fully land.
 *
 * Returns null when there is nothing to say, so a caller can render it or not
 * without asking whether it is empty.
 */
export function unappliedNote(
  allocation: Allocation,
  kind: 'receipt' | 'disbursement',
): string | null {
  if (allocation.unappliedCents <= 0) return null

  const who = kind === 'receipt' ? 'The customer has paid' : 'This pays'
  return (
    `${who} more than is outstanding. ` +
    'Reduce the amount, or raise the document this covers first — a payment cannot be recorded ' +
    'against nothing.'
  )
}
