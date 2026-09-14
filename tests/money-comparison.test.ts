import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMPARED_PAIRS,
  COMPARISON_FORMS,
  comparabilityStands,
  comparedPairFor,
  comparisonFormFor,
} from '@/modules/fx/comparison'
import { enclosingSymbol, enclosingSpan, withoutComments } from '@/modules/source/enclosing'

/**
 * No comparison puts two currencies against each other (Phase 144).
 *
 * No database, no clock — it reads the source, like the four scans beside it.
 * Phase 122 built this for money being **added** and Phase 123 gave it a
 * registry of forms; nothing was ever built for money being **compared**, and
 * `€500 > $500` is as meaningless as `€500 + $500`.
 *
 * Two of the five defects before this phase were comparisons, both found by
 * hand: Phase 138's `input.amountCents > position.heldCents` and Phase 142's
 * `redeemFor(card.balanceCents, bill.balanceCents)`.
 */

/**
 * The declaring file is not scanned by it.
 *
 * `comparison.ts` holds a `looksLike` example of each form, so it matches
 * itself — the rule `addition.ts` has had since Phase 123, applied for the same
 * reason. Excluding it by rule is honest; tightening the regex until the
 * documentation stops matching would not be.
 */
const DECLARES_THE_FORMS = 'src/modules/fx/comparison.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (path === DECLARES_THE_FORMS) return []
    return path.endsWith('.ts') ? [path] : []
  })
}

/**
 * Source with comments **and string literals** blanked, offsets preserved.
 *
 * Phase 141 blanked comments, because a posting site is code and a sentence
 * about one is not. Strings are the other half of that rule, and this phase is
 * what found it: `LEDGER_POSTINGS` and `PENDING_WIRING` both quote real
 * comparisons inside their `because` and `liveDefect` prose, so the first run of
 * this scan reported three registries describing defects as three more defects —
 * including the entry **this phase wrote** about `redeemGiftCard`.
 */
function readable(file: string): string {
  return withoutComments(readFileSync(file, 'utf8'))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '))
}

/** Drizzle table identifiers for the tables that carry a currency. */
const CARRIER_IDENTIFIERS = [
  'invoices',
  'bills',
  'creditNotes',
  'payments',
  'retainers',
  'recurringInvoices',
  'invoiceWriteOffs',
  'deposits',
  'financialAccounts',
  'checkouts',
  'payouts',
  'refunds',
  'bankTransactions',
  'reconciliations',
  'invoiceLines',
  'billLines',
  'creditNoteLines',
  'paymentApplications',
  'creditApplications',
  'depositItems',
  'payoutItems',
  'retainerApplications',
  'invoiceCostings',
  'taxRemittances',
]

/**
 * Callees that are not a money comparison.
 *
 * `eq`, `gte` and `lte` are drizzle's query builders — a column against a bound
 * value, which the database compares and which carries no currency question of
 * its own. `sqlAdd` adds rather than compares and is Phase 123's business.
 */
const NOT_A_COMPARISON = new Set(['Math', 'convert', 'eq', 'gte', 'lte', 'sqlAdd', 'and', 'or', 'sql'])

type Site = { file: string; symbol: string; line: number; form: string; text: string }

/** Every place two money amounts meet, in a file that reads a currency-bearing table. */
function comparisons(): Site[] {
  const sites: Site[] = []

  for (const file of sourceFiles('src/modules')) {
    const src = readable(file)
    if (!CARRIER_IDENTIFIERS.some((id) => new RegExp(`\\b${id}\\.[a-zA-Z]`).test(src))) continue

    for (const form of COMPARISON_FORMS) {
      for (const match of src.matchAll(new RegExp(form.pattern, 'g'))) {
        if (form.key === 'handed_over' && NOT_A_COMPARISON.has(match[1])) continue

        sites.push({
          file,
          symbol: enclosingSymbol(src, match.index),
          line: src.slice(0, match.index).split('\n').length,
          form: form.key,
          text: match[0].trim().replace(/[,)]$/, ''),
        })
      }
    }
  }

  return sites
}

/** Measured: do both operands read off one identifier? */
function sameRow(text: string): boolean {
  const operands = [...text.matchAll(/([A-Za-z_][\w.]*[cC]ents)/g)].map((m) => m[1])
  if (operands.length < 2) return false

  const roots = operands.map((operand) => operand.split('.').slice(0, -1).join('.'))
  return roots[0] !== '' && roots.every((root) => root === roots[0])
}

