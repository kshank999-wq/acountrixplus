import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_POSTINGS,
  ledgerPostingFor,
  recoveryFunctional,
} from '@/modules/fx/ledger'
import { carrierProperties } from '@/modules/fx/carriers'

/**
 * Only the company's own money reaches the ledger (Phase 127).
 *
 * Phase 122 read the source for sums that add currencies, Phase 123 for the
 * form they are written in, Phase 124 for money crossing to a screen. None of
 * them looked at the last hop — the one where a number becomes a journal line
 * and stops being anybody's opinion.
 *
 * Two writes were posting a face amount there. A fully recovered €2,500
 * write-off left $250 of bad-debt expense on the books forever; banking a €500
 * receipt left $50 in Undeposited Funds. Both are proved against the database
 * in `tests/functional-postings.test.ts`; this file is what stops a third.
 */

/**
 * The tables whose rows carry a currency, from the registry the schema checks.
 *
 * This was nine names typed out here (Phase 127). The schema has thirteen, and
 * the four missing ones — `financial_accounts` above all — took twenty-two
 * posting sites out of the scan's reach, including the bank feed. It comes from
 * `fx/carriers.ts` now, whose own test asks `information_schema` whether the
 * list is complete (Phase 128).
 */
const CURRENCY_TABLES = carrierProperties()

/**
 * The file that declares the rule is not scanned by it.
 *
 * `ledger.ts` quotes both defects verbatim in its prose, including the
 * `debitCents: input.amountCents` that caused one — the self-matching problem
 * Phase 123 solved for its own scanner and Phase 125 had to solve again for its
 * sibling. Excluding the declaring file by rule is honest; tightening the regex
 * until the documentation stops matching is not.
 */
const DECLARES_THE_RULE = 'src/modules/fx/ledger.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (path === DECLARES_THE_RULE) return []
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

