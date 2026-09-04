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

/** The exported function a character offset sits inside. */
function symbolAt(src: string, index: number): string {
  const before = src.slice(0, index)
  const matches = [...before.matchAll(/(?:export )?(?:async )?function (\w+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}

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

/** Does the query around this sum name a currency at all? */
function currencyAware(file: string, line: number): boolean {
  const lines = readFileSync(file, 'utf8').split('\n')
  const window = lines.slice(Math.max(0, line - 15), line + 26).join('\n')
  return /\.currency|currency:|groupBy\([^)]*currency|eq\(\w+\.currency/.test(window)
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

  it('keeps every excused sum pointing at one that is still there', () => {
    const present = new Set(sites.map((site) => `${site.file}:${site.symbol}`))
    const stale = SAFE_FACE_SUMS.filter(
      (row) => !present.has(`${row.file}:${row.symbol}`),
    ).map((row) => `${row.file}:${row.symbol}`)

    expect(stale).toEqual([])
  })

  it('argues each excuse from the code, not from what the thing is like', () => {
    for (const row of SAFE_FACE_SUMS) {
      expect(row.because.length, row.symbol).toBeGreaterThan(120)
    }
  })
})
