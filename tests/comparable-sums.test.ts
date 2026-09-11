import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FACE_COLUMNS,
  SAFE_FACE_SUMS,
  faceColumnFor,
  safeFaceSumFor,
} from '@/modules/fx/comparable'
import { PAIRED_COLUMNS } from '@/modules/fx/paired'
import { enclosingSpan, enclosingSymbol } from '@/modules/source/enclosing'

/**
 * No sum adds two currencies together (Phase 122). It reads the source.
 *
 * Phase 65 closed three of these, Phase 115 closed one in the integrity
 * register, and Phase 116 gave every face amount a functional twin. None of it
 * stopped the next one, because nothing looked. Eight were live when this file
 * was written, two of them deciding money rather than describing it.
 */

/**
 * The file declaring the addition forms is not scanned (Phase 125).
 *
 * `addition.ts` holds a `looksLike` example of each pattern, so it matches
 * itself — which is exactly what Phase 123's test already excludes for the same
 * reason. Phase 125 made the SQL pattern case-insensitive, the example grew a
 * `SUM(...)`, and this scanner started reporting the documentation. One rule,
 * applied in both places.
 */
const DECLARES_THE_FORMS = 'src/modules/fx/addition.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (path === DECLARES_THE_FORMS) return []
    return path.endsWith('.ts') ? [path] : []
  })
}

/** camelCase drizzle property back to the snake_case column it names. */
function snake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/**
 * The exported function a character offset sits inside.
 *
 * Shared since Phase 140. This is the copy that stings: ADR 0134 replaced a
 * fixed-line window with an enclosing-function boundary *because* the window
 * leaked and excused a real defect — and the boundary it replaced it with read
 * the word `function` out of a sentence.
 */
const symbolAt = enclosingSymbol

type Site = { file: string; line: number; symbol: string; table: string; column: string }

/** Every `sum(${table.column})` in the module layer over a face-amount column. */
function faceSums(): Site[] {
  const sites: Site[] = []
  for (const file of sourceFiles('src/modules')) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/sum\(\s*\$\{(\w+)\.(\w+)\}/g)) {
      const table = snake(m[1])
      const column = snake(m[2])
      if (!faceColumnFor(table, column)) continue
      sites.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        symbol: symbolAt(src, m.index!),
        table,
        column,
      })
    }
  }
  return sites
}

/**
 * Does the query around this sum name a currency at all?
 *
 * Bounded by the enclosing function rather than by a count of lines (Phase
 * 134). The window used to be `line - 15` to `line + 26`, and it leaked:
 * `heldByProcessor` sums `checkouts.gross_cents - fee_cents` with no currency
 * anywhere in it, and was excused because `recentCheckouts` — a different
 * function, two boundaries below — selects `currency: checkouts.currency` on
 * line 790, twenty-four lines past the sum.
 *
 * That is the failure Phase 128 found in the posting scan, Phase 131 in the
 * screen scan and Phase 133 in the bank-posting scan, in its fourth form: a
 * scan whose reach is wrong. The first three *missed* sites; this one
 * **excused** one, which is worse, because a miss leaves a site undeclared and
 * an excuse makes the scan report all clear.
 */
function currencyAware(file: string, line: number): boolean {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')

  // The offset the sum sits at, then the span of the function containing it.
  // Shared since Phase 140: this had its own copy of the boundary reader, and
  // a boundary is only as good as what it counts as one.
  const offset = lines.slice(0, line).join('\n').length
  const { from, to } = enclosingSpan(src, offset)

  const body = src.slice(from, to)
  return /\.currency|currency:|groupBy\([^)]*currency|eq\(\w+\.currency/.test(body)
}

describe('what counts as a face amount', () => {
  it('covers every paired column, and the one with no pair', () => {
    // PAIRED_COLUMNS is the Phase 116 list of face/functional twins. Every one
    // of them is a face column here, plus `payments.amount_cents`, which has
    // no twin at all and is therefore the easiest to add up by mistake.
    for (const pair of PAIRED_COLUMNS) {
      expect(faceColumnFor(pair.table, pair.faceColumn), `${pair.table}.${pair.faceColumn}`)
        .not.toBeNull()
    }
    const unpaired = FACE_COLUMNS.filter((row) => row.functionalColumn === null)
    expect(unpaired.map((row) => `${row.table}.${row.column}`)).toEqual(['payments.amount_cents'])
  })

  it('says what each one is, in the terms of the books', () => {
    for (const row of FACE_COLUMNS) {
      expect(row.because.length, `${row.table}.${row.column}`).toBeGreaterThan(40)
    }
  })

  it('is not a face column just because it is money', () => {
    expect(faceColumnFor('journal_lines', 'debit_cents')).toBeNull()
    expect(faceColumnFor('invoices', 'functional_total_cents')).toBeNull()
  })
})

describe('the module layer, read as source', () => {
  const sites = faceSums()

  it('finds sums to look at, so a broken scan cannot pass silently', () => {
    expect(sites.length).toBeGreaterThan(5)
  })

  it('adds no two currencies together', () => {
    const blind = sites
      .filter((site) => !currencyAware(site.file, site.line))
      .filter((site) => !safeFaceSumFor(site.file, site.symbol))
      .map((site) => `${site.file}:${site.line} ${site.symbol} — sum(${site.table}.${site.column})`)

    // Group by currency, sum the functional twin, or argue in SAFE_FACE_SUMS
    // that the rows are provably one currency. A €500 and a $500 do not make
    // 1000 of anything.
    expect(blind).toEqual([])
  })

  /**
   * Staleness moved to `money-addition.test.ts` in Phase 129.
   *
   * `SAFE_FACE_SUMS` excuses sites in both forms, and this scan reads only the
   * SQL one — so it reported a live `reduce` excuse as stale, which meant a
   * reduce could not be excused here at all. The scan that sees both forms is
   * the only one that can tell whether an entry still points at something.
   */

  it('argues each excuse from the code, not from what the thing is like', () => {
    for (const row of SAFE_FACE_SUMS) {
      expect(row.because.length, row.symbol).toBeGreaterThan(120)
    }
  })
})
