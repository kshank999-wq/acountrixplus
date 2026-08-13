/**
 * Money handling.
 *
 * Every monetary value in this system is an integer number of minor units
 * (cents). Floating point is never used for money: 0.1 + 0.2 !== 0.3 in IEEE
 * 754, and an accounting ledger cannot absorb that error (spec §19).
 */

/** Parses a user-entered amount like "1,234.56" or "$12.00" into cents. */
export function parseAmountToCents(input: string): number {
  const cleaned = input.replace(/[$,\s]/g, '').trim()
  if (cleaned === '' || cleaned === '-' || !/^-?\d*\.?\d*$/.test(cleaned)) {
    throw new Error(`Not a valid amount: ${input}`)
  }

  const negative = cleaned.startsWith('-')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')

  if (fraction.length > 2) {
    throw new Error(`Amounts are limited to two decimal places: ${input}`)
  }

  // Pad so "1.5" reads as 50 cents, not 5.
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Amount out of range: ${input}`)
  }

  return negative ? -cents : cents
}

/** Formats cents for display, e.g. -123456 -> "-$1,234.56". */
export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100)
}

/** Formats cents without the sign, for UI that shows direction separately. */
export function formatCentsAbs(cents: number, currency = 'USD'): string {
  return formatCents(Math.abs(cents), currency)
}

/**
 * Splits an amount across `n` recipients without losing or inventing cents.
 * The remainder is distributed one cent at a time to the earliest shares, so
 * the parts always sum exactly back to the total.
 */
export function allocateCents(totalCents: number, parts: number): number[] {
  if (parts <= 0) throw new Error('parts must be positive')

  const sign = totalCents < 0 ? -1 : 1
  const total = Math.abs(totalCents)
  const base = Math.floor(total / parts)
  const remainder = total - base * parts

  return Array.from({ length: parts }, (_, i) => sign * (base + (i < remainder ? 1 : 0)))
}

/** Money leaving the account is negative; arriving is positive. */
export type Direction = 'debit' | 'credit'

/**
 * Direction of a bank transaction from the account holder's perspective.
 * "debit" = money out, "credit" = money in.
 */
export function directionOf(amountCents: number): Direction {
  return amountCents < 0 ? 'debit' : 'credit'
}