/** The enclosing function a character offset sits inside. */
function symbolAt(src: string, index: number): string {
  const matches = [...src.slice(0, index).matchAll(/(?:export )?(?:async )?function (\w+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}

type Site = { file: string; symbol: string; line: number; expression: string }

/**
 * Every place a named value reaches `debitCents` or `creditCents`, in a module
 * that also reads a currency-bearing table.
 *
 * The narrowing is Phase 123's, and it is what turns 189 sites into 103 in 36
 * functions. A payroll run posts money too; nothing in its file can be foreign,
 * so asking it to argue would be noise rather than rigour.
 *
 * It read 81 in 28 until Phase 128, because `CURRENCY_TABLES` was a list of
 * nine names typed by a person and the schema has thirteen. It comes from
 * `carrierProperties()` now, which is checked against `information_schema`.
 */
function postingSites(): Site[] {
  const sites: Site[] = []
  for (const file of sourceFiles('src/modules')) {
    const src = readFileSync(file, 'utf8')
    const touchesCurrency = CURRENCY_TABLES.some((table) =>
      new RegExp(`\\b${table}\\.[a-zA-Z]`).test(src),
    )
    if (!touchesCurrency) continue

    for (const m of src.matchAll(/(?:debitCents|creditCents):\s*([A-Za-z_][\w.]*)/g)) {
      sites.push({
        file,
        symbol: symbolAt(src, m.index!),
        line: src.slice(0, m.index!).split('\n').length,
        expression: m[1],
      })
    }
  }
  return sites
}

describe('what the ledger will accept', () => {
  it('finds posting sites to check, so a broken scan cannot pass silently', () => {
    // Measured, not bounded (Phase 126's lesson about `<= 13` asserted against
    // a constant of 13). `toBeGreaterThan(50)` was true of the narrowing that
    // missed four tables and would have stayed true if it missed eight more.
    // Change the code and this number moves; change it deliberately and say so.
    // 103 in 36 from Phase 129 until Phase 130 added `restatePosting`, which
    // reads the original entry's lines back and posts the difference — so it
    // contributes both reads and writes to the scan.
    expect(postingSites().length).toBe(111)
    expect(new Set(postingSites().map((site) => `${site.file}:${site.symbol}`)).size).toBe(37)
  })

  it('has a declared basis for every one of them', () => {
    const undeclared = [
      ...new Set(
        postingSites()
          .filter((site) => {
            try {
              ledgerPostingFor(site.file, site.symbol)
              return false
            } catch {
              return true
            }
          })
          .map((site) => `${site.file}:${site.line} ${site.symbol} — ${site.expression}`),
      ),
    ]

    expect(undeclared).toEqual([])
  })

  it('keeps every declaration pointing at a function that still posts', () => {
    const live = new Set(postingSites().map((site) => `${site.file}:${site.symbol}`))
    const stale = LEDGER_POSTINGS.filter(
      (row) => !live.has(`${row.file}:${row.symbol}`),
    ).map((row) => `${row.file}:${row.symbol}`)

    // Both directions, on Phase 122's rule: an excuse pointing at code that has
    // moved is a claim nobody is checking any more.
    expect(stale).toEqual([])
  })

  it('argues each basis from where the number comes from', () => {
    for (const row of LEDGER_POSTINGS) {
      expect(row.because.length, `${row.file} ${row.symbol}`).toBeGreaterThan(140)
    }
  })

  it('makes an exempted expression argue itself too, and still be real', () => {
    const sites = postingSites()
    for (const row of LEDGER_POSTINGS) {
      for (const expression of row.alsoDomestic ?? []) {
        // Both directions: the exemption has to name something the scan
        // actually finds, or it is an excuse for code that has moved.
        expect(
          sites.some((site) => site.symbol === row.symbol && site.expression === expression),
          `${row.symbol} exempts ${expression}, which is not posted there`,
        ).toBe(true)
        expect(row.because).toContain(expression)
      }
    }
  })

  it('refuses a posting site nobody declared', () => {
    expect(() => ledgerPostingFor('src/modules/nowhere/service.ts', 'postSomething')).toThrow(
      /No ledger posting basis is declared/,
    )
  })

  /**
   * The rule in one assertion.
   *
   * A site declared `converted` must not post something still named after a
   * document's own amount. This is the shape of both Phase 127 defects, and it
   * is the check that would have caught them the day they were written.
   */
  it('posts nothing still named after a document’s own amount', () => {
    const faceNamed = postingSites()
      .filter((site) => {
        const declared = LEDGER_POSTINGS.find(
          (row) => row.file === site.file && row.symbol === site.symbol,
        )
        if (declared?.basis !== 'converted') return false
        // A symbol may post one figure that is domestic by construction, and
        // has to argue it (Phase 124's `fields` narrowing, same shape).
        if (declared.alsoDomestic?.includes(site.expression)) return false
        const leaf = site.expression.split('.').pop() ?? ''
        return /^(amount|total|receipts|balance|remaining|unapplied|price)Cents$/.test(leaf)
      })
      .map((site) => `${site.file}:${site.line} ${site.symbol} — ${site.expression}`)

    expect(faceNamed).toEqual([])
  })
})

describe('what a recovery of a written-off debt is worth', () => {
  const domestic = {
    amountCents: 100_000,
    functionalAmountCents: 100_000,
    recoveredCents: 0,
    functionalRecoveredCents: 0,
  }
  const euros = {
    amountCents: 250_000,
    functionalAmountCents: 275_000,
    recoveredCents: 0,
    functionalRecoveredCents: 0,
  }

  it('is the same number for a domestic write-off, which is why nobody noticed', () => {
    expect(recoveryFunctional(domestic, 100_000).functionalCents).toBe(100_000)
  })

  it('takes the whole carried loss off a full recovery, not the face amount', () => {
    // The defect in one assertion: this returned 250000 before Phase 127, so a
    // fully recovered write-off left 25000 of expense on the books.
    expect(recoveryFunctional(euros, 250_000).functionalCents).toBe(275_000)
  })

  it('converts a part recovery at the rate the write-off was carried at', () => {
    expect(recoveryFunctional(euros, 100_000).functionalCents).toBe(110_000)
  })

  it('gives the last of it whatever rounding left behind', () => {
    // 3333 of 10000 face, carried at 11000 functional: two part recoveries at
    // 3666 each, and the last one takes 3668 rather than a third computed sum.
    const odd = {
      amountCents: 10_000,
      functionalAmountCents: 11_000,
      recoveredCents: 0,
      functionalRecoveredCents: 0,
    }
    const first = recoveryFunctional(odd, 3_333)
    const after = {
      ...odd,
      recoveredCents: 3_333,
      functionalRecoveredCents: first.functionalCents,
    }
    const second = recoveryFunctional(after, 3_333)
    const last = recoveryFunctional(
      {
        ...odd,
        recoveredCents: 6_666,
        functionalRecoveredCents: first.functionalCents + second.functionalCents,
      },
      3_334,
    )

    expect(first.functionalCents + second.functionalCents + last.functionalCents).toBe(11_000)
  })

  it('never leaves a residue, whatever the split', () => {
    // The property the rounding rule exists for: three part recoveries summing
    // back to exactly what the books carried, for every split of the face
    // amount. A stranded cent here is a bad-debt balance nobody can clear.
    for (let first = 1; first < 250_000; first += 7_919) {
      const one = recoveryFunctional(euros, first)
      const rest = recoveryFunctional(
        { ...euros, recoveredCents: first, functionalRecoveredCents: one.functionalCents },
        250_000 - first,
      )
      expect(one.functionalCents + rest.functionalCents, `split at ${first}`).toBe(275_000)
    }
  })
})
