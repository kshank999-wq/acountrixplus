/**
 * Tax rounded once per code, not once per line (Phase 145).
 *
 * ## What is wrong today
 *
 * `priceDocumentTax` rounds every line on its own base and adds the results up.
 * So an invoice carrying six lines under one tax code charges a tax figure that
 * is not `round(base × rate)` for the base printed beside it — on the document
 * the customer receives, under the jurisdiction it names. `recordDocumentTax`
 * then stores those per-line figures as the breakdown and `salesTaxReturn` sums
 * them, so the return inherits it.
 *
 * Measured, over sets of lines under one code at 8.25%, values between $5 and
 * $505, three hundred sets at each size:
 *
 * ```
 * lines   worst drift   sets where the total does not foot
 *    50          7c     249 / 300
 *   400         19c     279 / 300
 *  2000         50c     292 / 300
 * 10000         75c     300 / 300
 * ```
 *
 * Reproduced by `tests/tax-rounding.test.ts` rather than quoted from a script
 * that no longer exists — the first version of this table was measured with a
 * generator whose stream carried across the four sizes, and three of its four
 * rows were wrong by the time the test restarted it per size.
 *
 * The amounts are small and that is not the point. Tax on a document is
 * checked by recomputing it from the base, and a document that fails that check
 * is queried whatever the size of the difference — the business then has to
 * explain a number it cannot derive, because the figure came from a hundred
 * separate roundings that are not written down anywhere.
 *
 * ## What this does not fix, and cannot
 *
 * A return aggregates many documents, and `round(a × r) + round(b × r)` is not
 * `round((a + b) × r)` however each document was rounded. Once an invoice has
 * charged a whole number of cents, that is the money that changed hands; a
 * later period cannot re-round it. So the return's own base-times-rate check
 * will still show a few cents against a quarter, and that is inherent rather
 * than a defect.
 *
 * The level where the identity is actually required is the **document**, which
 * is what somebody holds in their hand and what an auditor recomputes, and that
 * is the level this repairs. What it removes at the return level is the part of
 * the drift that comes from rounding each line — hundreds of roundings per
 * document rather than one per code.
 *
 * ## The rule
 *
 * Round **once per tax code**, on that code's combined base, and split the
 * rounded figure back across the lines that made it up. Every level then foots:
 *
 * - each line's share sums to its code's total, by construction;
 * - each code's total is `round(base × rate)`, which is what the return prints;
 * - the codes sum to the document, which is what the invoice header carries.
 *
 * Rounding once on the *document* — which is what `taxOn`'s own comment asks
 * for — cannot be done, because a document's lines may carry different codes
 * and a return reports per jurisdiction. There would be no per-code figure to
 * print, and splitting one document-wide number back out by code is the same
 * problem moved up a level.
 *
 * ## No database, no clock
 *
 * Rates arrive as a lookup the caller supplies. The wiring pass is what turns
 * that into a read of `taxCodes`; this is the arithmetic on its own, which is
 * the half that can be tested exhaustively.
 */

import { splitExactly } from '@/modules/money/splitting'

/** A line to be taxed. `taxCents` is an override the caller has already decided. */
export type TaxLineInput = {
  taxCodeId: string
  taxableCents: number
  /** Set when somebody has typed the tax rather than derived it. */
  taxCents?: number
}

export type PricedTaxLine = {
  taxCodeId: string
  taxableCents: number
  taxCents: number
  /** False when the figure was overridden, so nothing claims it follows the rate. */
  derived: boolean
}

export type TaxCodeTotal = {
  taxCodeId: string
  /** Everything under this code, overridden lines included. */
  taxableCents: number
  taxCents: number
  /** Only the part the rate was applied to, which is the part that must foot. */
  derivedTaxableCents: number
  derivedTaxCents: number
}

export type PerCodeTax = {
  /** In the order they were given, so a caller can zip them back to its own rows. */
  lines: PricedTaxLine[]
  byCode: TaxCodeTotal[]
  totalCents: number
}

/**
 * Tax on a base at a rate in basis points.
 *
 * Deliberately a second statement of what `taxOn` does rather than an import of
 * it: `sales-tax.ts` reaches the database in the same file, and a core that
 * claims to need no database should not pull one in through a helper. Two
 * answers to one question is the defect this project keeps naming, so the test
 * holds these two to each other across the whole range rather than trusting
 * that they agree.
 */
export function taxAtRate(taxableCents: number, rateBp: number): number {
  return Math.round((taxableCents * rateBp) / 10_000)
}

