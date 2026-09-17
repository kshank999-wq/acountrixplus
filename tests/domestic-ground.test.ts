import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOMESTIC_GROUNDS,
  groundFor,
  groundStands,
  type DomesticGround,
} from '@/modules/fx/ground'
import { LEDGER_POSTINGS } from '@/modules/fx/ledger'
import { BANK_POSTINGS } from '@/modules/fx/bank-side'
import { SAFE_FACE_SUMS } from '@/modules/fx/comparable'
import { CURRENCY_CARRIERS } from '@/modules/fx/carriers'
import { INHERITED_CURRENCY } from '@/modules/fx/inherited'
import { withoutComments } from '@/modules/source/enclosing'

/**
 * What a `domestic` claim stands on (Phase 141).
 *
 * No database, no clock. Fourteen posting sites are declared `domestic` — "the
 * money cannot be foreign here, argued from the schema" — and until this phase
 * none of them said what *kind* of argument it was making. The kinds are not
 * interchangeable, and three of the fourteen turn out to argue one the source
 * contradicts.
 *
 * The ground is declared because choosing it is a judgement; the reach is
 * measured because remembering it is not. That split is Phase 134's lesson: a
 * declaration that excuses a site is worse than one that misses it, so the part
 * that could excuse is the part that has to be checked.
 */

const src = (() => {
  const cache = new Map<string, string>()
  return (file: string) => {
    const hit = cache.get(file)
    if (hit !== undefined) return hit
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    cache.set(file, text)
    return text
  }
})()

/** Drizzle's identifier for a snake_case table. */
function identifierFor(table: string): string {
  const [head, ...rest] = table.split('_')
  return head + rest.map((part) => part[0].toUpperCase() + part.slice(1)).join('')
}

const CARRIER_IDENTIFIERS = new Map(
  [
    ...new Set([
      ...CURRENCY_CARRIERS.map((row) => row.table),
      ...INHERITED_CURRENCY.map((row) => row.table),
    ]),
  ].map((table) => [identifierFor(table), table] as const),
)

/**
 * One top-level function's body, comments blanked.
 *
 * Bounded the way Phase 140 settled it — anchored to column zero, the opening
 * paren required — so a sentence containing the word `function` is not a
 * boundary and a nested declaration is not either.
 */
function bodyOf(file: string, symbol: string): string | null {
  const blank = withoutComments(src(file))
  const start = new RegExp(`^(?:export )?(?:async )?function ${symbol}\\(`, 'm').exec(blank)
  if (!start) return null

  const boundaries = [...blank.matchAll(/^(?:export )?(?:async )?function \w+\(/gm)].map(
    (match) => match.index,
  )
  const end = boundaries.find((offset) => offset > start.index) ?? blank.length

  return blank.slice(start.index, end)
}

/**
 * Where an imported name is defined, as a repo-relative path.
 *
 * A hop resolves through the calling file's own imports rather than through a
 * list of files typed by hand. The hand-typed version is the narrowing that the
 * last five reach failures lived in, and this phase's own first measurement used
 * one — it happened to agree, which is luck rather than a reason to keep it.
 */
function importsOf(file: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const match of src(file).matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g,
  )) {
    const spec = match[2]
    const base = spec.startsWith('@/')
      ? resolve('src', spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(file), spec)
        : null
    if (base === null) continue

    const target = [`${base}.ts`, join(base, 'index.ts')].find((candidate) =>
      existsSync(candidate),
    )
    if (target === undefined) continue

    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) found.set(name, target.replace(`${resolve('.')}/`, ''))
    }
  }

  return found
}

/**
 * Currency-carrying tables a body names.
 *
 * Restricted to what the file actually imports from `@/db/schema`, which is what
 * separates the table `invoices` from a local `invoiceLines` array and from the
 * word in a comment. The first cut of this scan had neither guard and reported
 * both.
 */
function carriersIn(file: string, body: string): string[] {
  const imported = new Set<string>()
  for (const match of src(file).matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/db\/schema'/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) imported.add(name)
    }
  }

  return [...CARRIER_IDENTIFIERS]
    .filter(([identifier]) => imported.has(identifier) && new RegExp(`\\b${identifier}\\b`).test(body))
    .map(([, table]) => table)
}

type Hop = { callee: string; file: string; carriers: string[] }

