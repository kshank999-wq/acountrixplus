import { formatCents } from '@/lib/money'

/**
 * What a statement can honestly say when its lines are not all in one currency
 * (spec §13, §35, Phase 61).
 *
 * ## The defect this exists to fix
 *
 * `openInvoices` selected `invoices.balance_cents` — the amount in the currency
 * the **customer** was invoiced in — and `buildStatement` added those together
 * into one `closingBalanceCents`. Two hundred lines further down the same file
 * said, in a comment:
 *
 * > The company's own currency, because every figure on this statement is the
 * > home-currency one (Phase 35) — including the balance the sentence restates.
 *
 * It was not. A customer invoiced €4,000 and $1,200 was told they owed
 * **$5,200.00**: a number in no currency at all, with a dollar sign on it. The
 * aging buckets added the same way, and Phase 54's net-position sentence
 * restated the same figure.
 *
 * This is the worst place in the system for that to be true. Phase 42 gives the
 * customer a link to it, Phase 55 emails it, and Phase 57 sends it every month
 * without anybody looking. It is the one document the business puts in front of
 * somebody else and asks them to pay against.
 *
 * ## What this module decides
 *
 * The same rule Phase 60 applied to money going out, pointed the other way: **a
 * customer is owed a demand in the currency they were invoiced in, and a total
 * only means something when its terms are in one currency.**
 *
 * So a statement states a balance **per currency**. For the overwhelming
 * majority of customers there is exactly one, and nothing about the document
 * changes.
 */

/** A statement line as this module needs to see it. */
export type CurrencyLine = {
  currency: string
  /** In `currency` — what the customer was invoiced. */
  balanceCents: number
  /** What that is worth in the company's currency. Comparable, never shown. */
  functionalBalanceCents: number
}

export type CurrencyBalance = {
  currency: string
  balanceCents: number
  functionalBalanceCents: number
}

/**
 * What is outstanding, split by the currency it is outstanding in.
 *
 * Ordered by what each comes to in the company's money, largest first, so the
 * currency the business is most exposed in leads — and deterministically by
 * currency code when two are equal, because a statement that reorders itself
 * between renders is a statement somebody stops trusting.
 */
export function balancesByCurrency(lines: CurrencyLine[]): CurrencyBalance[] {
  const totals = new Map<string, CurrencyBalance>()

  for (const line of lines) {
    const existing = totals.get(line.currency)
    if (existing) {
      existing.balanceCents += line.balanceCents
      existing.functionalBalanceCents += line.functionalBalanceCents
    } else {
      totals.set(line.currency, {
        currency: line.currency,
        balanceCents: line.balanceCents,
        functionalBalanceCents: line.functionalBalanceCents,
      })
    }
  }

  return [...totals.values()].sort((a, b) =>
    b.functionalBalanceCents === a.functionalBalanceCents
      ? a.currency.localeCompare(b.currency)
      : b.functionalBalanceCents - a.functionalBalanceCents,
  )
}

/**
 * The one currency this statement is in, or null when there is more than one.
 *
 * Null is the signal that no single closing balance exists — not that something
 * has gone wrong. A customer buying in two currencies is ordinary; claiming one
 * total for them is what was wrong.
 */
export function soleCurrency(lines: CurrencyLine[]): string | null {
  const first = lines[0]
  if (!first) return null
  return lines.every((line) => line.currency === first.currency) ? first.currency : null
}

/**
 * Which balance the held-credit sentence may net against (Phase 54).
 *
 * `payments.unapplied_cents` is money left over from a receipt, and a receipt
 * is in the currency of the documents it settled (Phase 58) — but nothing on
 * the payment records which that was, so the only currency it can safely be
 * read as is the company's own.
 *
 * So the netting is done against the **home-currency** balance and no other.
 * Netting a dollar credit against a euro invoice would be the very substitution
 * this phase exists to stop, done one level up: it would tell a customer that
 * money we hold in one currency has settled a demand in another.
 *
 * Returns zero when the customer owes nothing in the home currency, which is
 * the honest input to `netPosition` — the credit is still held, and the
 * statement says so, but it has cancelled nothing.
 */
export function homeCurrencyOwed(
  balances: CurrencyBalance[],
  homeCurrency: string,
): number {
  return balances.find((row) => row.currency === homeCurrency)?.balanceCents ?? 0
}

/** What the customer owes, in each currency, as a sentence. */
export function describeBalances(balances: CurrencyBalance[]): string {
  if (balances.length === 0) return 'Nothing is outstanding.'

  const parts = balances.map((row) => formatCents(row.balanceCents, row.currency))
  if (parts.length === 1) return `${parts[0]} is outstanding.`

  return (
    `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]} are outstanding. ` +
    'Each is payable in the currency it was invoiced in — there is no single total, ' +
    'because these are amounts of different money.'
  )
}

/**
 * What to add beneath the net-position sentence when the customer also owes in
 * a currency that sentence did not cover, or null when there is nothing to add.
 *
 * Phase 54 stopped a statement asking for money the business was already
 * holding. Its sentence is about the home-currency balance alone, and staying
 * silent about a foreign balance would leave a customer reading "nothing is
 * due" over a €4,000 invoice listed above it.
 */
export function foreignBalanceNote(
  balances: CurrencyBalance[],
  homeCurrency: string,
): string | null {
  const foreign = balances.filter((row) => row.currency !== homeCurrency)
  if (foreign.length === 0) return null

  const parts = foreign.map((row) => formatCents(row.balanceCents, row.currency))
  const joined =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

  return (
    `${joined} ${parts.length === 1 ? 'is' : 'are'} outstanding separately, and payable in ` +
    `${parts.length === 1 ? 'that currency' : 'those currencies'}. Any credit we are holding ` +
    `is in ${homeCurrency} and has not been set against ${parts.length === 1 ? 'it' : 'them'}.`
  )
}
