import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { declaresFunction } from '@/modules/source/enclosing'
import { RegistryError } from '@/modules/errors/registry'
import { SPLIT_SITES, splitExactly, splitSiteFor } from '@/modules/money/splitting'
import {
  doesNotFoot,
  taxAtRate,
  taxPerCode,
  taxPerLine,
  type TaxLineInput,
} from '@/modules/payroll/tax-rounding'
import { taxOn } from '@/modules/payroll/sales-tax'

/**
 * Tax rounded once per code (Phase 145).
 *
 * No database, no clock. `taxOn` is imported only so the two statements of the
 * same arithmetic can be held to each other.
 */

/** The rate every fixture uses unless it says otherwise: 8.25%. */
const RATE_BP = 825

const rateOf = (rates: Record<string, number>) => (taxCodeId: string) => {
  const rate = rates[taxCodeId]
  if (rate === undefined) throw new Error(`no rate for ${taxCodeId}`)
  return rate
}

/** The same generator the drift table in `tax-rounding.ts` was measured with. */
function lineSets(lineCount: number, count: number): number[][] {
  let seed = 7
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  return Array.from({ length: count }, () =>
    Array.from({ length: lineCount }, () => 500 + Math.floor(next() * 50_000)),
  )
}

describe('splitting a whole into parts', () => {
  it('always gives back exactly what it was given', () => {
    // Exhaustive over shapes rather than illustrative: every whole from 0 to
    // 200 against nine weight sets, which is 1,809 splits.
    const weightSets = [
      [1],
      [1, 1],
      [1, 1, 1],
      [700, 300],
      [1, 2, 3, 4],
      [9999, 1],
      [33, 33, 34],
      [5, 5, 5, 5, 5, 5, 5],
      [1_000_000, 1, 1],
    ]

    let checked = 0
    for (const weights of weightSets) {
      for (let whole = 0; whole <= 200; whole++) {
        const parts = splitExactly(whole, weights)
        expect(parts.reduce((sum, part) => sum + part, 0), `${whole} over ${weights}`).toBe(whole)
        expect(parts.length).toBe(weights.length)
        checked += 1
      }
    }

    expect(checked).toBe(1_809)
  })

  it('keeps every part within a cent of its exact share', () => {
    // The property `prorate` does not have, and the reason this is a second
    // implementation rather than a call to the first.
    const weights = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const total = weights.reduce((sum, weight) => sum + weight, 0)

    for (let whole = 0; whole <= 500; whole++) {
      const parts = splitExactly(whole, weights)
      for (const [index, part] of parts.entries()) {
        expect(Math.abs(part - (whole * weights[index]) / total)).toBeLessThan(1)
      }
    }
  })

  it('puts the spare cents where the most was dropped', () => {
    // 100 across three equal parts drops a third from each; two parts get a
    // cent back and the tie is broken by position, so the same input always
    // splits the same way.
    expect(splitExactly(100, [1, 1, 1])).toEqual([34, 33, 33])

    // Unequal fractions: 10 over [1,1,1,1,1,1] is 1.66… each, so four of the
    // six take the extra cent.
    expect(splitExactly(10, [1, 1, 1, 1, 1, 1])).toEqual([2, 2, 2, 2, 1, 1])

    // And the exact case moves nothing.
    expect(splitExactly(1000, [700, 300])).toEqual([700, 300])
  })

  it('divides a credit note the way its invoice was divided', () => {
    const weights = [700, 300, 1]
    const positive = splitExactly(1001, weights)
    const negative = splitExactly(-1001, weights)

    expect(negative).toEqual(positive.map((part) => -part))
    expect(negative.reduce((sum, part) => sum + part, 0)).toBe(-1001)
  })

  it('answers the degenerate shapes without inventing money', () => {
    expect(splitExactly(500, [])).toEqual([])
    expect(splitExactly(500, [0, 0])).toEqual([0, 0])
    expect(splitExactly(0, [700, 300])).toEqual([0, 0])
    expect(splitExactly(7, [0, 1, 0])).toEqual([0, 7, 0])
  })

  it('refuses what it cannot divide rather than rounding it quietly', () => {
    expect(() => splitExactly(10.5, [1, 1])).toThrow(RangeError)
    expect(() => splitExactly(10, [1, -1])).toThrow(RangeError)
    expect(() => splitExactly(10, [1, 0.5])).toThrow(RangeError)
  })

  it('is still exact where a double has stopped counting in ones', () => {
    // The argument for BigInt, made as a disagreement rather than a claim.
    // `whole × weight` here is 10^19, well past the 9×10^15 where doubles stop
    // being able to represent consecutive integers.
    const whole = 10_000_000_000
    const weights = [1_000_000_000, 1_000_000_000, 1]

    const naive = weights.map((weight) =>
      Math.floor((whole * weight) / weights.reduce((sum, w) => sum + w, 0)),
    )

    const parts = splitExactly(whole, weights)
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(whole)

    // The floating-point version does not even floor to the same places.
    expect(naive.reduce((sum, part) => sum + part, 0)).not.toBe(whole)
  })
})

