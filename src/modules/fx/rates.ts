import { formatCents } from '@/lib/money'

/**
 * Money in two currencies (spec §19).
 *
 * ## What has been a lie since Phase 1
 *
 * `companies.currency` and `financial_accounts.currency` have existed since the
 * first migration, both defaulting to `'USD'`, and **nothing has ever read
 * either of them.** Every amount in this application is implicitly dollars, and
 * `formatCents` has a `currency = 'USD'` parameter that no caller passes.
 *
 * A column that claims to record something and is read by nothing is worse than
 * an absent one: it tells the next person the question has been thought about.
 *
 * ## The two currencies
 *
 * - The **transaction currency** is what a document is denominated in. An
 *   invoice to a customer in Berlin is for €4,000, and €4,000 is what they owe.
 *   Not "about $4,300" — €4,000.
 * - The **functional currency** is what the books are kept in. Every journal
 *   line, every report, every control account is in it, always. A ledger that
 *   mixed currencies could not be added up.
 *
 * A document therefore carries both, joined by a **rate on a stated date**. The
 * conversion happens once, at the moment of the transaction, and the result is
 * stored. Recomputing it later from today's rate would silently rewrite last
 * year's revenue every time a currency moved, which is the single worst thing a
 * set of books can do.
 *
 * ## Rates are stored as integers too
 *
 * A rate is held in **millionths** — 1.083500 EUR/USD is `1_083_500`. Floats
 * are not allowed anywhere near money in this codebase (ADR 0002) and a rate is
 * a multiplier on money, so it gets the same treatment. Six decimal places is
 * what the ECB, the Bank of England and every commercial feed publish, so
 * nothing is lost by not going further.
 */

/** One millionth. A rate of exactly 1 is `RATE_ONE`. */
export const RATE_ONE = 1_000_000

/** Raised when a conversion cannot honestly be done. */
export class RateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateError'
  }
}

/**
 * Converts an amount into the functional currency.
 *
 * The rate is *foreign → functional*: multiply the document amount by it. A
 * €4,000 invoice at 1.083500 is $4,334.00.
 *
 * ## The rounding rule, stated once
 *
 * Half away from zero, at the cent. Not banker's rounding: a business's books
 * are compared against invoices and bank statements produced by other people's
 * systems, and half-up is what almost all of them do. Being consistently
 * half-a-cent different from everybody is a worse outcome than the statistical
 * bias half-up is criticised for.
 *
 * Applied to the *whole* amount rather than line by line, wherever a whole is
 * available. Converting each line and summing gives a different answer from
 * converting the sum, and the customer's invoice total is the number that has
 * to be right.
 */
export function convert(amountCents: number, rateMillionths: number): number {
  const amount = whole(amountCents, 'amount')
  const rate = whole(rateMillionths, 'rate')

  if (rate <= 0) {
    throw new RateError('An exchange rate has to be greater than zero.')
  }

  // Integer arithmetic throughout. `amount * rate` can exceed 2^53 for very
  // large sums at large rates, so the division is done on the product with a
  // rounding term added first rather than by converting to a float.
  const sign = amount < 0 ? -1 : 1
  const magnitude = Math.abs(amount)
  const scaled = magnitude * rate

  if (!Number.isSafeInteger(scaled)) {
    throw new RateError(
      `${formatCents(amount)} at a rate of ${describeRate(rate)} is too large to convert exactly. ` +
        'Split it into smaller documents.',
    )
  }

  return sign * Math.round(scaled / RATE_ONE)
}

/**
 * The rate implied by an amount and what it was booked at.
 *
 * Used to restate a *part* of a document at the rate the whole was raised at —
 * a payment settling half a foreign invoice must be relieved from receivables
 * at the invoice's original rate, not at today's, or the remaining balance
 * stops reconciling.
 */
export function rateFrom(amountCents: number, functionalCents: number): number {
  const amount = whole(amountCents, 'amount')
  if (amount === 0) {
    throw new RateError('A rate cannot be worked out from an amount of nothing.')
  }
  return Math.round((whole(functionalCents, 'amount') * RATE_ONE) / amount)
}

export type Settlement = {
  /** The document amount being settled, in its own currency. */
  amountCents: number
  /** What it was carried at, at the rate the document was raised. */
  carriedCents: number
  /** What it turned into, at the rate on the day it was paid. */
  receivedCents: number
  /**
   * Received less carried. Positive is a gain, negative a loss.
   *
   * For a *receivable*. On a payable the sign is the other way round, which the
   * caller flips — putting that here would need this function to know which
   * side of the balance sheet it is on, and it does not.
   */
  gainCents: number
  realised: boolean
}

