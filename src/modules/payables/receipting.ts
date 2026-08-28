/**
 * The bill for goods you already have (spec §5, §13, §19).
 *
 * ## The hole this closes
 *
 * Receiving stock posts `Dr Inventory / Cr Goods Received Not Invoiced`. The
 * goods are on the shelf and the money is owed, but not yet to a named
 * supplier on a named invoice — so `2050` holds it in the meantime. That is
 * correct, and it has worked since Phase 14.
 *
 * Then the supplier's invoice arrives, and the bill that clears `2050` **could
 * not be entered**. `documentLineAccounts(ctx, 'vendor')` offers a bill line
 * `expense | cogs | other_expense | asset`, and `2050` is a **liability**, so
 * it was not on the list. `attachBillToReceipts` — written in Phase 14 to do
 * exactly this job, with a doc comment describing the posting — had **no
 * caller anywhere in the codebase**.
 *
 * The consequence compounds every delivery:
 *
 *  - the bill gets coded to Inventory or an expense account instead, so the
 *    **cost is recognised twice** — once when the goods arrived, once when the
 *    paperwork did;
 *  - `2050` grows for ever, because nothing in the application can debit it;
 *  - and no integrity check watched that account, so nothing said so.
 *
 * The demo carried $28,700 in a clearing account with no way to clear it.
 *
 * ## The correction to Phase 14's stated decision
 *
 * `attachBillToReceipts` says the difference between the invoice and the
 * receipt *"stays in that account as a visible residue"*. That was wrong, and
 * this phase changes it.
 *
 * A residue in `2050` is **indistinguishable from a delivery nobody has
 * billed**. Both read as "the company owes for goods it has", and there is no
 * way to tell three dollars of price variance from a $3,000 invoice somebody
 * has not entered. A clearing account that cannot be reconciled to a list is
 * not a clearing account — it is a suspense account with a nicer name, which
 * is exactly how it grew to $28,700 unnoticed.
 *
 * So the receipt's own value is cleared in full and the difference is posted
 * to **purchase price variance**, where it belongs: it is a cost of buying,
 * it is on the profit and loss where somebody will see it, and `2050` goes
 * back to being exactly the sum of the deliveries nobody has billed.
 *
 * Nothing here touches the database or the clock.
 */

/** A goods receipt, as this module needs to compare it. */
export type BillableReceipt = {
  id: string
  number: string
  vendorId: string
  /** What the goods were taken into stock at. This is what sits in 2050. */
  totalCents: number
  /** Set once a bill has claimed it. A billed receipt cannot be billed again. */
  billId: string | null
}

export type MatchAction =
  /** The invoice agrees with what arrived. Clear it and post nothing else. */
  | 'clear'
  /** It differs. Clear the receipt in full, post the difference to variance. */
  | 'clear_with_variance'
  /** Nothing can be cleared, and the reason is not a difference in price. */
  | 'refuse'

export type MatchVerdict = {
  action: MatchAction
  /** What comes out of 2050. Always the receipts' own value, never the bill's. */
  clearedCents: number
  /**
   * Billed minus received.
   *
   * Positive is an overcharge — the supplier billed more than the goods were
   * taken in at. Negative is an undercharge, which is usually a credit note
   * already applied or a delivery still to be invoiced.
   */
  varianceCents: number
  /** A sentence for whoever is looking at it. */
  why: string
}

/**
 * How far a supplier's invoice may differ before it is worth mentioning.
 *
 * Fifty basis points — half a percent. Below that it is rounding, a rounded
 * freight charge or a rate that moved between order and delivery, and flagging
 * it every time teaches somebody to approve without reading. Above it, the
 * variance is still *posted* either way; the tolerance only decides whether
 * anybody is told about it.
 */
export const VARIANCE_TOLERANCE_BP = 50