describe('the two statements of tax on a base', () => {
  it('agrees with the one in sales-tax.ts across the range', () => {
    // A check that can disagree (Phase 121). `taxAtRate` exists so this core
    // needs no database; that is only defensible while it computes the same
    // number, and this is what says so rather than the comment claiming it.
    let checked = 0
    for (let base = 0; base <= 20_000; base += 7) {
      for (const rateBp of [0, 1, 250, 825, 875, 2_000, 10_000]) {
        expect(taxAtRate(base, rateBp), `${base} @ ${rateBp}`).toBe(taxOn(base, rateBp))
        checked += 1
      }
    }
    expect(checked).toBe(20_006)
  })
})

describe('rounding tax once per code', () => {
  const rates = rateOf({ CA: RATE_BP, NY: 875 })

  it('foots at every level', () => {
    const lines: TaxLineInput[] = [
      { taxCodeId: 'CA', taxableCents: 1_000 },
      { taxCodeId: 'CA', taxableCents: 2_000 },
      { taxCodeId: 'CA', taxableCents: 3_333 },
      { taxCodeId: 'NY', taxableCents: 1_999 },
      { taxCodeId: 'NY', taxableCents: 1_999 },
    ]

    const priced = taxPerCode(lines, rates)

    // Lines sum to their code.
    for (const code of priced.byCode) {
      const fromLines = priced.lines
        .filter((line) => line.taxCodeId === code.taxCodeId)
        .reduce((sum, line) => sum + line.taxCents, 0)
      expect(fromLines, code.taxCodeId).toBe(code.taxCents)
    }

    // Codes sum to the document.
    expect(priced.byCode.reduce((sum, code) => sum + code.taxCents, 0)).toBe(priced.totalCents)

    // And each code is what the authority will recompute.
    expect(doesNotFoot(priced.byCode, rates)).toEqual([])
  })

  it('differs from the per-line rounding on the case that motivated it', () => {
    // The worked example from ADR 0145: three Californian lines.
    const lines: TaxLineInput[] = [
      { taxCodeId: 'CA', taxableCents: 1_000 },
      { taxCodeId: 'CA', taxableCents: 2_000 },
      { taxCodeId: 'CA', taxableCents: 3_333 },
    ]

    expect(taxPerLine(lines, rates)).toBe(523)
    expect(taxPerCode(lines, rates).totalCents).toBe(522)
    expect(taxAtRate(6_333, RATE_BP)).toBe(522)
  })

  it('keeps a typed figure and does not pretend it follows the rate', () => {
    const lines: TaxLineInput[] = [
      { taxCodeId: 'CA', taxableCents: 1_000 },
      { taxCodeId: 'CA', taxableCents: 2_000, taxCents: 999 },
    ]

    const priced = taxPerCode(lines, rates)

    expect(priced.lines[1].taxCents).toBe(999)
    expect(priced.lines[1].derived).toBe(false)
    expect(priced.lines[0].derived).toBe(true)

    // The code reports everything charged, and the derived half on its own.
    const [code] = priced.byCode
    expect(code.taxableCents).toBe(3_000)
    expect(code.derivedTaxableCents).toBe(1_000)
    expect(code.derivedTaxCents).toBe(taxAtRate(1_000, RATE_BP))
    expect(code.taxCents).toBe(code.derivedTaxCents + 999)

    // And the override is not held to an identity it never claimed.
    expect(doesNotFoot(priced.byCode, rates)).toEqual([])
  })

  it('reports the lines in the order they were given', () => {
    const lines: TaxLineInput[] = [
      { taxCodeId: 'NY', taxableCents: 100 },
      { taxCodeId: 'CA', taxableCents: 200 },
      { taxCodeId: 'NY', taxableCents: 300 },
    ]

    expect(taxPerCode(lines, rates).lines.map((line) => line.taxCodeId)).toEqual([
      'NY',
      'CA',
      'NY',
    ])
    expect(taxPerCode(lines, rates).byCode.map((code) => code.taxCodeId)).toEqual(['NY', 'CA'])
  })

  it('says nothing about an empty document', () => {
    expect(taxPerCode([], rates)).toEqual({ lines: [], byCode: [], totalCents: 0 })
  })
})