/**
 * What settling a foreign document at a different rate actually earned or cost.
 *
 * ## This is a real gain, not a rounding artefact
 *
 * An invoice for €4,000 raised when the rate was 1.0835 put $4,334.00 into
 * receivables. If it is paid when the rate is 1.1000, $4,400.00 arrives. The
 * business is $66.00 better off, and that $66.00 is not revenue — nothing more
 * was sold. It is a **foreign exchange gain**, and it belongs on the profit and
 * loss as one, in its own account, where somebody can see how much of the
 * year's result came from currency rather than from trading.
 *
 * Folding it into revenue would overstate sales; folding it into the receivable
 * would leave the control account permanently out of step with the invoices
 * behind it, which is the drift Phase 31 exists to catch.
 *
 * It is **realised** because the money actually arrived. The same arithmetic
 * applied to a bill that is still open produces an *unrealised* figure — a
 * different thing, reported rather than posted, because the rate can move back
 * before anybody pays.
 */
export function settlementFor(input: {
  amountCents: number
  /** The rate the document was raised at. */
  documentRateMillionths: number
  /** The rate on the day the money moved. */
  paymentRateMillionths: number
}): Settlement {
  const amountCents = whole(input.amountCents, 'amount')
  const carriedCents = convert(amountCents, input.documentRateMillionths)
  const receivedCents = convert(amountCents, input.paymentRateMillionths)

  return {
    amountCents,
    carriedCents,
    receivedCents,
    gainCents: receivedCents - carriedCents,
    realised: true,
  }
}

export type Revaluation = {
  /** What is still owed, in the document's currency. */
  outstandingCents: number
  /** What the books currently carry it at. */
  carriedCents: number
  /** What it would be worth at the closing rate. */
  restatedCents: number
  /** Restated less carried. Positive is a gain nobody has yet received. */
  unrealisedCents: number
}

/**
 * What an open foreign balance would be worth if it were settled today.
 *
 * Reported, never posted — see the module's own decision in the ADR. The rate
 * can move back before anybody pays, and a business that booked every month's
 * movement as profit and loss would have a result driven by a number it does
 * not control and has not received.
 */
export function revalue(input: {
  outstandingCents: number
  documentRateMillionths: number
  closingRateMillionths: number
}): Revaluation {
  const outstandingCents = whole(input.outstandingCents, 'amount')
  const carriedCents = convert(outstandingCents, input.documentRateMillionths)
  const restatedCents = convert(outstandingCents, input.closingRateMillionths)

  return {
    outstandingCents,
    carriedCents,
    restatedCents,
    unrealisedCents: restatedCents - carriedCents,
  }
}

/** A rate as somebody would write it: 1.083500. */
export function describeRate(rateMillionths: number): string {
  return (whole(rateMillionths, 'rate') / RATE_ONE).toFixed(6)
}

/**
 * A typed rate — "1.0835" — as millionths.
 *
 * Parsed digit by digit rather than through `parseFloat`, for the same reason
 * every amount in this codebase is an integer: `1.0835 * 1_000_000` is
 * `1083499.9999999999` on some inputs and the right answer on others, and which
 * one you get depends on the number. Reading the two halves of the decimal
 * separately has no such moods.
 *
 * A comma decimal separator is a refusal rather than a silent success: "1,0835"
 * read as an English number is 10,835, which would convert a €4,000 invoice into
 * a $43,340,000 one. Better to say so.
 */
export function parseRate(text: string): number {
  const trimmed = text.trim()

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new RateError(
      trimmed.includes(',')
        ? `"${text}" uses a comma. Write it with a full stop, like 1.0835.`
        : `"${text}" is not an exchange rate. Write it like 1.0835.`,
    )
  }

  const [units, fraction = ''] = trimmed.split('.')
  // Six places is what published feeds carry; a seventh is rounded rather than
  // refused, because somebody pasting more precision than we store has not made
  // a mistake.
  const padded = (fraction + '0000000').slice(0, 7)
  const millionths = Number(units) * RATE_ONE + Math.round(Number(padded) / 10)

  if (millionths <= 0) {
    throw new RateError('An exchange rate has to be greater than zero.')
  }
  if (!Number.isSafeInteger(millionths)) {
    throw new RateError(`"${text}" is too large to be an exchange rate.`)
  }

  return millionths
}

/** Whether a document needs converting at all. */
export function isForeign(documentCurrency: string, functionalCurrency: string): boolean {
  return normalise(documentCurrency) !== normalise(functionalCurrency)
}

/**
 * A currency code, checked for shape rather than against a list.
 *
 * Three letters, upper case. Deliberately not validated against ISO 4217: that
 * list changes, a business may keep books in something this application has
 * never heard of, and refusing a real currency is a worse failure than
 * accepting a typo somebody can see on their own screen.
 */
export function normalise(code: string): string {
  const trimmed = code.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(trimmed)) {
    throw new RateError(`"${code}" is not a currency code. Three letters, like USD or EUR.`)
  }
  return trimmed
}

/** An integer, or a refusal. Never `NaN` reaching a journal line. */
function whole(value: number, what: 'amount' | 'rate'): number {
  if (!Number.isFinite(value)) {
    throw new RateError(
      what === 'rate'
        ? 'That is not an exchange rate.'
        : 'That is not an amount of money.',
    )
  }
  return Math.round(value)
}
