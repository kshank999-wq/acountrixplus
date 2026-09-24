import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADDITION_FORMS,
  additionFormFor,
  oneCurrencyOf,
  refuseMixedCurrency,
} from '@/modules/fx/addition'
import {
  FACE_COLUMNS,
  SAFE_FACE_SUMS,
  blindFaceSumFor,
  safeFaceSumFor,
} from '@/modules/fx/comparable'
import { convertedSumStands } from '@/modules/fx/summing'
import {
  enclosingQuery,
  enclosingSpan,
  enclosingSymbol,
  withoutComments,
} from '@/modules/source/enclosing'

/**
 * Money is added three ways, and all three get looked at (Phase 123, 152).
 *
 * Phase 122's scanner said "it reads the source" and read one syntactic form.
 * The other form — `reduce()` — was carrying three currency-blind sums at the
 * time, one of them a **write** that posts to the ledger and one of them the
 * right-hand side of an integrity check.
 *
 * The third form arrived with the repair. Phase 152 moved the conversion behind
 * `functionalSumSql`, and ``sum(${table.column})`` stopped matching the sites
 * the register had been built to watch — a scan blinded by its own fix. It is
 * declared like the other two and, unlike them, judged by whether the rate it
 * names is a rate that is actually reachable from the query.
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

/**
 * The enclosing function a character offset sits inside.
 *
 * Shared since Phase 140, where the copy that lived here — one of four
 * identical ones — was found matching the word `function` in prose.
 */
const symbolAt = enclosingSymbol

/** camelCase drizzle property back to the snake_case column it names. */
function snake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

type Site = {
  file: string
  line: number
  symbol: string
  what: string
  form: string
  /** `converted_sum` only: the rate argument, as the source writes it. */
  rate?: string
}

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
      // Comments blanked, offsets preserved (Phase 141). Measured: the site
      // count is unchanged, which is the point — the guard costs nothing here
      // and is what stops the next scanner reading its own documentation.
      const src = withoutComments(readFileSync(file, 'utf8'))

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
          } else if (form.key === 'converted_sum') {
            // **Not filtered by `FACE_COLUMNS`**, and that is the finding
            // rather than a shortcut. The other two forms need the filter
            // because `sum(x)` over an arbitrary column is usually not money;
            // a `functionalSumSql` call is money being converted by
            // construction, so every one is a site.
            //
            // Filtering it would have dropped the three that matter most.
            // `document_tax_lines` has no currency column, so it is on no face
            // list at all — which is precisely why its rate has to come from a
            // join, and precisely why a scan keyed to currency-bearing tables
            // could never see it. `BLIND_FACE_SUMS` registered `salesTaxReturn`
            // by hand and named `invoices.subtotal_cents`, a different query in
            // the same function, because that was the only part of it the
            // scanner could reach.
            //
            // The rate travels with the site: judging this form needs both
            // arguments, not just the one being added up.
            sites.push({
              file,
              line,
              symbol,
              what: `${snake(m[1])}.${snake(m[2])}`,
              form: form.key,
              rate: `${m[3]}.${m[4]}`,
            })
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

/**
 * The tables a query names in its `from` or its joins.
 *
 * Bounded by the **query**, not by the enclosing function (Phase 152). Both
 * were tried. `salesTaxReturn` holds two queries, the second of which reads
 * `.from(invoices)` — so with the function as the boundary, deleting the
 * `leftJoin(invoices, …)` the first one's rate depends on changed nothing and
 * the check passed. That is ADR 0134's leak again, one level in.
 */
function tablesInScope(file: string, line: number): Set<string> {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const { from, to } = enclosingQuery(src, lines.slice(0, line).join('\n').length)
  const body = src.slice(from, to)

  const tables = new Set<string>()
  for (const m of body.matchAll(/\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*(\w+)/g)) {
    tables.add(m[1])
  }
  return tables
}

/**
 * Whether a `functionalSumSql` call is converting anything (Phase 152).
 *
 * This form is judged here rather than by `currencyAware`, which would pass it
 * for free: the call is literally spelled `functionalSumSql`, and the window
 * matches `/functional/i`. A check only ever seen to agree is not a check
 * (Phase 121), so the decision is `convertedSumStands` and it can say no.
 */
function convertedSumIsSound(site: Site): boolean {
  return convertedSumStands(
    { amount: site.what, rate: site.rate! },
    tablesInScope(site.file, site.line),
  ).sound
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
    expect(ADDITION_FORMS.map((row) => row.key)).toEqual(['sql_sum', 'js_reduce', 'converted_sum'])
  })

  it('matches the converted form on both of its arguments', () => {
    const converted = new RegExp(additionFormFor('converted_sum').pattern)
    expect(
      converted.test('functionalSumSql(payments.amountCents, payments.exchangeRateMillionths)'),
    ).toBe(true)
    // Not the declaration of the helper itself, which has no table.property in
    // either position. The scan would otherwise report `summing.ts` forever.
    expect(
      converted.test('functionalSumSql(amountColumn: AnyColumn, rateColumn: AnyColumn)'),
    ).toBe(false)
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

  it('finds all three forms in the wild, so a broken scan cannot pass silently', () => {
    const found = new Set(sites.map((site) => site.form))
    expect([...found].sort()).toEqual(['converted_sum', 'js_reduce', 'sql_sum'])
  })

  it('adds no two currencies together, in any of the three forms', () => {
    const blind = sites
      .filter((site) =>
        // The converted form is judged on its arguments rather than on whether
        // a currency is mentioned nearby, because its own name mentions one.
        site.form === 'converted_sum'
          ? !convertedSumIsSound(site)
          : !currencyAware(site.file, site.line),
      )
      .filter((site) => !safeFaceSumFor(site.file, site.symbol))
      .filter((site) => !blindFaceSumFor(site.file, site.symbol))
      .map((site) => `${site.file}:${site.line} ${site.symbol} — ${site.form} over ${site.what}`)

    expect(blind).toEqual([])
  })

  it('says no to a converted sum whose rate is not a rate', () => {
    // A check only ever seen to agree is not a check (Phase 121). Both
    // refusals, against the two ways this form goes wrong while reading right.
    const scope = new Set(['invoices', 'documentTaxLines'])

    const notARate = convertedSumStands(
      { amount: 'invoices.subtotal_cents', rate: 'invoices.subtotalCents' },
      scope,
    )
    expect(notARate.sound).toBe(false)
    expect(notARate.sound === false && notARate.why).toMatch(/not a rate/)
  })

  it('says no to a rate from a table the query never joined', () => {
    // The expensive one. `functionalSumSql` coalesces a null rate to RATE_ONE
    // so a left-joined row with no payment adds zero instead of vanishing —
    // and an unjoined rate column is null on *every* row, so the sum is face
    // amounts with a helper's name on it. `salesTaxReturn` needed a leftJoin
    // added for exactly this, and nothing would have said so.
    const verdict = convertedSumStands(
      { amount: 'document_tax_lines.taxable_cents', rate: 'invoices.exchangeRateMillionths' },
      new Set(['documentTaxLines']),
    )
    expect(verdict.sound).toBe(false)
    expect(verdict.sound === false && verdict.why).toMatch(/never joined|not in this query/)
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
