/**
 * Adding up documents that are not in one currency (Phase 152).
 *
 * ## The three sums this was built for
 *
 * `BLIND_FACE_SUMS` held three from Phase 143 until this one, each adding a
 * face amount across documents that may be denominated in anything:
 *
 * ```
 * contractorPayments   payment_applications.amount_cents, against a 1099 threshold
 * salesTaxReturn       document_tax_lines.taxable_cents, filed with an authority
 * cashBasisCaveats     invoices.tax_cents, to caveat a report
 * ```
 *
 * Two of the three decide something a tax authority sees. A contractor paid
 * €600 contributed 60,000 to a total measured against a $600 threshold, so a
 * 1099 was filed — or not filed — on a number that added whatever currencies
 * the vendor happened to be paid in.
 *
 * Those two convert, through `functionalSumSql`. The third did not need a
 * conversion at all, and `faceSumStands` below is where that turned out.
 *
 * ## Each document at its own rate, and why that is not the tax defect again
 *
 * Phase 145 found `priceDocumentTax` rounding each line and adding the results
 * up, and repaired it by rounding once on the whole. This does the opposite —
 * converts each document and adds — and the two are not in tension, because
 * ADR 0147 named the question that separates them: **which came first, the
 * whole or the parts.**
 *
 * A code's tax is `round(base × rate)` and the lines are carved out of it, so
 * the whole comes first. A period's sales are a set of invoices, each already
 * raised, each already posted to the ledger at its own carried rate — the parts
 * came first, and their sum is the whole by definition. Converting the total at
 * some single rate would be inventing a rate no document was raised at.
 *
 * It is the same argument `createDeposit` makes about receipts, which ADR 0147
 * recorded as the counter-example that made the distinction visible.
 *
 * ## One expression, two languages
 *
 * These sums happen in SQL, because they are aggregates over a period. The
 * arithmetic also exists in `convert`, in TypeScript, and two statements of one
 * question is the defect this project keeps naming — so `functionalSumSql` and
 * `functionalSum` are declared together here and a test holds them to each
 * other across a range of amounts and rates rather than trusting that they
 * agree.
 *
 * Both round half away from zero at the cent: Postgres `round(numeric)` does,
 * and `convert` says it does and explains why.
 */

import { sql, type SQL } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import { convert, RATE_ONE } from '@/modules/fx/rates'

/**
 * A money column converted at its document's own rate, summed.
 *
 * The rate column is nullable in practice — a left join to payments leaves it
 * null for a vendor paid nothing — so it falls back to `RATE_ONE`, which is
 * the identity. A missing rate on a row with a missing amount converts nothing
 * and adds nothing.
 */
export function functionalSumSql(amountColumn: AnyColumn, rateColumn: AnyColumn): SQL<string> {
  return sql<string>`coalesce(sum(round((${amountColumn}::numeric * coalesce(${rateColumn}, ${RATE_ONE})::numeric) / ${RATE_ONE}::numeric)), 0)`
}

/** The same arithmetic in TypeScript, for rows that come back before they are added. */
export function functionalSum(
  rows: ReadonlyArray<{ amountCents: number; rateMillionths: number | null }>,
): number {
  return rows.reduce(
    (total, row) => total + convert(row.amountCents, row.rateMillionths ?? RATE_ONE),
    0,
  )
}

/**
 * What a sum of face amounts is worth saying at all.
 *
 * Pure, and the decision `cashBasisCaveats` turned out to need rather than a
 * conversion: that function summed `invoices.tax_cents` across every currency
 * and used the result **only** as `> 0`. Nothing printed it. Its own sibling
 * three lines above had already met this and answered it — the unapplied
 * payments query counts rows now, with a comment saying the sum was "deleted
 * rather than converted", because "converting a number with no reader would
 * only make it a correct number nobody wants".
 *
 * So the question a blind sum has to answer first is not *what rate* but
 * *who reads it*, and a presence test does not need money at all.
 */
