/**
 * The ways this codebase divides money, and which came first (Phase 147).
 *
 * ## Why this exists
 *
 * ADR 0145 built `SPLIT_SITES` as five entries chosen by hand and argued for
 * declaring rather than scanning. ADR 0134's rule is that a declaration which
 * *excuses* a site is worse than one that misses it, so ADR 0146 nominated the
 * scan — and the scan written for that phase was itself reach-limited: it missed
 * `prorate`, the canonical split the registry was built around, because its
 * weight is `weights[index]` and brackets do not match an operand pattern built
 * for dotted names.
 *
 * This is that scan, written properly. Three forms, because one is not enough
 * and the third is the one that matters — the lesson ADR 0123 learned about
 * addition and ADR 0144 learned again about comparison, arriving here for the
 * third time.
 *
 * ## Which came first, the whole or the parts
 *
 * The question that decides whether a division is a defect is **not** whether it
 * rounds. It is whether the whole existed before the parts did.
 *
 * ```
 * priceDocumentTax   a code's tax should be round(base × rate) — the whole comes
 *                    first, so rounding each line and adding them up is wrong
 * createDeposit      each receipt was already posted at its own recorded rate —
 *                    the parts came first, so summing them relieves exactly what
 *                    they put there, and converting the total would be wrong
 * ```
 *
 * The two look identical in the source: a helper handed one item's money amount,
 * inside a `.map`, results summed. Only the provenance separates them, which is
 * why `SPLIT_SITES` declares it per site and this file declares only the forms.
 */

import { RegistryError } from '@/modules/errors/registry'

/** An operand: a dotted name, optionally indexed — `weights[index]` is one. */
export const OPERAND = String.raw`[A-Za-z_][\w.]*(?:\[[\w.]+\])?`

/** A syntactic form in which this codebase divides a money amount. */
export type DivisionForm = {
  key: string
  /** A JavaScript regular expression source, compiled by the test that scans. */
  pattern: string
  looksLike: string
  because: string
}

export const DIVISION_FORMS: readonly DivisionForm[] = [
  {
    key: 'proportional',
    pattern: String.raw`(${OPERAND}[cC]ents)\s*\*\s*(${OPERAND})\s*\)?\s*\/\s*(${OPERAND}|\d[\d_]*)`,
    looksLike: 'Math.round((amountCents * weights[index]) / total)',
    because:
      'A share of a whole, scaled by a weight. The divisor is what separates a split from a rate: ' +
      'a constant divides into units — basis points, cents to dollars — while a variable divisor ' +
      'is a total that something is a share *of*. Measured across src: twenty sites, thirteen of ' +
      'them constant and therefore rates, seven variable.',
  },
  {
    key: 'equal',
    pattern: String.raw`(${OPERAND}[cC]ents)\s*\/\s*(${OPERAND})`,
    looksLike: 'Math.round(baseRateCents / periodsPerYear(request))',
    because:
      'A whole cut into equal parts, with no weight at all. Invisible to the proportional form ' +
      'because there is nothing to multiply by, and it is how an annual salary becomes a payslip ' +
      'and a bill is split between people. The form that found `grossFor`, which places no residue ' +
      'and is only not a defect because of which provider it is in.',
  },
  {
    key: 'handed_over',
    pattern: String.raw`(?<![.\w])(\w+)\(\s*(${OPERAND}[cC]ents)\s*,`,
    looksLike: 'lines.map((line) => taxOn(line.taxableCents, rate))  …then summed',
    because:
      'The division done inside a helper, one item at a time, with the results added up. No ' +
      'arithmetic is visible at the site at all, so the first two forms cannot see it — and this ' +
      'is the form that reaches `priceDocumentTax`, the one live defect on the register. ADR 0144 ' +
      'found the same thing about comparison: the fourth form was the one that mattered, and ' +
      'writing the obvious ones and stopping would have produced a scan that missed its own reason ' +
      'for existing.',
  },
]

/** The form a key names. Throws on a form nobody declared. */
export function divisionFormFor(key: string): DivisionForm {
  const form = DIVISION_FORMS.find((row) => row.key === key)
  if (!form) {
    throw new RegistryError({
      registry: 'DIVISION_FORMS',
      key,
      message:
        `No division form is declared for "${key}". A tripwire that scans for money being split ` +
        'has to say which forms of split it scans for, or its guarantee is narrower than it reads.',
    })
  }
  return form
}

/**
 * Whether a per-item rounding is sound, given which came first.
 *
 * Pure, and the whole decision: there is no third answer where summing rounded
 * parts is "close enough". Either the parts are the record — each already
 * posted, each already money that moved — or the whole is, and then the parts
 * have to be split back out of it.
 */
export type Provenance = 'whole-first' | 'parts-first'

export type PerItemVerdict = { sound: true } | { sound: false; why: string }

export function perItemRoundingStands(input: {
  provenance: Provenance
  /** Measured: are the item figures rounded independently and then added? */
  roundedThenSummed: boolean
}): PerItemVerdict {
  if (!input.roundedThenSummed) return { sound: true }

  if (input.provenance === 'parts-first') return { sound: true }

  return {
    sound: false,
    why:
      'The whole exists before the parts do, so it is the figure that has to be rounded — and ' +
      'these parts are rounded one at a time and added up, which produces whatever their ' +
      'roundings happen to come to rather than the figure anybody can recompute.',
  }
}
