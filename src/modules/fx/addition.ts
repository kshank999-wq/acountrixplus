/**
 * The ways money is added up, and what one currency means (Phase 123).
 *
 * ## The defect
 *
 * Phase 122 built a tripwire and put this at the top of it:
 *
 * > No sum adds two currencies together (Phase 122). **It reads the source.**
 *
 * It reads the source for **one syntactic form**: `sum(${table.column})`, the
 * SQL aggregate. This codebase adds money two ways, and the other one —
 * `rows.reduce((sum, row) => sum + row.amountCents, 0)` — was invisible to it
 * from the day it was written.
 *
 * Measured across `src/modules` and `src/app`, over reduces of a face-amount
 * column read from its own currency-bearing table:
 *
 * ```
 * already declared safe (Phase 122)   1   drawer/service.ts shiftPosition
 * currency-blind                      3   in two files
 * ```
 *
 * One of the three is `shiftPosition`'s own sibling reduce, which Phase 122's
 * entry already covers — the two forms sit in one function, and the scanner
 * saw one of them. The other two are new:
 *
 * - **`createDeposit`** sums `payments.amount_cents` across the receipts being
 *   banked and debits the bank with the total. It is a **write**: a €500 and a
 *   $500 receipt banked together post "1000" to the ledger as company currency,
 *   and `banking.cash_tie_out` then reports a difference nobody can explain.
 *   `payments.amount_cents` is the column Phase 122 singled out as *"the
 *   easiest to add up by mistake"*, because it is the one face column with no
 *   functional twin at all.
 * - **`duplicateExposure`** sums `bills.total_cents` and `bills.balance_cents`
 *   across suppliers, and it is the right-hand side of the
 *   `payables.duplicate_bills` register check. A register check adding
 *   currencies is the Phase 115 defect exactly, one phase after a tripwire was
 *   built to stop it.
 *
 * ## Why a form registry rather than a wider regex
 *
 * A wider regex was tried first and matched **145 sites**, nearly all of them
 * legitimate — an invoice's own lines, a trial balance's ledger balances, a
 * till's tenders. Drowning a real finding in 141 false ones is how a tripwire
 * gets switched off.
 *
 * So the rule is narrowed to what is actually decidable from the source: a
 * reduce over a **face column's own property name**, in a file that reads that
 * column out of its own currency-bearing table. That is four sites, and every
 * one of them is a genuine question.
 *
 * The forms are declared here rather than written into the test, so the next
 * person who adds money a third way has somewhere to say so — and so the
 * claim "it reads the source" can name which source it reads.
 */

import { Refusal } from '@/modules/errors'
import { RegistryError } from '@/modules/errors/registry'

/** A syntactic form in which this codebase adds money up. */
export type AdditionForm = {
  key: string
  /** A JavaScript regular expression source, compiled by the test that scans. */
  pattern: string
  /** What it looks like, for somebody reading this rather than the regex. */
  looksLike: string
  /** Why it counts as adding money, and what phase learned that it does. */
  because: string
}

export const ADDITION_FORMS: readonly AdditionForm[] = [
  {
    key: 'sql_sum',
    // Case-insensitive since Phase 125. The pattern read `sum(` and matched
    // lowercase only, so two live sums written `SUM(` inside a raw `sql`
    // template were invisible to it from the day it was written.
    pattern: String.raw`[sS][uU][mM]\(\s*\$\{(\w+)\.(\w+)\}`,
    looksLike: 'sum(${invoices.balanceCents}) — or SUM(...) inside a raw sql template',
    because:
      'The SQL aggregate, added to the database query. The only form Phase 122 looked for, ' +
      'which is why its file could say "it reads the source" while three sums in the other ' +
      'form went on adding euros to dollars underneath it.',
  },
  {
    key: 'js_reduce',
    pattern: String.raw`\.reduce\(\s*\(\s*\w+\s*,\s*(\w+)\s*\)\s*=>\s*\w+\s*\+\s*\w+\.(\w+)`,
    looksLike: 'rows.reduce((sum, row) => sum + row.amountCents, 0)',
    because:
      'The same addition done in TypeScript after the rows come back. Indistinguishable in ' +
      'effect from the aggregate and far more common in this codebase, because a function that ' +
      'already has the rows in hand does not go back to the database to add them up.',
  },
]

/** The form a key names. Throws on a form nobody declared. */
export function additionFormFor(key: string): AdditionForm {
  const form = ADDITION_FORMS.find((row) => row.key === key)
  if (!form) {
    throw new RegistryError({
      registry: 'ADDITION_FORMS',
      key,
      message:
        `No addition form is declared for "${key}". A tripwire that scans for sums has to say ` +
        'which forms of sum it scans for, or its guarantee is narrower than it reads.',
    })
  }
  return form
}

/** What a set of amounts is denominated in, when they agree. */
export type OneCurrency =
  | { agreed: true; currency: string }
  | { agreed: false; currencies: string[] }

/**
 * Whether these amounts may be added together at all.
 *
 * Pure, and deliberately the whole decision: the caller either gets a currency
 * it may label the total with, or the list of currencies that make the total
 * meaningless. There is no third answer where the total is "probably fine".
 *
 * An empty set agrees on `fallback` — a deposit of no receipts is still a
 * deposit in the bank account's own currency, and refusing it here would refuse
 * the wrong thing.
 */
export function oneCurrencyOf(
  amounts: ReadonlyArray<{ currency: string }>,
  fallback: string,
): OneCurrency {
  const seen = [...new Set(amounts.map((row) => row.currency))].sort()
  if (seen.length === 0) return { agreed: true, currency: fallback }
  if (seen.length === 1) return { agreed: true, currency: seen[0] }
  return { agreed: false, currencies: seen }
}

/**
 * The refusal for a set of amounts that cannot be added.
 *
 * A refusal beats a check (Phase 117): the alternative is banking the total and
 * letting `banking.cash_tie_out` report a difference in the morning, by which
 * point the entry is posted and somebody has to work out what "1000" was
 * supposed to mean.
 *
 * It names the currencies rather than saying "mixed", because the person
 * holding the paying-in slip knows which receipt is the odd one the moment they
 * are told which currency it is in.
 */
export function refuseMixedCurrency(what: string, currencies: string[]): Refusal {
  return new Refusal(
    `Those ${what} are in ${currencies.join(' and ')}, and a total across two currencies is not ` +
      'a number in either. A bank credits one currency at a time, so bank each currency ' +
      'separately.',
  )
}
