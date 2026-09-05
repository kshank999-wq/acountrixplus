import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADDITION_FORMS,
  additionFormFor,
  oneCurrencyOf,
  refuseMixedCurrency,
} from '@/modules/fx/addition'
import { FACE_COLUMNS, SAFE_FACE_SUMS, safeFaceSumFor } from '@/modules/fx/comparable'

/**
 * Money is added two ways, and both get looked at (Phase 123).
 *
 * Phase 122's scanner said "it reads the source" and read one syntactic form.
 * The other form — `reduce()` — was carrying three currency-blind sums at the
 * time, one of them a **write** that posts to the ledger and one of them the
 * right-hand side of an integrity check.
 */

/**
 * The file that declares the forms is not scanned for them.
 *
 * It has to contain an example of each — `looksLike` is what somebody reads
 * instead of the regex — and the first run of this file duly reported
 * `addition.ts:74` as a currency-blind sum over `invoices.balance_cents`. A
 * registry of patterns will always match itself; excluding it by rule is
 * honest, excluding the finding by tightening the regex would not be.
 */
const DECLARES_THE_FORMS = 'src/modules/fx/addition.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (path === DECLARES_THE_FORMS) return []
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/** The enclosing function a character offset sits inside. */
function symbolAt(src: string, index: number): string {
  const matches = [...src.slice(0, index).matchAll(/(?:export )?(?:async )?function (\w+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}

/** camelCase drizzle property back to the snake_case column it names. */
function snake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

type Site = { file: string; line: number; symbol: string; what: string; form: string }

/**
 * Every place money is added, in either form, over a face amount.
 *
 * The `reduce` form names a property rather than a table, so a site counts only
 * when the same file reads that face column out of its own table — the
 * narrowing that takes this from 145 sites, nearly all legitimate, to four that
 * are each a real question. See `addition.ts` for why that trade is the right
 * one.
 */
function faceAdditions(): Site[] {
  const sites: Site[] = []
  for (const dir of ['src/modules', 'src/app']) {
    for (const file of sourceFiles(dir)) {
      const src = readFileSync(file, 'utf8')

      // Which face columns does this file read out of their own table?
      const reads = FACE_COLUMNS.filter((row) => {
        const camel = row.column.replace(/_(\w)/g, (_, c) => c.toUpperCase())
        const table = row.table.replace(/_(\w)/g, (_, c) => c.toUpperCase())
        return src.includes(`${table}.${camel}`)
      })

      for (const form of ADDITION_FORMS) {
        for (const m of src.matchAll(new RegExp(form.pattern, 'g'))) {
          const line = src.slice(0, m.index!).split('\n').length
          const symbol = symbolAt(src, m.index!)

          if (form.key === 'sql_sum') {
            const table = snake(m[1])
            const column = snake(m[2])
            if (!FACE_COLUMNS.some((r) => r.table === table && r.column === column)) continue
            sites.push({ file, line, symbol, what: `${table}.${column}`, form: form.key })
          } else {
            const hit = reads.find((row) => snake(m[2]) === row.column)
            if (!hit) continue
            sites.push({ file, line, symbol, what: `${hit.table}.${hit.column}`, form: form.key })
          }
        }
      }
    }
  }
  return sites
}

/** Does the code around this addition name a currency at all? */
function currencyAware(file: string, line: number): boolean {
  const lines = readFileSync(file, 'utf8').split('\n')
  const window = lines.slice(Math.max(0, line - 20), line + 26).join('\n')
  return /\.currency|currency:|groupBy\([^)]*currency|oneCurrencyOf|functional/i.test(window)
}

describe('the forms money is added in', () => {
  it('matches a sum whatever case it is written in (Phase 125)', () => {
    // The pattern read `sum(` and matched lowercase only. Two live sums over
    // face columns were written `SUM(` inside a raw `sql` template and were
    // invisible to the tripwire from the day it was written.
    const sqlSum = new RegExp(additionFormFor('sql_sum').pattern)
    expect(sqlSum.test('sum(${invoices.balanceCents})')).toBe(true)
    expect(sqlSum.test('COALESCE(SUM(${invoices.balanceCents}), 0)')).toBe(true)
  })

  it('names more than the one Phase 122 looked for', () => {
    expect(ADDITION_FORMS.map((row) => row.key)).toEqual(['sql_sum', 'js_reduce'])
  })

  it('argues for each form rather than just holding a regex', () => {
    for (const form of ADDITION_FORMS) {
      expect(form.because.length, form.key).toBeGreaterThan(120)
      expect(form.looksLike.length, form.key).toBeGreaterThan(10)
    }
  })

  it('compiles every declared pattern', () => {
    for (const form of ADDITION_FORMS) {
      expect(() => new RegExp(form.pattern, 'g'), form.key).not.toThrow()
    }
  })

  it('refuses a form nobody declared', () => {
    expect(() => additionFormFor('spread_operator')).toThrow(/No addition form is declared/)
  })
})

describe('reading the source in both forms', () => {
  const sites = faceAdditions()

  it('finds both forms in the wild, so a broken scan cannot pass silently', () => {
    const found = new Set(sites.map((site) => site.form))
    expect([...found].sort()).toEqual(['js_reduce', 'sql_sum'])
  })

  it('adds no two currencies together, in either form', () => {
    const blind = sites
      .filter((site) => !currencyAware(site.file, site.line))
      .filter((site) => !safeFaceSumFor(site.file, site.symbol))
      .map((site) => `${site.file}:${site.line} ${site.symbol} — ${site.form} over ${site.what}`)

    expect(blind).toEqual([])
  })

  it('keeps every excused sum pointing at one that is still there', () => {
    // Lives here rather than beside the SQL scan (Phase 129). `SAFE_FACE_SUMS`
    // excuses sites in **both** forms, but `comparable-sums` only reads the
    // SQL one — so it called a perfectly live `reduce` excuse stale, and a
    // reduce could never be excused at all. Only the scan that sees both forms
    // can judge whether an entry still points at something.
    const present = new Set(sites.map((site) => `${site.file}:${site.symbol}`))
    const stale = SAFE_FACE_SUMS.filter(
      (row) => !present.has(`${row.file}:${row.symbol}`),
    ).map((row) => `${row.file}:${row.symbol}`)

    expect(stale).toEqual([])
  })
})

describe('whether a set of amounts may be added at all', () => {
  it('agrees when they are all one currency, and says which', () => {
    expect(oneCurrencyOf([{ currency: 'EUR' }, { currency: 'EUR' }], 'USD')).toEqual({
      agreed: true,
      currency: 'EUR',
    })
  })

  it('falls back for an empty set, because no receipts is still a deposit', () => {
    expect(oneCurrencyOf([], 'GBP')).toEqual({ agreed: true, currency: 'GBP' })
  })

  it('refuses when they are not, and names them in a stable order', () => {
    expect(oneCurrencyOf([{ currency: 'USD' }, { currency: 'EUR' }], 'USD')).toEqual({
      agreed: false,
      currencies: ['EUR', 'USD'],
    })
  })

  it('tells the person holding the paying-in slip which currencies, not "mixed"', () => {
    const refusal = refuseMixedCurrency('receipts', ['EUR', 'USD'])
    expect(refusal.message).toMatch(/EUR and USD/)
    expect(refusal.message).not.toMatch(/mixed/i)
    // Phase 119: a refusal that reaches a person is a sentence, not a code.
    expect(refusal.name).toBe('Refusal')
  })
})
