import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enclosingSymbol, withoutComments } from '@/modules/source/enclosing'
import { RegistryError } from '@/modules/errors/registry'
import {
  DIVISION_FORMS,
  divisionFormFor,
  perItemRoundingStands,
} from '@/modules/money/division'
import { SPLIT_SITES, splitSiteFor } from '@/modules/money/splitting'

/**
 * The scan ADR 0146 nominated (Phase 147).
 *
 * No database, no clock — it reads the source.
 *
 * `SPLIT_SITES` was five entries chosen by hand, and ADR 0145 argued for
 * declaring rather than scanning. This is the other half: three forms, and the
 * registry held to them in both directions.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/**
 * Comments **and** string literals blanked.
 *
 * Phase 141 established that a posting site is code and a sentence about one is
 * not; Phase 144 found the other half when three registries turned up as
 * comparison sites because they quote real code inside their prose. This file
 * declares patterns *and* is full of sentences about division, so it would
 * otherwise be its own largest finding.
 */
function readable(file: string): string {
  return withoutComments(readFileSync(file, 'utf8'))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
}

type Site = { file: string; symbol: string; form: string; what: string }

/** The body of the top-level function an offset sits in. */
function bodyAt(src: string, index: number): string {
  const before = [...src.slice(0, index).matchAll(/^(?:export )?(?:async )?function \w+\(/gm)]
  const start = before.length > 0 ? before[before.length - 1].index : 0
  const end = src.indexOf('\n}\n', index)
  return src.slice(start, end < 0 ? undefined : end)
}

/** Every site any declared form reaches. */
function divisionSites(): Site[] {
  const sites: Site[] = []

  for (const dir of ['src/modules', 'src/app']) {
    for (const file of sourceFiles(dir)) {
      const src = readable(file)

      for (const form of DIVISION_FORMS) {
        for (const match of src.matchAll(new RegExp(form.pattern, 'g'))) {
          const symbol = enclosingSymbol(src, match.index)

          if (form.key === 'proportional') {
            // A constant divisor converts units; a variable one is a total.
            if (/^\d[\d_]*$/.test(match[3])) continue
            sites.push({ file, symbol, form: form.key, what: `${match[1]} / ${match[3]}` })
          } else if (form.key === 'equal') {
            // Both operands being money makes it a ratio rather than money
            // being divided — a percentage of budget spent, a coverage figure.
            if (/[cC]ents$/.test(match[2])) continue

            // A weighted share is the proportional form's, and its divisor sits
            // after a closing paren rather than after a money operand. Checked
            // at the match rather than across the file: the first version of
            // this skipped any operand multiplied *anywhere* in the same file,
            // and `grossFor` vanished because the hourly branch forty lines up
            // multiplies the same field.
            if (/\*\s*$/.test(src.slice(Math.max(0, match.index - 40), match.index))) continue

            sites.push({ file, symbol, form: form.key, what: `${match[1]} / ${match[2]}` })
          } else {
            // Handed to a helper one item at a time, and the results added up.
            // `Math.min(cashCents, …)` is a comparison, not a division handed
            // over — the capture is the method name and the dot is the tell.
            if (['formatCents', 'expect'].includes(match[1])) continue
            const body = bodyAt(src, match.index)
            const head = body.slice(0, Math.max(0, body.indexOf(match[0])))
            if (!/\.map\(|\bfor\s*\(|\.forEach\(/.test(head)) continue
            if (!/\.reduce\(\s*\([^)]*\)\s*=>\s*\w+\s*\+/.test(body)) continue
            sites.push({ file, symbol, form: form.key, what: `${match[1]}(${match[2]}, …)` })
          }
        }
      }
    }
  }

  return sites
}

const SITES = divisionSites()

describe('the forms money is divided in', () => {
  it('argues each form from what it reaches', () => {
    for (const form of DIVISION_FORMS) {
      expect(form.because.length, form.key).toBeGreaterThan(140)
    }
    expect(DIVISION_FORMS.map((form) => form.key)).toEqual([
      'proportional',
      'equal',
      'handed_over',
    ])
  })

  it('refuses a form nobody declared', () => {
    expect(() => divisionFormFor('modulo')).toThrow(RegistryError)
    try {
      divisionFormFor('modulo')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('DIVISION_FORMS')
    }
  })

  it('reaches an indexed weight, which the Phase 146 scan did not', () => {
    // The bug ADR 0146 recorded against its own scan: `weights[index]` has
    // brackets, an operand pattern built for dotted names does not match them,
    // and the canonical split was invisible to the scan written to check it.
    const narrow = /([A-Za-z_][\w.]*[cC]ents)\s*\*\s*([A-Za-z_][\w.]*)\s*\)?\s*\/\s*(\w+)/
    const line = 'const share = Math.round((amountCents * weights[index]) / total)'

    expect(narrow.test(line)).toBe(false)
    expect(new RegExp(DIVISION_FORMS[0].pattern).test(line)).toBe(true)
  })

  it('finds sites, so a broken scan cannot pass as agreement', () => {
    // Measured, not bounded (Phase 126). An empty scan agrees with every
    // registry ever written.
    expect(SITES.length).toBeGreaterThan(8)
    expect(new Set(SITES.map((site) => site.form)).size).toBe(3)
  })
})

describe('the register held to the source', () => {
  it('declares every site a form reaches', () => {
    // The direction that catches a site nobody classified — Phase 143's
    // finding, and the reason this phase exists at all.
    const undeclared = SITES.filter(
      (site) => !SPLIT_SITES.some((row) => row.file === site.file && row.symbol === site.symbol),
    )
      .filter((site) => !EXCLUDED.some((row) => row.file === site.file && row.symbol === site.symbol))
      .map((site) => `${site.file} :: ${site.symbol}  (${site.form}: ${site.what})`)

    expect(undeclared).toEqual([])
  })

  it('reaches every entry that says a form reaches it', () => {
    // The other direction. An entry claiming to be scanned when nothing scans
    // it is the declaration ADR 0134 called worse than a miss.
    const unreached = SPLIT_SITES.filter((row) => row.foundBy !== null)
      .filter(
        (row) =>
          !SITES.some(
            (site) =>
              site.file === row.file && site.symbol === row.symbol && site.form === row.foundBy,
          ),
      )
      .map((row) => `${row.symbol} claims ${row.foundBy}`)

    expect(unreached).toEqual([])
  })

  it('makes the two sites no form reaches argue for themselves', () => {
    // `null` is allowed and has to be earned. Both of these split by
    // subtracting a rounded part from a whole, which is not a division at all.
    const unscanned = SPLIT_SITES.filter((row) => row.foundBy === null)

    expect(unscanned.map((row) => row.symbol)).toEqual(['splitFor'])
    for (const row of unscanned) {
      expect(row.because, row.symbol).toMatch(/subtraction|what is left/)
    }
  })

  it('counts what it holds', () => {
    // Five at Phase 145, eight since Phase 147 — `recoveryFunctional`, which
    // nothing had declared, `createDeposit`, which is the counter-example, and
    // `grossFor`, which places no residue and is a demo.
    expect(SPLIT_SITES.length).toBe(8)
    expect(SPLIT_SITES.filter((row) => row.foundBy === 'proportional')).toHaveLength(4)
    expect(SPLIT_SITES.filter((row) => row.foundBy === 'handed_over')).toHaveLength(2)
    expect(SPLIT_SITES.filter((row) => row.foundBy === 'equal')).toHaveLength(1)
  })

  it('argues every entry', () => {
    for (const row of SPLIT_SITES) {
      expect(row.because.length, row.symbol).toBeGreaterThan(140)
    }
  })

  it('refuses a site nobody declared', () => {
    expect(() => splitSiteFor('src/modules/properties/rent.ts', 'rentFor')).toThrow(RegistryError)
  })
})

describe('which came first, the whole or the parts', () => {
  it('condemns the tax rounding and clears the deposit, on the same shape', () => {
    // The pair that makes the field worth having. Both round per item and add
    // the results up; only the provenance separates them.
    expect(
      perItemRoundingStands({ provenance: 'whole-first', roundedThenSummed: true }),
    ).toMatchObject({ sound: false })

    expect(
      perItemRoundingStands({ provenance: 'parts-first', roundedThenSummed: true }),
    ).toEqual({ sound: true })
  })

  it('says why, in a sentence somebody can act on', () => {
    const verdict = perItemRoundingStands({ provenance: 'whole-first', roundedThenSummed: true })
    expect(verdict.sound).toBe(false)
    if (!verdict.sound) expect(verdict.why).toMatch(/rounded one at a time and added up/)
  })

  it('has nothing to say about a figure that is not summed', () => {
    expect(
      perItemRoundingStands({ provenance: 'whole-first', roundedThenSummed: false }),
    ).toEqual({ sound: true })
  })

  it('no longer has a live defect to agree with, and says what took its place', () => {
    // This asserted the opposite until Phase 151. `priceDocumentTax` was the
    // one live defect on the register — `whole-first` provenance, parts rounded
    // one at a time and added up — and the validation Phase 144 asked for was
    // that the scan reached it rather than announcing something nobody could
    // check. It did, and the wiring pass repaired it.
    //
    // The register followed the division rather than the caller: the entry is
    // `taxPerCode` now, which is the function that actually splits. It is still
    // `whole-first` — a code's tax is `round(base × rate)`, whatever code does
    // the rounding — and it is sound because it rounds the whole once and
    // splits the figure back, which is the case `roundedThenSummed: false`
    // describes.
    expect(() => splitSiteFor('src/modules/payroll/sales-tax.ts', 'priceDocumentTax')).toThrow(
      RegistryError,
    )

    const tax = splitSiteFor('src/modules/payroll/tax-rounding.ts', 'taxPerCode')
    expect(tax.foundBy).toBe('handed_over')
    expect(tax.provenance).toBe('whole-first')
    expect(tax.policy).toBe('largest-remainder')

    expect(
      perItemRoundingStands({ provenance: tax.provenance, roundedThenSummed: false }).sound,
    ).toBe(true)
  })
})

/**
 * Sites a form reaches that are not splits, each with the reason.
 *
 * Kept beside the scan rather than inside `SPLIT_SITES`, because a register of
 * places money is divided should not fill up with places it is not. Every entry
 * here is a **single** figure — there are no parts, so nothing has to add back.
 */
const EXCLUDED: readonly { file: string; symbol: string; why: string }[] = [
  {
    file: 'src/modules/fx/affordable.ts',
    symbol: 'affords',
    why: 'A conversion, not a share: the divisor is a rate and the answer is one face amount.',
  },
  {
    file: 'src/modules/properties/rent.ts',
    symbol: 'rentFor',
    why: 'A part period of one tenancy. One charge comes out, so there is no set to add back.',
  },
  {
    file: 'src/modules/crm/analytics.ts',
    symbol: 'winLossSummary',
    why: 'An average. Nothing is paid it and nothing is reconciled to it.',
  },
  {
    file: 'src/modules/dimensions/reporting.ts',
    symbol: 'coverageFrom',
    why: 'A ratio reported in basis points. No money comes out of it, so nothing has to add back.',
  },
  {
    file: 'src/modules/funds/releases.ts',
    symbol: 'previewReleases',
    why: 'Each release is decided against one fund’s own available balance, not carved from a total.',
  },
  {
    file: 'src/modules/payments/in-transit.ts',
    symbol: 'payoutSettlement',
    why: 'One settlement converted once. The reduce beside it sums unrelated fees.',
  },
  {
    file: 'src/app/crm/pipeline-board.tsx',
    symbol: 'PipelineBoard',
    why: 'A weighted forecast on a screen. No money is posted from it.',
  },
]

describe('what the scan reaches and is not a split', () => {
  it('gives a reason for each', () => {
    for (const row of EXCLUDED) {
      expect(row.why.length, row.symbol).toBeGreaterThan(40)
    }
  })

  it('excludes nothing the scan does not actually reach', () => {
    // An exclusion for a site that is not found is a rule for a case that does
    // not arise, and it would quietly start excusing a real one if the scan
    // ever widened. Phase 135: a false sentence is exactly as long as a true one.
    const stale = EXCLUDED.filter(
      (row) => !SITES.some((site) => site.file === row.file && site.symbol === row.symbol),
    ).map((row) => `${row.file} :: ${row.symbol}`)

    expect(stale).toEqual([])
  })
})