/**
 * Prices a document's tax lines, rounding once per code.
 *
 * Lines carrying an override keep their figure untouched and are kept out of
 * the rounding: the rate was not what produced them, so including their base in
 * the group would make the derived part of the group foot to the wrong number.
 * They still count towards the code's reported total, because the return has to
 * report the money that was actually charged.
 */
export function taxPerCode(
  lines: readonly TaxLineInput[],
  rateFor: (taxCodeId: string) => number,
): PerCodeTax {
  if (lines.length === 0) return { lines: [], byCode: [], totalCents: 0 }

  // First-seen order, so a document's breakdown reads in the order its lines
  // do rather than in whatever order a Map or a sort happens to produce.
  const codes: string[] = []
  for (const line of lines) {
    if (!codes.includes(line.taxCodeId)) codes.push(line.taxCodeId)
  }

  const priced = new Array<PricedTaxLine>(lines.length)
  const byCode: TaxCodeTotal[] = []

  for (const taxCodeId of codes) {
    const indices = lines
      .map((line, index) => ({ line, index }))
      .filter((row) => row.line.taxCodeId === taxCodeId)

    const overridden = indices.filter((row) => row.line.taxCents !== undefined)
    const derived = indices.filter((row) => row.line.taxCents === undefined)

    for (const row of overridden) {
      priced[row.index] = {
        taxCodeId,
        taxableCents: row.line.taxableCents,
        taxCents: row.line.taxCents as number,
        derived: false,
      }
    }

    const derivedTaxableCents = derived.reduce((sum, row) => sum + row.line.taxableCents, 0)
    const derivedTaxCents =
      derived.length === 0 ? 0 : taxAtRate(derivedTaxableCents, rateFor(taxCodeId))

    // The one rounding for this code, split back across the lines that made it.
    const shares = splitExactly(
      derivedTaxCents,
      derived.map((row) => row.line.taxableCents),
    )

    derived.forEach((row, position) => {
      priced[row.index] = {
        taxCodeId,
        taxableCents: row.line.taxableCents,
        taxCents: shares[position],
        derived: true,
      }
    })

    byCode.push({
      taxCodeId,
      taxableCents: indices.reduce((sum, row) => sum + row.line.taxableCents, 0),
      taxCents:
        derivedTaxCents + overridden.reduce((sum, row) => sum + (row.line.taxCents as number), 0),
      derivedTaxableCents,
      derivedTaxCents,
    })
  }

  return {
    lines: priced,
    byCode,
    totalCents: byCode.reduce((sum, code) => sum + code.taxCents, 0),
  }
}

/** A code whose reported tax cannot be got back from its reported base. */
export type FootingFailure = {
  taxCodeId: string
  taxableCents: number
  rateBp: number
  reportedCents: number
  recomputedCents: number
  differenceCents: number
}

/**
 * The check a tax authority performs, run against our own figures first.
 *
 * Returns the codes that fail it, so the caller gets the list rather than a
 * boolean it would have to go and investigate. Only the derived part is
 * checkable — a line somebody typed a tax figure onto is not claiming to follow
 * the rate, and asserting it does would make this disagree about something it
 * was never told.
 */
export function doesNotFoot(
  byCode: readonly TaxCodeTotal[],
  rateFor: (taxCodeId: string) => number,
): FootingFailure[] {
  const failures: FootingFailure[] = []

  for (const code of byCode) {
    const rateBp = rateFor(code.taxCodeId)
    const recomputedCents = taxAtRate(code.derivedTaxableCents, rateBp)
    if (recomputedCents === code.derivedTaxCents) continue

    failures.push({
      taxCodeId: code.taxCodeId,
      taxableCents: code.derivedTaxableCents,
      rateBp,
      reportedCents: code.derivedTaxCents,
      recomputedCents,
      differenceCents: code.derivedTaxCents - recomputedCents,
    })
  }

  return failures
}

/**
 * What the current per-line rounding produces, kept so the difference can be
 * measured rather than asserted.
 *
 * This is `priceDocumentTax`'s arithmetic with the database taken out of it.
 * A test that only checked the new rule would be a test that agrees with
 * itself; Phase 121's rule wants the two side by side, and the drift table at
 * the top of this file is what that comparison produces.
 */
export function taxPerLine(
  lines: readonly TaxLineInput[],
  rateFor: (taxCodeId: string) => number,
): number {
  return lines.reduce(
    (sum, line) => sum + (line.taxCents ?? taxAtRate(line.taxableCents, rateFor(line.taxCodeId))),
    0,
  )
}