export type SumPurpose =
  /** Somebody sees this figure, or a threshold is measured against it. */
  | 'reported'
  /** Only its presence is tested. A count answers the same question. */
  | 'presence'

export type SumVerdict =
  | { sound: true; how: 'converted' | 'counted' }
  | { sound: false; why: string }

export function faceSumStands(input: {
  purpose: SumPurpose
  /** Measured: does the sum convert each row at its document's rate? */
  converts: boolean
  /** Measured: is it a count rather than a sum of money? */
  counts: boolean
}): SumVerdict {
  if (input.purpose === 'presence') {
    if (input.counts) return { sound: true, how: 'counted' }
    return {
      sound: false,
      why:
        'Only the presence of this figure is tested, and it is a sum of money across documents ' +
        'that may be in any currency. Count the rows instead — converting a number with no ' +
        'reader makes it a correct number nobody wants.',
    }
  }

  if (input.converts) return { sound: true, how: 'converted' }

  return {
    sound: false,
    why:
      'This figure is reported or compared against a threshold, and it adds face amounts across ' +
      'documents without converting them. A euro invoice and a dollar invoice add to a number in ' +
      'neither currency, and somebody files it.',
  }
}

/**
 * The property every currency carrier holds its rate in.
 *
 * Declared rather than spelled out at each call site, because the check below
 * is only worth anything if it is looking for the right name.
 */
export const RATE_PROPERTY = 'exchangeRateMillionths'

/** A `functionalSumSql` call, as the source writes its two arguments. */
export type ConvertedSumSite = {
  /** `documentTaxLines.taxableCents` */
  amount: string
  /** `invoices.exchangeRateMillionths` */
  rate: string
}

/**
 * Whether a converted sum is actually converting anything.
 *
 * ## Why this exists at all
 *
 * Repairing the three blind sums moved their arithmetic behind
 * `functionalSumSql`, and the scan that had been watching them matches
 * ``sum(${table.column})`` in the source. So the repair made the sites
 * **invisible to the check that found them** — the same shape as every
 * scan-reach defect from Phase 128 onward, arriving this time as a consequence
 * of a fix rather than of a new feature.
 *
 * Declaring the new form is half of it. The other half is that the form can be
 * written wrong in a way that looks right, which is what makes this a check
 * rather than a rubber stamp:
 *
 * **The rate can come from a table the query never joins.** `functionalSumSql`
 * coalesces a null rate to `RATE_ONE`, because a left join to payments leaves
 * it null for a vendor paid nothing and that row must add zero rather than
 * vanish. The cost of that kindness is that a rate column belonging to a table
 * which is not in the query at all also reads as `RATE_ONE` — for **every**
 * row. The result is face amounts wearing a conversion: identical to the
 * defect, and now with a helper's name on it saying it was handled.
 *
 * `salesTaxReturn` needed a `leftJoin(invoices, …)` added for exactly this
 * reason. Nothing would have said so.
 */
export function convertedSumStands(
  site: ConvertedSumSite,
  /** Measured: the tables the enclosing query names in a `from` or a join. */
  tablesInScope: ReadonlySet<string>,
): SumVerdict {
  const [rateTable, rateProperty] = site.rate.split('.')

  if (rateProperty !== RATE_PROPERTY) {
    return {
      sound: false,
      why:
        `The second argument to functionalSumSql is \`${site.rate}\`, which is not a rate. It is ` +
        `multiplied by the amount and divided by a million, so whatever this column holds is ` +
        `being treated as an exchange rate.`,
    }
  }

  if (!tablesInScope.has(rateTable)) {
    return {
      sound: false,
      why:
        `\`${site.rate}\` is the rate, and \`${rateTable}\` is not in this query's from or joins. ` +
        `A rate column from a table that was never joined is null on every row, and ` +
        `functionalSumSql coalesces null to RATE_ONE — so this sums face amounts and looks ` +
        `converted while doing it.`,
    }
  }

  return { sound: true, how: 'converted' }
}
