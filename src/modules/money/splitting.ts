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
 * splitFor         appointments/split.ts   the business takes what is left, and is told how much
 * ```
 *
 * Four copies of one rule is what ADR 0140 found in the scanners and ADR 0116
 * named before that: four things that can drift apart. `SPLIT_SITES` below is
 * the register of them, so the fifth has somewhere to be declared instead of
 * being written from scratch a fifth time.
 *
 * The `splitFor` line above read "reports the residue rather than placing it"
 * until Phase 147, which is what this file said about it and was not true:
 * `businessCents` is `totalCents - practitionerCents`, so the business absorbs
 * the residue like any other last part and `roundingCents` says how much. The
 * registry built to catch a declaration argued from a fact that is not a fact
 * held one, for two phases, about the code next to it.
 */

import { RegistryError } from '@/modules/errors/registry'
import type { Provenance } from '@/modules/money/division'

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

/**
 * How a site places the cents that flooring or rounding leaves over.
 *
 * `reported` — the parts computed independently and the residue handed back
 * rather than placed — was a member here until Phase 147 and no site was ever
 * it. It was declared for `splitFor` on a reading of that function which turned
 * out to be wrong, and once the entry was corrected nothing was left that the
 * value described. A union member with no instance reads like a case somebody
 * handled, so it is gone rather than kept in case.
 */
export type ResiduePolicy =
  /** The last part takes whatever is left, however much that is. */
  | 'last-takes-it'
  /** One cent each to the parts that dropped the most. */
  | 'largest-remainder'
  /** The parts are computed independently and the residue is left where it falls. */
  | 'unplaced'
  /**
   * There is no residue to place, because the parts are the record: each was
   * already rounded and posted on its own, and the whole is their sum by
   * definition rather than a figure anybody rounds (Phase 147).
   */
  | 'parts-are-the-record'

export type SplitSite = {
  file: string
  symbol: string
  policy: ResiduePolicy
  /**
   * Which came first, the whole or the parts (Phase 147).
   *
   * A statement about the **money**, not about the code: `whole-first` means
   * the figure exists and the parts have to reproduce it, whatever this site
   * currently does. That is the point — `priceDocumentTax` is `whole-first`
   * *and* wrong, which is what makes it a defect rather than a design.
   *
   * It replaces Phase 145's `wholeIsIndependent`, which asked the same question
   * and could not be answered: for the tax site it meant `false` as built and
   * `true` as it should be, so the one field carried both answers and the
   * verdict function could not use it.
   */
  provenance: Provenance
  /**
   * Which declared form of division reaches this site (Phase 147), or `null`
   * when none does.
   *
   * `null` is the entry that has to argue hardest: a site no form can see is
   * one the scan is taking on trust, and saying which are those is the
   * difference between a registry held to the source and a list.
   */
  foundBy: 'proportional' | 'equal' | 'handed_over' | null
  /** Why this site splits the way it does, argued. */
  because: string
}

/**
 * Every place this codebase divides a money whole into parts.
 *
 * Held to the source by `DIVISION_FORMS` since Phase 147. Before that it was
 * declared and unscanned, for the reason ADR 0123 gave: a wider regex over
 * `Cents * x / y` matches thirty-five sites and nearly all of them are a
 * **rate applied to a base** — tax on a taxable amount, a markup on a cost, a
 * commission on a service — where there is no whole that the answers have to
 * add back to. Those are not splits and a register that called them splits
 * would be wrong about most of its entries.
 *
 * What made a scan possible was finding the line that separates the two: a
 * **constant** divisor converts units and a **variable** one is a total that
 * something is a share of. Measured, that is thirteen rates and seven shares,
 * and the noise ADR 0145 was afraid of does not appear.
 *
 * The distinguishing question is `provenance`: is there a total that the parts
 * must reproduce? For a FIFO consumption there is — the lots hold a value
 * already. For a markup there is not; the marked-up figure is created by the
 * multiplication. And for a deposit the parts came first, each receipt having
 * been posted at its own rate before the slip was made up.
 */
export const SPLIT_SITES: readonly SplitSite[] = [
  {
    file: 'src/modules/ledger/cash-basis.ts',
    symbol: 'prorate',
    policy: 'last-takes-it',
    provenance: 'whole-first',
    foundBy: 'proportional',
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
    provenance: 'whole-first',
    foundBy: 'proportional',
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
    provenance: 'whole-first',
    foundBy: 'proportional',
    because:
      'Two clamps rather than one, and the second is a constraint the other sites do not have: a ' +
      'lot emptied along the way must give up exactly its remaining value, or it is left holding ' +
      'cents with no quantity behind them. The residue rule alone would satisfy the total and ' +
      'still leave value stranded in an empty lot, so this site needs both and says so.',
  },
  {
    file: 'src/modules/appointments/split.ts',
    symbol: 'splitFor',
    policy: 'last-takes-it',
    provenance: 'whole-first',
    foundBy: null,
    because:
      'Phase 145 declared this `reported` and said it "places no residue and is right not to", ' +
      'letting the caller decide. That was wrong, and Phase 147 found it by reading the code the ' +
      'scan pointed at: `businessCents` is `totalCents - practitionerCents`, so the business ' +
      'absorbs the residue like any other last part, and `roundingCents` tells somebody how much ' +
      'rather than asking them. No form reaches it because the split is a subtraction rather than ' +
      'a division — the practitioner share is rounded and the rest is what is left.',
  },
  {
    file: 'src/modules/payroll/tax-rounding.ts',
    symbol: 'taxPerCode',
    policy: 'largest-remainder',
    provenance: 'whole-first',
    foundBy: 'handed_over',
    because:
      'This entry was `priceDocumentTax` with `policy: unplaced` — the defect Phase 145 found, ' +
      'where each line was rounded on its own base and the results added up. Phase 151 wired the ' +
      'repair, so that function no longer divides anything: it hands the lines to `taxPerCode`, ' +
      'which rounds a code’s combined base once and splits the figure back across the lines it ' +
      'came from. The register follows the division rather than the caller, so the entry moved ' +
      'with it — and this is the only site here whose policy has ever changed.',
  },
  {
    file: 'src/modules/fx/ledger.ts',
    symbol: 'recoveryFunctional',
    policy: 'last-takes-it',
    provenance: 'whole-first',
    foundBy: 'proportional',
    because:
      'Found by the Phase 147 scan and declared by nobody before it, which is the reach failure ' +
      'this register was supposed to stop: a write-off carried at one pair of figures, recovered ' +
      'in instalments, is a whole divided into parts like any other. It is sound — the branch that ' +
      'returns the whole outstanding functional amount when the last of the face is recovered is ' +
      'the residue placement, and its comment says so — but nothing was holding it to that.',
  },
  {
    file: 'src/modules/banking/deposits.ts',
    symbol: 'createDeposit',
    policy: 'parts-are-the-record',
    provenance: 'parts-first',
    foundBy: 'handed_over',
    because:
      'The counter-example the register needed, and the reason `provenance` is the field that ' +
      'decides rather than `policy`. It converts each receipt at its own recorded rate and ' +
      'adds the results, which is the same shape as the tax defect and is correct here for the ' +
      'opposite reason: `recordPayment` already debited Undeposited Funds each converted figure, ' +
      'so summing them relieves exactly what the receipts put there and converting the total ' +
      'would strand the difference in a clearing account.',
  },
  {
    file: 'src/modules/payroll/provider.ts',
    symbol: 'grossFor',
    policy: 'unplaced',
    provenance: 'whole-first',
    foundBy: 'equal',
    because:
      'An annual salary cut into equal periods with no residue placed, so a year of payslips comes ' +
      'to periods times round(salary / periods) rather than to the salary. It is on the register ' +
      'and is **not** on `PENDING_WIRING`, because it is inside `IllustrativePayrollProvider` — ' +
      'invented rates, every run stamped illustrative, and a refusal in the same file saying it ' +
      'must not be used to pay anybody. A real provider with this shape would be a defect; this ' +
      'one is a demo, and calling it live would be the false sentence ADR 0135 is about.',
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
