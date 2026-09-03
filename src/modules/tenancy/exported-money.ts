/**
 * Money in an exported file, and why it may not be a bare number (Phase 103).
 *
 * ## The defect
 *
 * `invoices.csv` had a `total` column holding `invoices.total_cents` — the
 * amount in the currency the invoice was *issued* in — with no currency
 * anywhere in the file. The development company has twenty invoices in USD and
 * two in EUR; summing that column gives a number that is not money in any
 * currency, and understates the receivable by the difference between the euro
 * face value and what it was booked at.
 *
 * Phase 65 was named for closing exactly this sum. It was closed in the
 * reports, the statements, the chase, the approval threshold and the aging —
 * everywhere somebody looks at a screen. The export was written at Phase 13 and
 * was not on the list.
 *
 * ## Why this is a type rather than a rule
 *
 * The old helper was `units(cents: number): string`. Every call site was one
 * keystroke from being wrong and none of them could be checked, because a bare
 * number is a perfectly good argument. `moneyColumns` cannot be called without
 * saying what currency the amount is in, so the omission stops being possible
 * rather than stopping being likely.
 *
 * ## No clock, no rate table
 *
 * The functional amount is *read* from the document, never recomputed here.
 * Re-deriving it would use today's rate to restate a document booked in March,
 * which is wrong and is the thing Phase 35 stored rates to prevent. This file
 * has no database and no clock; it formats what it is given.
 */

/** An amount and the currency it is an amount of. Neither is optional. */
export type Money = { cents: number; currency: string }

/**
 * What one money field becomes in a CSV: four columns.
 *
 * Both the document figure and the functional figure, even when they are equal
 * — which is the common case and looks redundant. A column present only
 * sometimes breaks every formula written against the file, and a shape that
 * depends on whether the company happens to have traded abroad is worse than a
 * duplicated column.
 */
export type MoneyColumns = {
  amount: string
  currency: string
  functionalAmount: string
  functionalCurrency: string
}

/** Integer cents to a decimal string a spreadsheet reads as money. */
export function decimal(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  const negative = cents < 0
  const absolute = Math.abs(cents)
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

export function normaliseCurrency(currency: string): string {
  return currency.trim().toUpperCase()
}

/**
 * The four values for one money field.
 *
 * `functional` is optional only for documents that have no separate functional
 * amount stored — a payment in the company's own currency, say — in which case
 * the document figure *is* the functional figure and both columns say so. It is
 * never silently left blank: a blank functional column would read as "not
 * applicable" when it means "the same".
 */
export function moneyColumns(document: Money, functional?: Money | null): MoneyColumns {
  const home = functional ?? document
  return {
    amount: decimal(document.cents),
    currency: normaliseCurrency(document.currency),
    functionalAmount: decimal(home.cents),
    functionalCurrency: normaliseCurrency(home.currency),
  }
}

/**
 * The column names for one money field, generated rather than written twice.
 *
 * The header row and the value object were two hand-written lists, so adding a
 * column meant editing both and getting them out of step shifts every value in
 * the file by one position — the same failure as an unquoted comma, reached
 * from the other side. Now one call produces both.
 */
export function columnsFor(prefix: string): [string, string, string, string] {
  return [prefix, `${prefix}_currency`, `${prefix}_functional`, `${prefix}_functional_currency`]
}

/** Spreads one money field into a row, under the names `columnsFor` generates. */
export function spread(prefix: string, columns: MoneyColumns): Record<string, string> {
  const [amount, currency, functionalAmount, functionalCurrency] = columnsFor(prefix)
  return {
    [amount]: columns.amount,
    [currency]: columns.currency,
    [functionalAmount]: columns.functionalAmount,
    [functionalCurrency]: columns.functionalCurrency,
  }
}

export type CurrencyTally = { currency: string; rowCount: number; totalCents: number }

/**
 * What each currency in a file adds up to.
 *
 * This is what the manifest carries, and it exists because "can I add this
 * column up" is a question about a whole file rather than about a row. A file
 * with one currency has one tally and may be summed; a file with two has two,
 * and no single total for it exists.
 *
 * Sorted by currency so the manifest is stable between exports — a file that
 * reorders itself run to run cannot be diffed.
 */
export function tally(rows: Array<Money>): CurrencyTally[] {
  const byCurrency = new Map<string, CurrencyTally>()

  for (const row of rows) {
    const currency = normaliseCurrency(row.currency)
    const found = byCurrency.get(currency)
    if (found) {
      found.rowCount += 1
      found.totalCents += row.cents
    } else {
      byCurrency.set(currency, { currency, rowCount: 1, totalCents: row.cents })
    }
  }

  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

/** True when a file holds more than one currency, so its column cannot be summed. */
export function mixesCurrencies(tallies: CurrencyTally[]): boolean {
  return tallies.length > 1
}

/**
 * The sentence the manifest puts beside a file.
 *
 * Prose rather than a flag, on Phase 70's rule: the next person adding a
 * dataset has to say what their file means rather than copy a boolean.
 */
export function summarise(fileName: string, tallies: CurrencyTally[]): string {
  if (tallies.length === 0) return `${fileName} holds no money columns.`

  if (tallies.length === 1) {
    const only = tallies[0]
    return `${fileName} is entirely in ${only.currency} and totals ${decimal(only.totalCents)}.`
  }

  const named = tallies.map((t) => `${t.currency} ${decimal(t.totalCents)}`).join(', ')
  return (
    `${fileName} holds ${tallies.length} currencies (${named}). ` +
    'There is no single total for it — add the functional columns instead.'
  )
}
