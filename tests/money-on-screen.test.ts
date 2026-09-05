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
import { FACE_COLUMNS } from '@/modules/fx/comparable'
import { INHERITED_CURRENCY, denominatedProperties } from '@/modules/fx/inherited'

/**
 * Money reaching a screen says what it is denominated in (Phase 124).
 *
 * ADR 0123 could not reach this: a client component receives a plain type
 * rather than reading a drizzle table, so nothing followed the prop across the
 * boundary. This does, by reading the **pair** — the client component and the
 * server file that renders it.
 *
 * The rule: a figure off a row that carries a currency — **or borrows one from
 * a row it cannot exist without** — is a document's own money and must be shown
 * wearing it; everything else is the company's, and `formatCents`' default is
 * right for it.
 *
 * The second clause is Phase 131's, and both halves of the question were being
 * answered from lists typed by hand until then. This file said "only
 * `invoices`, `bills`, `credit_notes`, `payments` and `retainers` carry a
 * currency column" and named `deposits` among the tables that carry none, which
 * had been false since Phase 127. Both lists come from registries the schema
 * checks now.
 */

/**
 * The property names a face column arrives under.
 *
 * Seven, typed out, until Phase 131 — which is the same defect as the table
 * list beside it and was found the same way. Derived now from the two
 * registries that answer the question: `FACE_COLUMNS` (Phase 122), what a row
 * with a currency calls its own money, and `INHERITED_CURRENCY` (Phase 131),
 * what a row that borrows one calls it. That is what brings a reconciliation's
 * three statement balances into the scan.
 */
const FACE_PROPERTIES = [
  ...new Set([
    ...FACE_COLUMNS.map((row) => row.column),
    ...INHERITED_CURRENCY.flatMap((row) => row.faceColumns),
  ]),
].map((column) => column.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()))

/**
 * Names a screen gives a document's money that no column has.
 *
 * Two, and neither is derivable because neither is a column: a duplicate-bill
 * pair's balance and a statement's closing balance are both computed in a
 * module and named for the screen. They were in the hand-typed list Phase 131
 * replaced, and they stay — declared as the exception rather than lost in the
 * derivation.
 */
const SCREEN_NAMED_FACE = ['suspectBalanceCents', 'closingBalanceCents']

const ALL_FACE_PROPERTIES = [...FACE_PROPERTIES, ...SCREEN_NAMED_FACE]

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
      if (!cents.some((c) => ALL_FACE_PROPERTIES.includes(c))) continue
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
  it('takes the tables from the registries rather than a list typed here', () => {
    // Phase 124 checked five against the schema and said: "If a sixth ever
    // grows one, this list is where somebody has to notice." Nobody did.
    // Phase 126 grew two and came back; Phase 127 grew two more and did not;
    // Phase 128 found four that had been there for years and fixed the sibling
    // scan instead. Seven against a schema of thirteen, and the eight tables
    // that borrow a currency were never in reach at all.
    expect([...DOCUMENT_TABLES]).toEqual([...denominatedProperties()])

    // The two that matter most, pinned by name: neither carries a currency
    // column, and one of them is the bank feed.
    expect(DOCUMENT_TABLES).toContain('bankTransactions')
    expect(DOCUMENT_TABLES).toContain('reconciliations')
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
        //
        // Through one `Math.abs`, since Phase 131. The mobile review deck
        // writes `formatCents(Math.abs(current.amountCents))` and this matched
        // the bare form only — so bringing the deck into reach would have found
        // it and passed it. Thirteen call sites in `src/app` wrap money that
        // way, and a sign is not a denomination: hiding a figure behind a call
        // the checker cannot read is how a check becomes decorative.
        //
        // Both closing brackets, or the `Math.abs` branch matches the fixed
        // call too — found by this test failing on the repair it had just
        // asked for.
        for (const m of src.matchAll(
          new RegExp(
            `formatCents\\(\\s*(?:Math\\.abs\\(\\s*(\\w+)\\.${prop}\\s*\\)|(\\w+)\\.${prop})\\s*\\)`,
            'g',
          ),
        )) {
          // The scan matches by property name, so one file's two different
          // things can collide. An exemption has to argue what the money is.
          const object = m[1] ?? m[2]
          if (nameCollisionFor(row.file, `${object}.${prop}`)) continue
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

  it('measures the unclassified remainder rather than taking its word for it', () => {
    // This asserted `<= 13` against a constant of 13 — true whatever the
    // codebase does, and equally true of Phase 124's wrong 19, which is how
    // that survived a green suite for a whole phase. Computed now, and
    // compared exactly: the number may change, but only when somebody changes
    // it and writes down why.
    const remainder = carriers().filter(
      (c) =>
        !c.hasCurrency &&
        !SCREEN_MONEY.some((row) => row.file === c.file && row.type === c.type),
    )

    expect(remainder.map((c) => `${c.file}:${c.type}`).length).toBe(UNCLASSIFIED_CARRIERS)
  })
})