/** Basis points of `base`, rounded half-up. Never negative. */
export function toleranceCents(baseCents: number, bp = VARIANCE_TOLERANCE_BP): number {
  return Math.round((Math.abs(baseCents) * bp) / 10_000)
}

/**
 * What a supplier's invoice does to a set of goods receipts.
 *
 * The cleared amount is the **receipts'** value, not the bill's. That is the
 * whole point: `2050` was credited with what the goods were taken into stock
 * at, so that is the figure that has to come back out for the account to reach
 * zero. Clearing the bill's amount instead would leave the difference behind,
 * which is the mistake this phase exists to correct.
 */
export function matchVerdict(input: {
  receipts: BillableReceipt[]
  /** What the supplier is asking for, net of tax. */
  billedCents: number
  vendorId: string
}): MatchVerdict {
  const { receipts, billedCents, vendorId } = input

  if (receipts.length === 0) {
    return {
      action: 'refuse',
      clearedCents: 0,
      varianceCents: 0,
      why: 'No deliveries were chosen, so there is nothing to clear.',
    }
  }

  // Billing one supplier's delivery on another's invoice would clear the
  // wrong balance and leave both suppliers wrong. Checked here rather than
  // trusted to the screen, because the screen is not the only caller.
  const stranger = receipts.find((receipt) => receipt.vendorId !== vendorId)
  if (stranger) {
    return {
      action: 'refuse',
      clearedCents: 0,
      varianceCents: 0,
      why: `Delivery ${stranger.number} came from a different supplier. One bill settles one supplier's deliveries.`,
    }
  }

  const alreadyBilled = receipts.find((receipt) => receipt.billId !== null)
  if (alreadyBilled) {
    return {
      action: 'refuse',
      clearedCents: 0,
      varianceCents: 0,
      why: `Delivery ${alreadyBilled.number} has already been billed. Billing it twice would pay for it twice.`,
    }
  }

  if (billedCents <= 0) {
    return {
      action: 'refuse',
      clearedCents: 0,
      varianceCents: 0,
      why: 'A bill has to be for more than nothing.',
    }
  }

  const clearedCents = receipts.reduce((sum, receipt) => sum + receipt.totalCents, 0)
  const varianceCents = billedCents - clearedCents

  if (varianceCents === 0) {
    return {
      action: 'clear',
      clearedCents,
      varianceCents: 0,
      why: 'The invoice agrees with what arrived.',
    }
  }

  return {
    action: 'clear_with_variance',
    clearedCents,
    varianceCents,
    why:
      varianceCents > 0
        ? 'The supplier billed more than the goods were taken in at.'
        : 'The supplier billed less than the goods were taken in at.',
  }
}

/** Whether a variance is big enough that somebody should look at it. */
export function worthMentioning(verdict: MatchVerdict): boolean {
  if (verdict.action !== 'clear_with_variance') return false
  return Math.abs(verdict.varianceCents) > toleranceCents(verdict.clearedCents)
}

/**
 * What the person entering the bill reads, or null when there is nothing to
 * say beyond "it matched".
 *
 * Silent inside tolerance, for ADR 0024's reason: a notice that fires on every
 * rounded freight charge is one nobody reads by the end of the week, and the
 * one that matters — a supplier quietly repricing — goes with it.
 */
export function describeMatch(verdict: MatchVerdict): string | null {
  if (verdict.action === 'refuse') return verdict.why
  if (!worthMentioning(verdict)) return null

  const direction = verdict.varianceCents > 0 ? 'more' : 'less'
  const amount = Math.abs(verdict.varianceCents)

  return (
    `The invoice is ${formatBare(amount)} ${direction} than the ${formatBare(verdict.clearedCents)} ` +
    'of goods it covers. The difference posts to purchase price variance, where it shows on the ' +
    'profit and loss rather than sitting in a clearing account nobody reconciles.'
  )
}

/** Cents as a bare decimal. No currency symbol — the caller knows theirs. */
function formatBare(cents: number): string {
  return (cents / 100).toFixed(2)
}
