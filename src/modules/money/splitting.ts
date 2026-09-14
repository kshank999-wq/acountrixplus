/**
 * A whole split into parts (Phase 145).
 *
 * ## The defect this was built for
 *
 * `taxOn` in `sales-tax.ts` carries this sentence, and has since it was written:
 *
 * > Pure, and rounded **once on the total** rather than per line. Rounding each
 * > line and adding them up drifts by up to half a cent per line, and a return
 * > that does not foot against the invoices behind it is a return somebody has
 * > to reconcile by hand.
 *
 * Its only pricing caller rounds each line and adds them up. `priceDocumentTax`
 * calls `taxOn` inside a `.map` and totals the results, the per-line figures are
 * what get recorded as the breakdown, and the sales tax return sums those. So
 * the return reports a taxable base and a tax collected that do not satisfy
 * `round(base × rate)` — the one arithmetic check the authority receiving it
 * will perform.
 *
 * That is ADR 0110's shape exactly: **a declaration argued from a fact that is
 * not a fact.** The sentence is right about the arithmetic and wrong about the
 * code underneath it.
 *
 * ## Why rounding once on the *document* total is also wrong
 *
 * The obvious repair — round once on the whole document — is what the sentence
 * literally says, and it cannot be done. A document's lines can carry different
 * tax codes, and a return reports **per jurisdiction**. A single document-wide
 * rounding has no per-code figure to report, so the return would have to split
 * one rounded number back out by code and would be in exactly the same position
 * one level up.
 *
 * The rule that actually holds is narrower and is the one this module
 * implements: **round once per code, on that code's own base, and split the
 * rounded figure back across the lines it came from.** Then every level foots —
 * the lines sum to the code, the codes sum to the document, and each code's
 * figure is `round(base × rate)` for a base the return can print beside it.
 *
 * ## The general shape, and the four places that already know it
 *
 * Splitting a whole into parts that must add back to the whole is not a tax
 * problem. This codebase solves it in four places already, each with its own
 * implementation and its own paragraph explaining the same insight:
 *
 * ```
 * prorate          ledger/cash-basis.ts    last weight takes what is left
 * scaleSigned      ledger/cash-basis.ts    same, in signed cents
 * consume          inventory/costing.ts    two clamps, last lot touched and emptied lots
 * splitFor         appointments/split.ts   reports the residue rather than placing it
 * ```
 *
 * Four copies of one rule is what ADR 0140 found in the scanners and ADR 0116
 * named before that: four things that can drift apart. `SPLIT_SITES` below is
 * the register of them, so the fifth has somewhere to be declared instead of
 * being written from scratch a fifth time.
 */

import { RegistryError } from '@/modules/errors/registry'

/**
 * Splits a whole across weights so the parts sum to the whole **exactly**.
 *
 * Largest remainder: every part takes its floor share, and the cents left over
 * go one at a time to the parts whose exact share lost the most in the floor.
 * The result is that no part is ever more than one cent from its exact share —
 * a property the last-takes-the-residue rule in `prorate` does not have, since
 * there the final part absorbs however much the others dropped between them.
 *
 * For a tax breakdown that matters: `prorate` would put the whole of a
 * document's rounding onto one line, so that line's tax visibly is not its own
 * base times the rate, and the person reading the invoice has no way to tell
 * that from a mistake.
 *
 * ## Why BigInt
 *
 * The share of a weight is `whole × weight ÷ total`, and `whole × weight`
 * overflows the exact-integer range of a double long before either factor is
 * unreasonable — a $10,000,000 base against a $10,000,000 weight is 10^18,
 * and doubles stop counting in ones just past 9×10^15. Every implementation
 * listed in `SPLIT_SITES` computes that product in floating point. None of them
 * is wrong at the sizes this codebase sees, and all of them are wrong at some
 * size, which is a bad property for the one function everything else is meant
 * to call. The multiply and the remainder are done in `BigInt` here so the
 * question does not arise; the shares come back as numbers because cents are.
 */
export function splitExactly(wholeCents: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(wholeCents)) {
    throw new RangeError(`A whole to split must be a whole number of cents, not ${wholeCents}.`)
  }
  if (weights.length === 0) return []
  if (weights.some((weight) => !Number.isInteger(weight) || weight < 0)) {
    throw new RangeError('Weights must be whole numbers of cents and none may be negative.')
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total === 0) return weights.map(() => 0)

  // Sign is carried outside the split so that a credit note divides the same
  // way its invoice did. Flooring a negative would round the wrong direction
  // and the residue would land on a different part.
  const sign = wholeCents < 0 ? -1 : 1
  const whole = BigInt(Math.abs(wholeCents))
  const divisor = BigInt(total)

  const shares = weights.map((weight) => Number((whole * BigInt(weight)) / divisor))
  const dropped = weights.map((weight) => (whole * BigInt(weight)) % divisor)

  let residue = Math.abs(wholeCents) - shares.reduce((sum, share) => sum + share, 0)

  // The cent goes where the most was dropped; ties to the larger part, where a
  // cent is the smallest proportional distortion; then to the earlier one, so
  // that the same input always splits the same way. An allocation that is not
  // deterministic is one that settles different lines on different runs, which
  // is the fault `byOldest` exists to avoid a few modules over.
  const order = weights
    .map((weight, index) => ({ index, weight }))
    .sort(
      (a, b) =>
        (dropped[b.index] > dropped[a.index] ? 1 : dropped[b.index] < dropped[a.index] ? -1 : 0) ||
        b.weight - a.weight ||
        a.index - b.index,
    )

  for (let taken = 0; residue > 0; taken++, residue--) {
    shares[order[taken].index] += 1
  }

  return shares.map((share) => share * sign)
}

