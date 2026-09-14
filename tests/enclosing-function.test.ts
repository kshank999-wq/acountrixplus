import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaresFunction, enclosingSymbol, withoutComments } from '@/modules/source/enclosing'
import { LEDGER_POSTINGS } from '@/modules/fx/ledger'
import { BANK_POSTINGS } from '@/modules/fx/bank-side'
import { SAFE_FACE_SUMS } from '@/modules/fx/comparable'

/**
 * The enclosing function that was not one (Phase 140).
 *
 * No database, no clock. Four scanners each held their own copy of a function
 * that reads which function a posting site sits in, all four copies matched the
 * word `function` in prose, and the registries they drive were written from
 * their output — so `LEDGER_POSTINGS` has declarations for two functions that do
 * not exist, and the test meant to catch that compares the declaration against
 * the same broken scan.
 */

/** The scanner as it stood in all four test files, kept to prove the difference. */
function brokenSymbolAt(src: string, index: number): string {
  const matches = [...src.slice(0, index).matchAll(/(?:export )?(?:async )?function (\w+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/** Every registry keyed by `file:symbol`, which is every registry that can be wrong this way. */
const SITE_REGISTRIES: readonly { name: string; rows: readonly { file: string; symbol: string }[] }[] =
  [
    { name: 'LEDGER_POSTINGS', rows: LEDGER_POSTINGS },
    { name: 'BANK_POSTINGS', rows: BANK_POSTINGS },
    { name: 'SAFE_FACE_SUMS', rows: SAFE_FACE_SUMS },
  ]

describe('which function a line of source is inside', () => {
  it('does not mistake the word in a sentence for a declaration', () => {
    // The two comments that actually caused this, quoted from the files they
    // are in. `src/modules` holds 85 mid-line occurrences of the keyword and
    // every one is prose; these two are the ones that sit between the top of a
    // function and a place money is posted.
    const src = [
      'export async function createInvoice(ctx) {',
      '  // A function that accepts an executor has to use it for its *reads* as well',
      '  const line = { debitCents: functionalTotalCents }',
      '}',
    ].join('\n')

    expect(brokenSymbolAt(src, src.indexOf('debitCents'))).toBe('that')
    expect(enclosingSymbol(src, src.indexOf('debitCents'))).toBe('createInvoice')
  })

  it('is not fooled by a block comment either', () => {
    const src = [
      'export async function applyCredit(ctx) {',
      '  /**',
      '   * since — while this function converted both sides at the invoice’s rate',
      '   */',
      '  const line = { creditCents: settlement.relievedCents }',
      '}',
    ].join('\n')

    expect(brokenSymbolAt(src, src.indexOf('creditCents'))).toBe('converted')
    expect(enclosingSymbol(src, src.indexOf('creditCents'))).toBe('applyCredit')
  })

  it('attributes a nested declaration’s body to the function it is written in', () => {
    // Indented, therefore not anchored, therefore not a boundary. A registry
    // keyed by top-level symbol wants exactly this: the site belongs to the
    // function somebody can look up.
    const src = [
      'export async function closeShift(ctx) {',
      '  function tally(rows) {',
      '    return { debitCents: rows.totalCents }',
      '  }',
      '}',
    ].join('\n')

    expect(enclosingSymbol(src, src.indexOf('debitCents'))).toBe('closeShift')
  })

  it('says so plainly when the offset is above every declaration', () => {
    const src = 'const RATE_ONE = 1_000_000\nexport function convert(cents) {}\n'
    expect(enclosingSymbol(src, 5)).toBe('(top level)')
  })

  it('keeps every byte offset where it was', () => {
    // A scanner reports line numbers by slicing at the same index. Removing a
    // comment instead of blanking it would renumber the file it is describing,
    // which is a worse failure than the one being fixed.
    const src = readFileSync('src/modules/fx/ledger.ts', 'utf8')
    const blanked = withoutComments(src)

    expect(blanked.length).toBe(src.length)
    expect(blanked.split('\n').length).toBe(src.split('\n').length)
  })
})

describe('what the broken scanner did to the registries', () => {
  it('names a function that does not exist, twice', () => {
    // **The assertion the phase exists for.** `ledgerPostingFor` throws today
    // for `createInvoice` — the function that raises every invoice in the
    // system — because the registry knows it as `that`.
    //
    // Measured across all three registries keyed by `file:symbol`, so this is a
    // statement about the class rather than about two names.
    const fictional = SITE_REGISTRIES.flatMap(({ name, rows }) =>
      rows
        .filter((row) => !declaresFunction(readFileSync(row.file, 'utf8'), row.symbol))
        .map((row) => `${name}: ${row.file} :: ${row.symbol}`),
    )

    expect(fictional).toEqual([])
  })

  it('checks enough registries for that to mean something', () => {
    // Measured, not bounded (Phase 126). Fifty-nine declarations across three
    // registries; two of them were fiction before Phase 140.
    //
    // Sixty-one since Phase 143, which argued two more sums into
    // `SAFE_FACE_SUMS` — `openCreditsAsAt`, grouped by credit note, and
    // `previewBilling`, which the scan mistook for a retainer sum. Both are
    // real functions, which is what this assertion is here to keep true.
    expect(SITE_REGISTRIES.length).toBe(3)
    expect(SITE_REGISTRIES.reduce((sum, entry) => sum + entry.rows.length, 0)).toBe(61)
  })

  it('disagrees with the old scanner, on sites the registries do not yet reach', () => {
    // A check seen to disagree rather than only to agree (Phase 121), and the
    // measurement that says the two names in the registry were luck rather than
    // the extent of the fault.
    //
    // Every `…Cents:` assignment in `src/modules` is a much wider net than any
    // of the four scanners casts. On it the old reader invents names out of
    // prose — `has`, `exists`, `the`, `as`, `to`, `holds`, `whose`, `never`,
    // `nobody`, `rather` — and each one is a posting site that would land in a
    // registry under a word if a narrowing were widened by a line.
    const invented = new Set<string>()
    let sites = 0

    for (const file of sourceFiles('src/modules')) {
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(/[A-Za-z]Cents:\s*[A-Za-z_][\w.]*/g)) {
        sites += 1
        const was = brokenSymbolAt(src, match.index)
        if (was !== enclosingSymbol(src, match.index)) invented.add(was)
      }
    }

    expect(sites).toBeGreaterThan(2_000)
    expect(invented.size).toBeGreaterThanOrEqual(15)

    // Not one of them is a function anywhere in the codebase.
    for (const name of invented) {
      expect(
        sourceFiles('src/modules').some((file) =>
          declaresFunction(readFileSync(file, 'utf8'), name),
        ),
        name,
      ).toBe(false)
    }
  })

  it('leaves no copy of the old reader behind', () => {
    // A constraint beats a check (Phase 116). Four copies of a fixed function is
    // four things that can drift apart again, and the next scanner makes five —
    // so the repair is one module and this is what keeps it one.
    const copies = readdirSync('tests')
      .filter((entry) => entry.endsWith('.test.ts') && entry !== 'enclosing-function.test.ts')
      .filter((entry) =>
        /matchAll\(\/\(\?:export \)\?\(\?:async \)\?function/.test(
          readFileSync(join('tests', entry), 'utf8'),
        ),
      )

    expect(copies).toEqual([])
  })
})