/** What a function reaches, directly and through one call. */
function reachOf(file: string, symbol: string): { direct: string[]; hops: Hop[] } {
  const body = bodyOf(file, symbol)
  if (body === null) return { direct: [], hops: [] }

  const imports = importsOf(file)
  const hops = new Map<string, Hop>()

  for (const [, callee] of body.matchAll(/\b(\w+)\(/g)) {
    if (callee === symbol || hops.has(callee)) continue

    const target = imports.get(callee) ?? file
    const hopBody = bodyOf(target, callee)
    if (hopBody === null) continue

    const carriers = carriersIn(target, hopBody)
    if (carriers.length > 0) hops.set(callee, { callee, file: target, carriers })
  }

  return { direct: carriersIn(file, body), hops: [...hops.values()] }
}

/** Which paths `BANK_POSTINGS` records as declining a foreign account. */
const REFUSES_FOREIGN = new Set(
  BANK_POSTINGS.filter((row) => row.handling === 'refuses').map((row) => row.symbol),
)

/**
 * Does this body assign a face column and its functional twin the same thing?
 *
 * What "the rate is one" looks like written down, and the only form of that
 * claim a scan can check. `functionalTotalCents: parsed.amountCents` beside
 * `totalCents: parsed.amountCents` passes; converting either one fails.
 */
function writesRateOne(body: string): boolean {
  const assignments = new Map<string, string>()
  for (const match of body.matchAll(/(\w+):\s*([^,\n]+),/g)) {
    assignments.set(match[1], match[2].trim())
  }

  const twins = [...assignments.keys()].filter((key) => /^functional[A-Z]/.test(key))
  if (twins.length === 0) return false

  return twins.every((twin) => {
    const face = twin.slice('functional'.length)
    const faceKey = face[0].toLowerCase() + face.slice(1)
    return assignments.has(faceKey) && assignments.get(faceKey) === assignments.get(twin)
  })
}

/** Everything the scan can say about one declared ground. */
function measured(entry: DomesticGround) {
  const { direct, hops } = reachOf(entry.file, entry.symbol)
  const named = hops.filter((hop) => entry.via.includes(hop.callee))

  const sound = named.filter((hop) => {
    if (entry.ground === 'converted-downstream') {
      const declared = LEDGER_POSTINGS.find(
        (row) => row.file === hop.file && row.symbol === hop.callee,
      )
      return declared?.basis === 'converted'
    }
    if (entry.ground === 'sum-is-one-currency') {
      return SAFE_FACE_SUMS.some((row) => row.file === hop.file && row.symbol === hop.callee)
    }
    if (entry.ground === 'writes-rate-one') {
      return writesRateOne(bodyOf(hop.file, hop.callee) ?? '')
    }
    return false
  })

  return {
    symbol: entry.symbol,
    ground: entry.ground,
    via: entry.via,
    reaches: [...new Set([...direct, ...hops.flatMap((hop) => hop.carriers)])].sort(),
    // Only what a sound `via` reaches. A carrier the body reads itself is never
    // in here, which is what stops a failing entry being rescued by relabelling.
    covered: [...new Set(sound.flatMap((hop) => hop.carriers))].sort(),
    refusesForeign: REFUSES_FOREIGN.has(entry.symbol),
    unsound: entry.via.filter((callee) => !sound.some((hop) => hop.callee === callee)),
  }
}

describe('the ground every domestic entry stands on', () => {
  it('covers exactly the domestic entries, in both directions', () => {
    // Measured, not bounded (Phase 126). A ground for a site that is no longer
    // `domestic` is an excuse for code that has moved; a `domestic` site with no
    // ground is the unargued claim this phase exists to remove.
    const domestic = LEDGER_POSTINGS.filter((row) => row.basis === 'domestic').map(
      (row) => `${row.file}:${row.symbol}`,
    )
    const grounded = DOMESTIC_GROUNDS.map((row) => `${row.file}:${row.symbol}`)

    expect(domestic.length).toBe(14)
    expect(grounded.sort()).toEqual([...domestic].sort())
  })

  it('names every kind of argument at least once, so none is decoration', () => {
    // A ground nothing uses is a ground nobody has had to defend. Five kinds,
    // and the counts are the measurement: four refusals, three that are wrong,
    // and one apiece for the three that argue through a callee.
    const counts = new Map<string, number>()
    for (const row of DOMESTIC_GROUNDS) counts.set(row.ground, (counts.get(row.ground) ?? 0) + 1)

    expect([...counts.keys()].sort()).toEqual([
      'converted-downstream',
      'nothing-in-reach',
      'refuses-foreign',
      'sum-is-one-currency',
      'writes-rate-one',
    ])
    expect(counts.get('refuses-foreign')).toBe(4)
    expect(counts.get('nothing-in-reach')).toBe(7)
  })

  it('argues each ground from the code rather than from what the thing is like', () => {
    // Phase 101's device, and Phase 135's lesson about what it costs when the
    // prose is never checked. Length is the floor, not the point.
    for (const row of DOMESTIC_GROUNDS) {
      expect(row.because.length, row.symbol).toBeGreaterThan(180)
    }
  })

  it('names exactly the three whose ground the source contradicts', () => {
    // **The assertion the phase exists for**, and a check seen to disagree
    // rather than only to agree (Phase 121).
    //
    // `applyDeposit` and `redeemGiftCard` both argue that nothing nearby carries
    // a currency while reading or reaching `invoices`; `recordContribution`
    // argues the same while debiting a bank account its sibling forty lines
    // below is refused a foreign one.
    //
    // When these are repaired the list empties and this fails — which is the
    // point: the ground must then be corrected too.
    const contradicted = DOMESTIC_GROUNDS.map((row) => ({
      row,
      verdict: groundStands(measured(row)),
    }))
      .filter(({ verdict }) => !verdict.ok)
      .map(({ row }) => row.symbol)

    expect(contradicted.sort()).toEqual(['applyDeposit', 'recordContribution', 'redeemGiftCard'])
  })

  it('says what is wrong in a sentence somebody can act on', () => {
    // Phase 119's standard. "Ground does not hold" sends somebody back to the
    // scan; naming the table and what would fix it does not.
    const verdict = groundStands(measured(groundFor('src/modules/properties/deposits.ts', 'applyDeposit')))

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('invoices')
    expect(verdict.why).toContain('or the basis is wrong')
  })
})

describe('what the scan measures, and would miss without each guard', () => {
  it('finds the invoice through the call, which a body scan misses', () => {
    // `applyDeposit` is the entry the phase is about and its body is clean. A
    // scan stopping at the body would report it fine — the reach failure of
    // Phases 128, 131, 133, 136 and 140, committed by the check built to catch
    // a cousin of it.
    const body = bodyOf('src/modules/properties/deposits.ts', 'applyDeposit') ?? ''

    expect(carriersIn('src/modules/properties/deposits.ts', body)).not.toContain('invoices')
    expect(reachOf('src/modules/properties/deposits.ts', 'applyDeposit').direct).not.toContain(
      'invoices',
    )
    expect(
      reachOf('src/modules/properties/deposits.ts', 'applyDeposit').hops.flatMap(
        (hop) => hop.carriers,
      ),
    ).toContain('invoices')
  })

  it('tells the two siblings in one file apart, and they agree now', () => {
    // The Phase 141 finding, as a measurement rather than a sentence: both
    // functions live in `contributions.ts`, both debit a bank account, and only
    // `receivePledge` went through the gate that refuses a foreign one. The
    // same business was told no when a pledge landed in a euro account and
    // nothing at all when a gift did.
    //
    // Phase 151 wired it, so this asserts the agreement rather than the gap.
    // The measurement is unchanged — it is the answer that moved, which is the
    // whole reason this was written as a reach scan and not as prose.
    const gate = (symbol: string) =>
      reachOf('src/modules/funds/contributions.ts', symbol).hops.some(
        (hop) => hop.callee === 'bankGlAccountFor',
      )

    expect(gate('receivePledge')).toBe(true)
    expect(gate('recordContribution')).toBe(true)

    // `BANK_POSTINGS` still has not heard of `recordContribution`, because
    // Phase 133's scan matches a spelling this one avoids — it assigns to
    // `debitAccountId` rather than to a name containing `gl`. Wiring the gate
    // did not change what that scan can see, and pretending otherwise here
    // would hide a reach failure behind a repair.
    expect(BANK_POSTINGS.some((row) => row.symbol === 'receivePledge')).toBe(true)
    expect(BANK_POSTINGS.some((row) => row.symbol === 'recordContribution')).toBe(false)
  })

  it('does not mistake a local array or a comment for a table', () => {
    // Both false positives the first cut of this scan produced, on
    // `completeAppointment`: the word `invoices` in a comment, and an
    // `invoiceLines` array the file never imports from the schema.
    const body = bodyOf('src/modules/appointments/service.ts', 'completeAppointment') ?? ''

    expect(body).toContain('invoiceLines')
    expect(carriersIn('src/modules/appointments/service.ts', body)).toEqual([])
  })

  it('reads a rate of one as the two columns taking the same expression', () => {
    const body = bodyOf('src/modules/importing/opening-balances.ts', 'insertOpeningInvoice') ?? ''

    expect(writesRateOne(body)).toBe(true)
    expect(writesRateOne('{ totalCents: faceCents, functionalTotalCents: convert(faceCents, r) }'))
      .toBe(false)
    expect(writesRateOne('{ totalCents: faceCents }')).toBe(false)
  })
})

describe('what groundStands refuses', () => {
  it('catches a no-currency argument beside a reachable carrier', () => {
    const verdict = groundStands({
      symbol: 'applyDeposit',
      ground: 'nothing-in-reach',
      via: [],
      reaches: ['invoices'],
      covered: [],
      refusesForeign: false,
      unsound: [],
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('invoices')
  })

  it('catches a refusal that BANK_POSTINGS does not record', () => {
    // What `recordContribution` would hit if somebody relabelled it rather than
    // repairing it: claiming the refusal does not create one.
    const verdict = groundStands({
      symbol: 'recordContribution',
      ground: 'refuses-foreign',
      via: [],
      reaches: ['financial_accounts'],
      covered: [],
      refusesForeign: false,
      unsound: [],
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('a refusal nobody can rely on')
  })

  it('catches a ground that points at a callee and names none', () => {
    const verdict = groundStands({
      symbol: 'somePath',
      ground: 'converted-downstream',
      via: [],
      reaches: ['invoices'],
      covered: [],
      refusesForeign: false,
      unsound: [],
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('has to say which one')
  })

  it('catches a claim about this site that names a callee anyway', () => {
    const verdict = groundStands({
      symbol: 'somePath',
      ground: 'nothing-in-reach',
      via: ['createInvoice'],
      reaches: [],
      covered: [],
      refusesForeign: false,
      unsound: [],
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('One or the other is the argument')
  })

  it('catches a named callee that does not do what the ground claims', () => {
    // The hole a self-declared field would otherwise leave: relabelling
    // `applyDeposit` as converted-downstream through the callee it really does
    // call, which is not declared `converted` anywhere.
    const verdict = groundStands({
      symbol: 'applyDeposit',
      ground: 'converted-downstream',
      via: ['settleInvoiceWithoutCash'],
      reaches: ['invoices'],
      covered: [],
      refusesForeign: false,
      unsound: ['settleInvoiceWithoutCash'],
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('does not do that')
  })

  it('catches a ground that covers some of what is in reach but not all', () => {
    const verdict = groundStands({
      symbol: 'commitOpenDocumentImport',
      ground: 'writes-rate-one',
      via: ['insertOpeningInvoice'],
      reaches: ['bills', 'invoices'],
      covered: ['invoices'],
      refusesForeign: false,
      unsound: [],
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('leaving bills')
  })

  it('lets each sound ground stand', () => {
    expect(
      groundStands({
        symbol: 'openShift',
        ground: 'nothing-in-reach',
        via: [],
        reaches: [],
        covered: [],
        refusesForeign: false,
        unsound: [],
      }).ok,
    ).toBe(true)

    expect(
      groundStands({
        symbol: 'receiveDeposit',
        ground: 'refuses-foreign',
        via: [],
        reaches: ['financial_accounts'],
        covered: [],
        refusesForeign: true,
        unsound: [],
      }).ok,
    ).toBe(true)

    expect(
      groundStands({
        symbol: 'completeAppointment',
        ground: 'converted-downstream',
        via: ['createInvoice'],
        reaches: ['invoice_lines', 'invoices'],
        covered: ['invoice_lines', 'invoices'],
        refusesForeign: false,
        unsound: [],
      }).ok,
    ).toBe(true)
  })

  it('refuses a site nobody declared a ground for', () => {
    expect(() => groundFor('src/modules/nowhere/service.ts', 'postSomething')).toThrow(
      /No ground is declared/,
    )
  })
})