/** Measured: does this function refuse a currency mismatch before it compares? */
function refusesMismatch(file: string, line: number): boolean {
  const src = readable(file)
  const offset = src.split('\n').slice(0, line).join('\n').length
  const { from, to } = enclosingSpan(src, offset)

  return /creditableAgainst\(|isForeign\(|mayPostToBank\(|refuseMixedCurrency\(/.test(
    src.slice(from, to),
  )
}

describe('the forms money is compared in', () => {
  it('argues each form, and says what it reaches that the others do not', () => {
    for (const form of COMPARISON_FORMS) {
      expect(form.because.length, form.key).toBeGreaterThan(140)
      expect(form.looksLike.length, form.key).toBeGreaterThan(10)
      expect(() => new RegExp(form.pattern, 'g'), form.key).not.toThrow()
    }
  })

  it('names the fourth form, which is the one the defect needed', () => {
    // The point of having a registry rather than a regex. `redeemGiftCard`'s
    // comparison happens inside `redeemFor`, a pure helper in a file that reads
    // no currency-bearing table — so the three obvious forms all miss it, and a
    // scan built without the fourth would have missed the defect it was for.
    expect(COMPARISON_FORMS.map((form) => form.key)).toEqual([
      'relational',
      'bounded',
      'equality',
      'handed_over',
    ])
  })

  it('refuses a form nobody declared', () => {
    expect(() => comparisonFormFor('ternary')).toThrow(/No comparison form is declared/)
  })
})

describe('reading the source for comparisons', () => {
  const sites = comparisons()

  it('finds them, so a broken scan cannot pass silently', () => {
    // Measured, not bounded (Phase 126). Twenty-three functions, and every form
    // present in the wild — a form nothing matches is a form nobody has had to
    // defend.
    expect(new Set(sites.map((site) => `${site.file}:${site.symbol}`)).size).toBe(23)

    const found = new Set(sites.map((site) => site.form))
    expect([...found].sort()).toEqual(['bounded', 'equality', 'handed_over', 'relational'])
  })

  it('has a declared comparability for every one of them', () => {
    const undeclared = [
      ...new Set(
        sites
          .filter((site) => {
            try {
              comparedPairFor(site.file, site.symbol)
              return false
            } catch {
              return true
            }
          })
          .map((site) => `${site.file}:${site.line} ${site.symbol} — ${site.text}`),
      ),
    ]

    expect(undeclared).toEqual([])
  })

  it('keeps every declaration pointing at a comparison that is still there', () => {
    // Both directions, on Phase 122's rule: an excuse pointing at code that has
    // moved is a claim nobody is checking any more.
    const live = new Set(sites.map((site) => `${site.file}:${site.symbol}`))
    const stale = COMPARED_PAIRS.filter((row) => !live.has(`${row.file}:${row.symbol}`)).map(
      (row) => `${row.file}:${row.symbol}`,
    )

    expect(stale).toEqual([])
  })

  it('holds each declared reason to what the source actually does', () => {
    const wrong = COMPARED_PAIRS.map((pair) => {
      const own = sites.filter(
        (site) => site.file === pair.file && site.symbol === pair.symbol,
      )

      return comparabilityStands({
        pair,
        refusesMismatch: own.some((site) => refusesMismatch(site.file, site.line)),
        sameRow: own.some((site) => sameRow(site.text)),
      })
    })
      .filter((verdict) => !verdict.ok)
      .map((verdict) => (verdict.ok ? '' : verdict.why))

    expect(wrong).toEqual([])
  })

  it('argues every one from what the code guarantees', () => {
    for (const pair of COMPARED_PAIRS) {
      expect(pair.because.length, pair.symbol).toBeGreaterThan(140)
    }
  })
})

describe('what the scan found on the day it was written', () => {
  it('names three, and every one of them was already known', () => {
    // **The assertion the phase exists for**, and the only way to know a new
    // scan works: it disagrees on its first run (Phase 121), and what it
    // disagrees about is three defects found by hand over five phases — not
    // three new ones nobody can check.
    const blind = COMPARED_PAIRS.filter((pair) => pair.comparability === 'blind')

    expect(blind.map((pair) => pair.symbol).sort()).toEqual([
      'applyDeposit',
      'contractorPayments',
      'redeemGiftCard',
    ])

    // Each says where the repair is tracked, so none is a defect somebody wrote
    // down and then lost.
    for (const pair of blind) {
      expect(pair.trackedIn, pair.symbol).toBeTruthy()
    }
  })

  it('tells two siblings in one file apart', () => {
    // Why this is per-site rather than per-file. `applyDeposit` and
    // `refundDeposit` contain the *same expression* —
    // `input.amountCents > position.heldCents` — and one is wrong. Refunding
    // hands the tenant back the company's own money; applying it puts that
    // money against an invoice that may be in any currency at all.
    expect(comparedPairFor('src/modules/properties/deposits.ts', 'applyDeposit').comparability).toBe(
      'blind',
    )
    expect(
      comparedPairFor('src/modules/properties/deposits.ts', 'refundDeposit').comparability,
    ).toBe('home-money')
  })

  it('uses every reason it declares, so none is decoration', () => {
    const used = new Set(COMPARED_PAIRS.map((pair) => pair.comparability))
    expect([...used].sort()).toEqual([
      'blind',
      'home-money',
      'inherited',
      'refused-upstream',
      'same-row',
    ])
  })
})

describe('what comparabilityStands refuses', () => {
  const pair = comparedPairFor('src/modules/receivables/service.ts', 'voidDocument')

  it('catches a same-row claim over two rows', () => {
    const verdict = comparabilityStands({ pair, refusesMismatch: false, sameRow: false })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('One row has')
  })

  it('catches a refusal that is not there', () => {
    const verdict = comparabilityStands({
      pair: { ...pair, comparability: 'refused-upstream' },
      refusesMismatch: false,
      sameRow: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('most expensive kind of argument')
  })

  it('catches a known defect with nowhere tracking the repair', () => {
    // What stops `blind` becoming a place to put things and forget them, which
    // is the failure Phase 139 built `PENDING_WIRING` to prevent.
    const verdict = comparabilityStands({
      pair: { ...pair, comparability: 'blind', trackedIn: undefined },
      refusesMismatch: false,
      sameRow: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('wrote down and then lost')
  })

  it('refuses a site nobody declared', () => {
    expect(() => comparedPairFor('src/modules/nowhere/service.ts', 'compareSomething')).toThrow(
      /Nothing declares how the two amounts compared/,
    )
  })
})
