import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_TABLES,
  NAME_COLLISIONS,
  SCREEN_MONEY,
  UNCLASSIFIED_CARRIERS,
  nameCollisionFor,
  screenMoneyFor,
} from '@/modules/fx/on-screen'

/**
 * Money reaching a screen says what it is denominated in (Phase 124).
 *
 * ADR 0123 could not reach this: a client component receives a plain type
 * rather than reading a drizzle table, so nothing followed the prop across the
 * boundary. This does, by reading the **pair** — the client component and the
 * server file that renders it.
 *
 * The rule, checked against the schema rather than assumed: only `invoices`,
 * `bills`, `credit_notes`, `payments` and `retainers` carry a currency column.
 * A figure off one of those is a document's own money and must be shown in its
 * own currency; everything else is the company's, and `formatCents`' default is
 * right for it.
 */

/**
 * The property names a face column arrives under.
 *
 * `FACE_COLUMNS` (Phase 122) in camelCase: what a row of `invoices`, `bills`,
 * `credit_notes`, `payments` or `retainers` calls its own money.
 */
const FACE_PROPERTIES = [
  'totalCents',
  'balanceCents',
  'remainingCents',
  'unappliedCents',
  'amountCents',
  'suspectBalanceCents',
  'closingBalanceCents',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/**
 * The document tables a page reaches, through the modules it imports.
 *
 * A page never queries drizzle itself — `src/app` holds no business logic, which
 * is the rule this codebase has kept since Phase 1. So "does this screen serve
 * document money" is a question about the **modules** it calls, and answering it
 * needs one hop. Scanning the page alone found four carriers and none of the
 * three known defects, which is how this was noticed.
 */
function documentsBehind(page: string): string[] {
  const modules = [...page.matchAll(/from '(@\/modules\/[\w/-]+)'/g)].map((m) =>
    m[1].replace('@/modules', 'src/modules'),
  )

  const seen = new Set<string>()
  for (const mod of modules) {
    const path = [`${mod}.ts`, `${mod}/index.ts`].find((p) => existsSync(p))
    if (!path) continue
    const src = readFileSync(path, 'utf8')
    for (const table of DOCUMENT_TABLES) {
      if (new RegExp(`\\b${table}\\.[a-zA-Z]`).test(src)) seen.add(table)
    }
  }
  return [...seen]
}

type Carrier = {
  file: string
  type: string
  /** The money fields it declares. */
  cents: string[]
  hasCurrency: boolean
  /** Document tables the server file beside it reads. */
  documents: string[]
}

/**
 * Prop types carrying money in a client component whose server sibling reads a
 * document table.
 *
 * The narrowing that makes this a real list rather than 94 entries of make-work:
 * a page that never touches `invoices`, `bills`, `credit_notes`, `payments` or
 * `retainers` cannot be showing a document's own currency, because nothing else
 * in the schema has one.
 */
function carriers(): Carrier[] {
  const found: Carrier[] = []
  for (const file of sourceFiles('src/app')) {
    const src = readFileSync(file, 'utf8')
    if (!/^['"]use client['"]/m.test(src)) continue

    const page = join(dirname(file), 'page.tsx')
    if (!existsSync(page)) continue
    const documents = documentsBehind(readFileSync(page, 'utf8'))
    if (documents.length === 0) continue

    // Multi-line prop types only. A single-line `type X = { ... }` would make
    // the non-greedy body run on into the next declaration and attribute one
    // type's fields to another — which the first run of this file did, filing
    // the duplicate-bill pair under its one-line neighbour.
    for (const m of src.matchAll(/type (\w+) = \{\n([\s\S]*?)\n\}/g)) {
      const [, type, body] = m
      const cents = [...body.matchAll(/^\s*(\w*[Cc]ents)\??:\s*number/gm)].map((x) => x[1])
      // Only money named after a face column. A page reaching `invoices` through
      // some module it imports says nothing about whether *this* row is a
      // document — a drawer count and a job budget both arrive that way. The
      // field name is what ties the figure back to a table that has a currency.
      if (!cents.some((c) => FACE_PROPERTIES.includes(c))) continue
      found.push({
        file,
        type,
        cents,
        hasCurrency: /^\s*currency\??:\s*string/m.test(body),
        documents,
      })
    }
  }
  return found
}

describe('what makes money on a screen a document’s rather than the books’', () => {
  it('names the tables that carry a currency, and no others', () => {
    // Checked against the schema in Phase 124: billing schedules, proposals,
    // deposits, contributions, purchase orders, time entries, assets and
    // statement runs all carry none. If a sixth ever grows one, this list is
    // where somebody has to notice.
    expect([...DOCUMENT_TABLES]).toEqual([
      'invoices',
      'bills',
      'creditNotes',
      'payments',
      'retainers',
    ])
  })

  it('argues each classification from where the data comes from', () => {
    for (const row of SCREEN_MONEY) {
      expect(row.because.length, `${row.file} ${row.type}`).toBeGreaterThan(140)
    }
  })

  it('refuses a screen nobody classified', () => {
    expect(() => screenMoneyFor('src/app/nowhere/board.tsx', 'Ghost')).toThrow(
      /No basis is declared/,
    )
  })

  it('keeps every declaration pointing at a type that is still there', () => {
    const present = new Set(carriers().map((c) => `${c.file}:${c.type}`))
    const stale = SCREEN_MONEY.filter(
      (row) => !present.has(`${row.file}:${row.type}`),
    ).map((row) => `${row.file}:${row.type}`)

    expect(stale).toEqual([])
  })
})

describe('reading the boundary, both sides', () => {
  const found = carriers()

  it('finds carriers to look at, so a broken scan cannot pass silently', () => {
    expect(found.length).toBeGreaterThan(5)
  })

  it('shows a document’s money in the document’s own currency', () => {
    const bare = found
      .filter((c) => {
        const declared = SCREEN_MONEY.find(
          (row) => row.file === c.file && row.type === c.type,
        )
        if (declared?.basis !== 'document') return false
        // A nested row names the currency for its own context, so the entry
        // says which field to look for (Phase 125).
        const named = declared.currencyField ?? 'currency'
        const body = readFileSync(c.file, 'utf8')
        return !new RegExp(`^\\s*${named}\\??:`, 'm').test(body)
      })
      .map((c) => `${c.file} type ${c.type} [${c.cents.join(', ')}]`)

    expect(bare).toEqual([])
  })

  it('passes that currency to formatCents rather than letting the default decide', () => {
    const wrong: string[] = []
    for (const row of SCREEN_MONEY.filter((r) => r.basis === 'document')) {
      const src = readFileSync(row.file, 'utf8')
      const carrier = found.find((c) => c.file === row.file && c.type === row.type)
      if (!carrier) continue

      const fields = row.fields ?? carrier.cents
      for (const prop of carrier.cents.filter((c) => fields.includes(c))) {
        // A one-argument formatCents of one of this type's own money fields
        // takes the 'USD' default, whatever the document actually says.
        for (const m of src.matchAll(
          new RegExp(`formatCents\\(\\s*(\\w+)\\.${prop}\\s*\\)`, 'g'),
        )) {
          // The scan matches by property name, so one file's two different
          // things can collide. An exemption has to argue what the money is.
          if (nameCollisionFor(row.file, `${m[1]}.${prop}`)) continue
          wrong.push(`${row.file}:${src.slice(0, m.index!).split('\n').length} ${m[0]}`)
        }
      }
    }

    expect(wrong).toEqual([])
  })
})

describe('the honest remainder', () => {
  it('argues every name collision from what the money actually is', () => {
    for (const row of NAME_COLLISIONS) {
      expect(row.because.length, row.expression).toBeGreaterThan(140)
    }
  })

  it('keeps the unclassified count from growing without somebody saying why', () => {
    // Phase 121's device: a list with reasons beats a silence. Phase 124 put
    // this at 19, counted off a list that had already moved; Phase 125 traced
    // all seventeen and the honest remainder is thirteen, every one of which
    // reads no face column at all. It may shrink; it must not quietly grow.
    expect(UNCLASSIFIED_CARRIERS).toBeLessThanOrEqual(13)
  })
})
