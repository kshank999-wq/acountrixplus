import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BANK_POSTINGS,
  bankPostingFor,
  mayPostToBank,
} from '@/modules/fx/bank-side'

/**
 * The currency of the account money lands in (Phase 133).
 *
 * No database, no clock — it reads the source, like the two scans it sits
 * beside. `LEDGER_POSTINGS` asks whether a figure is the company's own money;
 * this asks whether the account it lands on is held in that money, which is a
 * question nothing had asked of anything but the bank feed.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

/** The enclosing function a character offset sits inside. */
function symbolAt(src: string, index: number): string {
  const matches = [...src.slice(0, index).matchAll(/(?:export )?(?:async )?function (\w+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}

/**
 * Every journal line whose account comes from a bank account's row.
 *
 * Two spellings, because the ledger reaches it through a helper. Most paths
 * write `chartAccountId: bank.chartAccountId` directly; `posting.ts` and
 * `restate.ts` resolve it once into `glAccountId` and post that. Matching only
 * the first form missed four functions — including the bank feed, the one path
 * that has always got this right — which is the same narrow-scan failure Phase
 * 128 found in the posting scan and Phase 131 in the screen scan.
 *
 * `bankGlAccount` itself is skipped: it is the helper that reads the account,
 * not a place money is posted.
 */
function bankSides(): { file: string; symbol: string; line: number }[] {
  const found: { file: string; symbol: string; line: number }[] = []
  for (const file of sourceFiles('src/modules')) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(
      /chartAccountId: ((?:bank|account|financialAccount)\.chartAccountId|\w*[gG]l(?:AccountId)?)\b/g,
    )) {
      const symbol = symbolAt(src, m.index!)
      if (symbol === 'bankGlAccount') continue
      found.push({ file, symbol, line: src.slice(0, m.index!).split('\n').length })
    }
  }
  return found
}

describe('what a foreign bank account does to a posting', () => {
  it('lets a domestic account through untouched', () => {
    // Why this went a hundred and thirty phases unnoticed: with one currency
    // the two questions have the same answer, so nothing ever disagreed.
    expect(
      mayPostToBank({
        accountName: 'Business Checking',
        accountCurrency: 'USD',
        homeCurrency: 'USD',
        what: 'remitting this liability',
      }),
    ).toEqual({ ok: true })
  })

  it('refuses a foreign one in a sentence that says which account and why', () => {
    const verdict = mayPostToBank({
      accountName: 'Frankfurt Current',
      accountCurrency: 'EUR',
      homeCurrency: 'USD',
      what: 'remitting this liability',
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return

    // Names the account, both currencies, the act, and what to do instead —
    // Phase 119's standard for a refusal somebody has to act on.
    expect(verdict.why).toContain('Frankfurt Current')
    expect(verdict.why).toContain('EUR')
    expect(verdict.why).toContain('USD')
    expect(verdict.why).toContain('remitting this liability')
    expect(verdict.why).toMatch(/journal entry/)
  })

  it('reads a currency the same however it is cased or padded', () => {
    // `isForeign` normalises, and this is the assertion that says the refusal
    // inherits that rather than comparing raw strings.
    expect(
      mayPostToBank({
        accountName: 'Business Checking',
        accountCurrency: 'usd',
        homeCurrency: 'USD',
        what: 'banking this',
      }).ok,
    ).toBe(true)
  })
})

describe('every place money reaches a bank account', () => {
  const sides = bankSides()

  it('finds the postings to check, so a broken scan cannot pass silently', () => {
    // Measured, not bounded (Phase 126's lesson). Nineteen postings in fourteen
    // functions: four that convert and ten that refuse.
    //
    // Three wrong numbers were written before this one — eleven from reading a
    // grep, thirteen from counting the registry, and only then nineteen from
    // running the scan. Each was plausible; none was measured. It is the
    // failure this file exists to stop, committed while writing the file.
    expect(sides.length).toBe(19)
    expect(new Set(sides.map((s) => `${s.file}:${s.symbol}`)).size).toBe(14)
  })

  it('has a declared handling for every one of them', () => {
    const undeclared = [
      ...new Set(
        sides
          .filter((site) => {
            try {
              bankPostingFor(site.file, site.symbol)
              return false
            } catch {
              return true
            }
          })
          .map((site) => `${site.file}:${site.line} ${site.symbol}`),
      ),
    ]

    expect(undeclared).toEqual([])
  })

  it('keeps every declaration pointing at a function that still posts', () => {
    const live = new Set(sides.map((site) => `${site.file}:${site.symbol}`))
    const stale = BANK_POSTINGS.filter(
      (row) => !live.has(`${row.file}:${row.symbol}`),
    ).map((row) => `${row.file}:${row.symbol}`)

    // Both directions, on Phase 122's rule: a declaration pointing at code that
    // has moved is a claim nobody is checking any more.
    expect(stale).toEqual([])
  })

  it('argues each handling from what the path can and cannot know', () => {
    for (const row of BANK_POSTINGS) {
      expect(row.because.length, `${row.file} ${row.symbol}`).toBeGreaterThan(140)
    }
  })

  it('counts the four that convert and the ten that do not', () => {
    const converts = BANK_POSTINGS.filter((row) => row.handling === 'converts')
    const refuses = BANK_POSTINGS.filter((row) => row.handling === 'refuses')

    // The four are the bank feed, its transfer pair, its restatement and
    // banking deposits — the whole of what knew, before this phase, which
    // account it was posting to.
    expect(converts.map((row) => row.symbol).sort()).toEqual([
      'buildLines',
      'createDeposit',
      'restatePosting',
      'syncLedgerForTransferPair',
    ])
    expect(refuses.length).toBe(10)
  })

  it('refuses a posting site nobody declared', () => {
    expect(() => bankPostingFor('src/modules/nowhere/service.ts', 'postSomething')).toThrow(
      /No bank posting handling is declared/,
    )
  })
})