/** How a site places the cents that flooring or rounding leaves over. */
export type ResiduePolicy =
  /** The last part takes whatever is left, however much that is. */
  | 'last-takes-it'
  /** One cent each to the parts that dropped the most. */
  | 'largest-remainder'
  /** The parts are computed independently and the residue is reported, not placed. */
  | 'reported'
  /** The parts are computed independently and the residue is left where it falls. */
  | 'unplaced'

export type SplitSite = {
  file: string
  symbol: string
  policy: ResiduePolicy
  /** Does the whole exist before the parts do? */
  wholeIsIndependent: boolean
  /** Why this site splits the way it does, argued. */
  because: string
}

/**
 * Every place this codebase divides a money whole into parts.
 *
 * Declared rather than scanned, for the reason ADR 0123 gave: a wider regex
 * over `Cents * x / y` matches thirty-five sites and nearly all of them are a
 * **rate applied to a base** — tax on a taxable amount, a markup on a cost, a
 * commission on a service — where there is no whole that the answers have to
 * add back to. Those are not splits and a register that called them splits
 * would be wrong about most of its entries.
 *
 * The distinguishing question is `wholeIsIndependent`: was there a total before
 * the parts were computed, which the parts must now reproduce? For a FIFO
 * consumption there was — the lots hold a value already. For a markup there was
 * not; the marked-up figure is created by the multiplication.
 */
export const SPLIT_SITES: readonly SplitSite[] = [
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'prorate',
    policy: 'last-takes-it',
    wholeIsIndependent: true,
    because:
      'The original statement of the rule in this codebase, and the one the others were written ' +
      'beside. Correct on the total and weaker per part: the final weight absorbs everything the ' +
      'others dropped, so with many small parts its share can sit several cents away from its own ' +
      'proportion. Acceptable where the parts are ledger legs nobody reads individually.',
  },
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'scaleSigned',
    policy: 'last-takes-it',
    wholeIsIndependent: true,
    because:
      'The same rule in signed cents, and the reason it exists is recorded in its own comment: ' +
      'pro-rating unsigned amounts gave shares of the right size and the wrong direction for a ' +
      'document whose legs do not all sit on one side. A second implementation because the first ' +
      'could not express the sign, which is the cost of having the rule in four places.',
  },
  {
    file: 'src/modules/inventory/costing.ts',
    symbol: 'consume',
    policy: 'last-takes-it',
    wholeIsIndependent: true,
    because:
      'Two clamps rather than one, and the second is a constraint the other sites do not have: a ' +
      'lot emptied along the way must give up exactly its remaining value, or it is left holding ' +
      'cents with no quantity behind them. The residue rule alone would satisfy the total and ' +
      'still leave value stranded in an empty lot, so this site needs both and says so.',
  },
  {
    file: 'src/modules/appointments/split.ts',
    symbol: 'splitFor',
    policy: 'reported',
    wholeIsIndependent: true,
    because:
      'The one site that places no residue and is right not to. A commission split is a figure ' +
      'somebody is paid and a figure the business keeps, and moving a cent between them to make ' +
      'the arithmetic close is a decision about wages. It returns `roundingCents` and lets the ' +
      'caller decide, which is the honest answer where the parts belong to different people.',
  },
  {
    file: 'src/modules/payroll/sales-tax.ts',
    symbol: 'priceDocumentTax',
    policy: 'unplaced',
    wholeIsIndependent: false,
    because:
      'The defect Phase 145 was built for, and the only entry here whose whole does not exist ' +
      'first — which is the fault rather than an exemption. Each line is rounded on its own base ' +
      'and the results are added, so the document total is whatever the per-line roundings happen ' +
      'to sum to, and no level of the return satisfies round(base times rate). It is registered ' +
      'rather than repaired because the staging pass holds the wiring.',
  },
]

/** The split rule declared for a site. Throws on a site nobody declared. */
export function splitSiteFor(file: string, symbol: string): SplitSite {
  const site = SPLIT_SITES.find((row) => row.file === file && row.symbol === symbol)
  if (!site) {
    throw new RegistryError({
      registry: 'SPLIT_SITES',
      key: `${file}:${symbol}`,
      message:
        `No split rule is declared for ${symbol} in ${file}. A function that divides a whole into ` +
        'parts has to say where the cents that do not divide are put, because every answer to ' +
        'that is defensible and only one of them is what the parts are read as meaning.',
    })
  }
  return site
}