describe('what the per-line rounding does today', () => {
  const rates = rateOf({ CA: RATE_BP })

  it('does not foot, and the drift table says how often', () => {
    // The measurement in `tax-rounding.ts`, reproduced rather than quoted.
    // Phase 135's rule: a false sentence is exactly as long as a true one, and
    // the only thing that keeps that table true is running it.
    const measured = [50, 400, 2_000, 10_000].map((lineCount) => {
      let worst = 0
      let notFooting = 0

      for (const lines of lineSets(lineCount, 300)) {
        const inputs = lines.map((taxableCents) => ({ taxCodeId: 'CA', taxableCents }))
        const drift = taxPerLine(inputs, rates) - taxAtRate(
          lines.reduce((sum, value) => sum + value, 0),
          RATE_BP,
        )
        if (drift !== 0) notFooting += 1
        if (Math.abs(drift) > Math.abs(worst)) worst = drift
      }

      return { lineCount, worst, notFooting }
    })

    expect(measured).toEqual([
      { lineCount: 50, worst: 7, notFooting: 249 },
      { lineCount: 400, worst: 19, notFooting: 279 },
      { lineCount: 2_000, worst: 50, notFooting: 292 },
      { lineCount: 10_000, worst: 75, notFooting: 300 },
    ])
  })

  it('foots in every one of those sets once it rounds per code', () => {
    // The same sets, the same rate, the other rule. Nothing in the table above
    // is an argument unless this is empty.
    const failures = lineSets(400, 300).flatMap((lines) => {
      const priced = taxPerCode(
        lines.map((taxableCents) => ({ taxCodeId: 'CA', taxableCents })),
        rates,
      )
      return doesNotFoot(priced.byCode, rates)
    })

    expect(failures).toEqual([])
  })

  it('names the code and both figures when something does not foot', () => {
    // A refusal a person can act on (Phase 119): the code, the base, the rate,
    // what was reported and what it should have been.
    const lines = [1_000, 2_000, 3_333].map((taxableCents) => ({ taxCodeId: 'CA', taxableCents }))
    const perLineTotal = taxPerLine(lines, rates)

    const failures = doesNotFoot(
      [
        {
          taxCodeId: 'CA',
          taxableCents: 6_333,
          taxCents: perLineTotal,
          derivedTaxableCents: 6_333,
          derivedTaxCents: perLineTotal,
        },
      ],
      rates,
    )

    expect(failures).toEqual([
      {
        taxCodeId: 'CA',
        taxableCents: 6_333,
        rateBp: RATE_BP,
        reportedCents: 523,
        recomputedCents: 522,
        differenceCents: 1,
      },
    ])
  })
})

describe('the register of places a whole is split', () => {
  it('names only functions that exist', () => {
    const fictional = SPLIT_SITES.filter(
      (site) => !declaresFunction(readFileSync(site.file, 'utf8'), site.symbol),
    ).map((site) => `${site.file} :: ${site.symbol}`)

    expect(fictional).toEqual([])
  })

  it('argues every entry rather than labelling it', () => {
    for (const site of SPLIT_SITES) {
      expect(site.because.length, site.symbol).toBeGreaterThan(140)
    }
  })

  it('holds the sites that place no residue at all', () => {
    // One at Phase 145 and two since Phase 147, which is the distinction the
    // register turned out to need: both leave the cents where they fall, and
    // only one of them is a defect. `grossFor` is inside
    // `IllustrativePayrollProvider` — invented rates, every run stamped
    // illustrative, a refusal in the same file saying it must not be used to
    // pay anybody — so it is on this register and deliberately not on
    // `PENDING_WIRING`. If a real calculating provider is ever written with
    // this shape, this is the line that should stop being comfortable.
    const unplaced = SPLIT_SITES.filter((site) => site.policy === 'unplaced')

    // One since Phase 151 wired the repair. `priceDocumentTax` no longer
    // divides anything — it hands its lines to `taxPerCode`, which places its
    // residue — so the register moved the entry to the function that does the
    // dividing, and what is left unplaced is `grossFor`: the illustrative
    // payroll provider that must not be used to pay anybody.
    expect(unplaced.map((site) => site.symbol)).toEqual(['grossFor'])
    // Phase 147 replaced `wholeIsIndependent` with `provenance`, because the
    // old field carried two answers for this very site: the whole does not
    // exist first as the code stands, and it is supposed to. `whole-first` is
    // a statement about the money, so it can be true while the site is wrong —
    // which is what makes the site a defect rather than a design.
    expect(unplaced[0].provenance).toBe('whole-first')
    expect(SPLIT_SITES.filter((site) => site.provenance === 'whole-first')).toHaveLength(7)
    expect(SPLIT_SITES.filter((site) => site.provenance === 'parts-first')).toHaveLength(1)
  })

  it('refuses a site nobody declared', () => {
    expect(() => splitSiteFor('src/modules/jobs/billing.ts', 'priceApplication')).toThrow(
      RegistryError,
    )

    try {
      splitSiteFor('src/modules/jobs/billing.ts', 'priceApplication')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('SPLIT_SITES')
      expect((error as RegistryError).key).toBe(
        'src/modules/jobs/billing.ts:priceApplication',
      )
    }
  })

  it('finds the ones that are declared', () => {
    expect(splitSiteFor('src/modules/ledger/cash-basis.ts', 'prorate').policy).toBe('last-takes-it')
    // `reported` until Phase 147, and wrong: `businessCents` is
    // `totalCents - practitionerCents`, so the business takes the residue like
    // any other last part and `roundingCents` says how much rather than asking.
    expect(splitSiteFor('src/modules/appointments/split.ts', 'splitFor').policy).toBe(
      'last-takes-it',
    )
  })
})
