import { formatCents } from '@/lib/money'
import { functionalAmounts } from './denomination'
import { RATE_ONE, describeRate, isForeign, normalise } from './rates'

/**
 * What a document about to be raised will be worth, and in what (spec §35,
 * Phase 64).
 *
 * ## Why this exists
 *
 * Phases 60 through 63 taught every screen downstream to handle a foreign
 * document correctly — the payables queue, the statement, the chase decision,
 * the credit note. ADR 0063 recorded what none of them fixed:
 *
 * > **A foreign invoice still cannot be raised from the UI.** The invoice
 * > composer has no currency field, so euro documents arrive only through
 * > seeding or the API.
 *
 * Four phases of work reachable only by seeding is not a feature anybody has.
 * This is the composer's half: which currencies may be chosen, and what the
 * document will actually book at once one is.
 *
 * ## Why the preview matters more than it looks
 *
 * A document's rate is **fixed at issue and never recomputed** — that is Phase
 * 35's rule, and Phase 63 restated it for credit notes. So the moment the
 * button is pressed is the last moment the number can be questioned. A composer
 * that takes "EUR" and says nothing leaves somebody to discover on the profit
 * and loss, a month later, that a €4,000 invoice went on at a rate they would
 * have argued with.
 *
 * The preview therefore composes `functionalAmounts` rather than converting the
 * total: it has to be the *same arithmetic* the posting will do, or it is a
 * second answer that agrees by luck and drifts by a cent.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * The currencies a company may raise a document in.
 *
 * Its own always, and no rate is needed for it — a domestic document is not a
 * conversion. A foreign one only where a rate has been recorded at some point,
 * because `rateFor` will refuse anything else and offering a choice that cannot
 * be taken is Phase 47's defect: a refusal behind a button rather than on the
 * row.
 *
 * Home first, then the rest alphabetically. Home first because it is what all
 * but a handful of documents will be, and a composer that defaults to the
 * second-most-likely answer gets it wrong all day.
 */
export function offerableCurrencies(homeCurrency: string, withRates: string[]): string[] {
  const home = normalise(homeCurrency)
  const foreign = [...new Set(withRates.map(normalise))]
    .filter((code) => isForeign(code, home))
    .sort()

  return [home, ...foreign]
}

export type DocumentQuote = {
  /** The document's own total, in `currency`. */
  totalCents: number
  currency: string
  /** What it books at, in the company's own money. */
  functionalTotalCents: number
  homeCurrency: string
  rateMillionths: number
  /**
   * Null for a domestic document, and for a foreign one whose rate came from a
   * date earlier than the document's — `rateFor` walks backwards, so the rate
   * actually used is often not dated the same day.
   */
  rateDate: string | null
  /** Whether anything was converted at all. */
  foreign: boolean
  /** What to show a person, or null when there is nothing worth saying. */
  note: string | null
}

/**
 * What this document will be worth once raised.
 *
 * Returns a quote for a domestic document too, with `note` null: there is
 * nothing to say about a document that is already in the company's own money,
 * and a line reading "$4,000.00 books as $4,000.00 at 1.000000" is noise that
 * teaches a person to stop reading the line that matters.
 */
export function documentQuote(input: {
  lineCents: number[]
  taxCents?: number
  currency: string
  homeCurrency: string
  /** Millionths, from `rateFor`. `RATE_ONE` for the company's own currency. */
  rateMillionths: number
  rateDate: string | null
}): DocumentQuote {
  const currency = normalise(input.currency)
  const homeCurrency = normalise(input.homeCurrency)
  const foreign = isForeign(currency, homeCurrency)

  const totalCents =
    input.lineCents.reduce((sum, cents) => sum + cents, 0) + (input.taxCents ?? 0)

  // The same call the posting will make. Converting the total here instead
  // would preview a figure a cent away from what lands on the ledger.
  const { functionalTotalCents } = functionalAmounts({
    lineCents: input.lineCents,
    taxCents: input.taxCents,
    rateMillionths: foreign ? input.rateMillionths : RATE_ONE,
  })

  return {
    totalCents,
    currency,
    functionalTotalCents,
    homeCurrency,
    rateMillionths: foreign ? input.rateMillionths : RATE_ONE,
    rateDate: foreign ? input.rateDate : null,
    foreign,
    note: foreign
      ? describeQuote({
          totalCents,
          currency,
          functionalTotalCents,
          homeCurrency,
          rateMillionths: input.rateMillionths,
          rateDate: input.rateDate,
        })
      : null,
  }
}

/**
 * The sentence a person reads before pressing the button.
 *
 * It names the rate's own date when that is not the document's, because
 * `rateFor` walks backwards to the most recent rate on or before the issue
 * date. A quote that showed only the number would let somebody raise a document
 * in August at June's rate without ever being told which rate it was — and the
 * rate is fixed at issue, so there is no later moment to notice.
 */
function describeQuote(input: {
  totalCents: number
  currency: string
  functionalTotalCents: number
  homeCurrency: string
  rateMillionths: number
  rateDate: string | null
}): string {
  const dated = input.rateDate ? `, the rate of ${input.rateDate}` : ''

  return (
    `${formatCents(input.totalCents, input.currency)} books as ` +
    `${formatCents(input.functionalTotalCents, input.homeCurrency)} at ` +
    `${describeRate(input.rateMillionths)}${dated}. Fixed now and never recomputed, so the ` +
    'books keep saying what this was worth on the day.'
  )
}
