import { formatCents } from '@/lib/money'
import { heldByCurrency } from '@/modules/receivables/settlement-currency'
import { isForeign, normalise } from './rates'

/**
 * What a party's held credit is worth when it spans currencies (spec §13, §35,
 * Phase 65).
 *
 * ## The defect, in its sharpest form
 *
 * The customers screen builds a party's standing out of two sums:
 *
 * ```sql
 * balanceCents:    coalesce(sum(invoices.functional_balance_cents), 0)
 * heldCreditCents: coalesce(max(held_credit.held_cents), 0)   -- sum(unapplied_cents)
 * ```
 *
 * The first is **converted**. The second is the **face amount**. Phase 54 then
 * nets one against the other to decide what the customer should pay.
 *
 * So a customer with a €4,000 invoice and a €500 overpayment had a balance of
 * $4,334.00 reduced by 500 — a number that is neither dollars nor euro, arrived
 * at by subtracting one currency from another, and printed with a dollar sign.
 * ADR 0062 named the three places that do it, ADR 0063 and ADR 0064 left them
 * open, because closing them needs the payment's *rate*, not just its currency.
 *
 * ## What this decides
 *
 * A screen that ranks parties and applies a minimum-balance floor genuinely
 * needs **one comparable number**. Phase 61's `describeBalances` refuses to
 * produce a single total for mixed currencies, and it is right to for a
 * statement — a customer is owed money in theirs, and a sum of two currencies
 * is not payable in either.
 *
 * But this is a different question. "Which of my customers is holding the most
 * of my money" has an answer, and it is the functional one: what those receipts
 * were worth when they arrived, which is exactly what the books carry them at.
 *
 * So: one functional figure to sort and threshold on, the per-currency truth
 * beside it, and a sentence saying which is which. Nothing here touches the
 * database or the clock.
 */

export type Holding = {
  currency: string
  /** What is held, in `currency` — what the party is actually owed back. */
  heldCents: number
  /** What it was worth when received, at that receipt's own fixed rate. */
  functionalHeldCents: number
}

export type Holdings = {
  /**
   * The single comparable figure, in the company's own currency. Safe to sum,
   * sort and threshold on, because every term is in one currency.
   */
  functionalHeldCents: number
  /** Per currency, largest code first only in the sense of alphabetical order. */
  holdings: Holding[]
  /** Whether the functional figure is standing in for something else. */
  converted: boolean
  /** What to say beside the figure, or null when it needs no explaining. */
  note: string | null
}

/**
 * What is being held for somebody, as one comparable number and as the truth.
 *
 * Which currencies appear, and in what order, is `heldByCurrency`'s decision
 * (Phase 62) rather than a second one made here — so a currency held at zero
 * stays dropped in both places, and cannot start appearing on one screen and
 * not another.
 */
export function comparableHoldings(
  rows: {
    currency: string
    unappliedCents: number
    /** At the receipt's own rate, fixed when it was recorded. */
    functionalUnappliedCents: number
  }[],
  homeCurrency: string,
): Holdings {
  const home = normalise(homeCurrency)

  const functionalByCurrency = new Map<string, number>()
  for (const row of rows) {
    if (row.unappliedCents <= 0) continue
    const code = normalise(row.currency)
    functionalByCurrency.set(
      code,
      (functionalByCurrency.get(code) ?? 0) + row.functionalUnappliedCents,
    )
  }

  const holdings: Holding[] = heldByCurrency(rows).map((held) => ({
    currency: held.currency,
    heldCents: held.heldCents,
    functionalHeldCents: functionalByCurrency.get(held.currency) ?? 0,
  }))

  const functionalHeldCents = holdings.reduce(
    (sum, held) => sum + held.functionalHeldCents,
    0,
  )

  // Converted when any of it came in as something other than the company's own
  // money. A single home-currency holding needs no explaining: the figure and
  // the truth are the same number.
  const converted = holdings.some((held) => isForeign(held.currency, home))

  return {
    functionalHeldCents,
    holdings,
    converted,
    note: converted ? describeHoldings(holdings, functionalHeldCents, home) : null,
  }
}

/**
 * The sentence that goes beside a converted figure.
 *
 * It says "when received" rather than naming a rate, because each receipt was
 * converted at its own — a holding built from three receipts has three rates
 * behind it and no single one to quote. What matters to the person reading is
 * that the figure is historic and the repayment is not.
 */
function describeHoldings(
  holdings: Holding[],
  functionalHeldCents: number,
  homeCurrency: string,
): string {
  const parts = holdings.map((held) => formatCents(held.heldCents, held.currency))

  const listed =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

  return (
    `${listed} held. The ${formatCents(functionalHeldCents, homeCurrency)} shown is what that ` +
    'was worth when it was received — it is repayable in the currency it came in.'
  )
}
