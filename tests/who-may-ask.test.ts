import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { askingFor } from '@/modules/fx/asking'
import { BANK_POSTINGS } from '@/modules/fx/bank-side'

/**
 * Which paths may be told what currency the money is in (Phase 136, part 3).
 *
 * No database, no clock. ADR 0136 said `importPayouts` was the only one of
 * Phase 133's ten with a field saying what currency the money is in, and that
 * "the other nine have no such field".
 *
 * **Five of the nine did.** They were reading it for their own rate lookups and
 * never handing it to the guard. The claim was written from memory rather than
 * measured, which is the error Phase 135 exists to catch, committed one ADR
 * later — so the correction is a rule that measures, not a rewritten sentence.
 */

/** The body of one top-level function, from its declaration to the closing brace. */
function bodyOf(file: string, symbol: string): string {
  const src = readFileSync(file, 'utf8')
  const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${symbol}\\(`, 'm'))
  if (start < 0) throw new Error(`${symbol} is not a top-level function in ${file}`)

  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end < 0 ? undefined : end)
}

/**
 * The arguments of a call, split on the commas that are actually separators.
 *
 * Walking the parens rather than matching them: these calls are written across
 * several lines, one is written on one line, and every one of them has a
 * comment sitting among the arguments. A regex that gets the multi-line shape
 * right silently returns nothing for the single-line one — which is a scan that
 * misses a site, the failure Phases 128, 131 and 133 each hit.
 *
 * **Comments are skipped rather than stripped afterwards**, and this test found
 * out why on its first run: the comment beside `payment.currency` says "at the
 * day's rate", and that apostrophe opened a string literal the walker never
 * closed, so it ran off the end and reported *no* arguments. Two correctly
 * wired sites read as unwired. A scan that goes quiet on prose it did not
 * expect is the same failure one layer down.
 */
function argumentsOf(body: string, callee: string): string[] | null {
  const at = body.indexOf(`${callee}(`)
  if (at < 0) return null

  let depth = 0
  let quote = ''
  const args: string[] = []
  let current = ''

  for (let i = at + callee.length; i < body.length; i++) {
    const char = body[i]

    if (quote) {
      if (char === quote && body[i - 1] !== '\\') quote = ''
      current += char
      continue
    }

    // A comment is not code, and its apostrophes are not quotes.
    if (char === '/' && body[i + 1] === '/') {
      i = body.indexOf('\n', i)
      if (i < 0) return null
      continue
    }
    if (char === '/' && body[i + 1] === '*') {
      const close = body.indexOf('*/', i + 2)
      if (close < 0) return null
      i = close + 1
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth++
    if (char === ')' || char === ']' || char === '}') {
      depth--
      if (depth === 0) {
        args.push(current)
        return args.map(strip).filter((arg) => arg.length > 0)
      }
    }
    if (char === ',' && depth === 1) {
      args.push(current)
      current = ''
      continue
    }
    if (depth >= 1) current += char
  }

  return null
}

/** An argument without its leading paren, comments or whitespace. */
function strip(arg: string): string {
  return arg
    .replace(/^\(/, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
}

/**
 * What a posting site actually does, read off the source.
 *
 * Never declared. Phase 49's rule pointed the other way — a function with no
 * caller is a feature that does not exist — and this is its mirror: a
 * declaration nothing wires up is a claim that is false, and the only way to
 * know which is to go and look.
 */
function measured(file: string, symbol: string) {
  const body = bodyOf(file, symbol)

  // A fifth argument to `bankGlAccountFor` is the money's currency.
  const args = argumentsOf(body, 'bankGlAccountFor')

  return {
    passesMoneyCurrency: (args?.length ?? 0) >= 5,
    readsMoneyCurrency: /\.currency\b|\bcurrency:|\bconst currency\b/.test(body),
    strikesAtDayRate: /\brateFor\(/.test(body),
  }
}

describe('what every posting site actually does with the money’s currency', () => {
  const sites = BANK_POSTINGS.map((row) => ({ row, ...measured(row.file, row.symbol) }))

  it('finds a call site for every declaration, so a broken scan cannot pass', () => {
    // Measured, not bounded (Phase 126). Four `converts` reach the account
    // through the feed rather than the guard, so ten call the guard.
    expect(sites.length).toBe(14)
    // Six since Phase 151 wired `recoverWriteOff`, which is the only entry in
    // `BANK_POSTINGS` whose handling has ever changed — and this line is what
    // noticed, exactly as intended: the code started passing a currency while
    // the registry still said it could not.
    expect(sites.filter((site) => site.passesMoneyCurrency).length).toBe(6)
  })

  it('agrees with what each entry declares', () => {
    // The assertion that would have caught ADR 0136's claim: five paths reading
    // a currency while declaring they have no field for one.
    const disagreements = sites
      .map((site) => askingFor({ symbol: site.row.symbol, handling: site.row.handling, withheld: site.row.withheld, ...site }))
      .filter((verdict) => !verdict.ok)
      .map((verdict) => (verdict.ok ? '' : verdict.why))

    expect(disagreements).toEqual([])
  })

  it('counts the three handlings, and the six that ask', () => {
    const by = (handling: string) => BANK_POSTINGS.filter((row) => row.handling === handling)

    expect(by('converts').length).toBe(4)
    // `recoverWriteOff` joined them in Phase 151 and is the only entry whose
    // handling has ever moved. It had the currency all along and was refused
    // the right to pass it because the figure it banked was struck at the
    // write-off's carried rate; wiring `recoverHeld` gave it a day rate, and
    // the reason for withholding went with it.
    expect(by('matched').map((row) => row.symbol).sort()).toEqual([
      'importPayouts',
      'receiveRetainer',
      'recoverWriteOff',
      'refundCredit',
      'refundRetainer',
      'refundVendorCredit',
    ])
    expect(by('refuses').length).toBe(4)
  })

  it('makes every refusing path say why it cannot ask, and only one blame the rate', () => {
    const refuses = BANK_POSTINGS.filter((row) => row.handling === 'refuses')

    expect(refuses.filter((row) => row.withheld === 'no-field').map((row) => row.symbol)).toEqual([
      'recordRemittance',
      'receivePledge',
      'receiveDeposit',
      'refundDeposit',
    ])

    // `no-day-rate` was `recoverWriteOff`'s alone and is nobody's since Phase
    // 151 wired it. The value stays declared rather than deleted: it is the
    // reason a path with the currency in hand may still not pass it, and the
    // next path in that position should find the vocabulary already there
    // rather than argue it again.
    expect(refuses.filter((row) => row.withheld === 'no-day-rate')).toEqual([])
  })
})

describe('what askingFor refuses', () => {
  it('catches a `matched` declaration nothing wired up', () => {
    // Exactly the shape of a phase that updates a registry and forgets the
    // call site — which is how Phase 134's contradiction happened.
    const verdict = askingFor({
      symbol: 'receiveDeposit',
      handling: 'matched',
      passesMoneyCurrency: false,
      readsMoneyCurrency: true,
      strikesAtDayRate: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('passes no money currency')
    expect(verdict.why).toContain('Phase 49')
  })

  it('catches a path that asks without declaring that it does', () => {
    const verdict = askingFor({
      symbol: 'recoverWriteOff',
      handling: 'refuses',
      withheld: 'no-day-rate',
      passesMoneyCurrency: true,
      readsMoneyCurrency: true,
      strikesAtDayRate: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('The registry and the code disagree')
  })

  it('catches ADR 0136’s actual mistake', () => {
    // "The other nine have no such field", said of a path holding
    // `writeOff.currency`. Argued from a fact that is not a fact (Phase 110).
    const verdict = askingFor({
      symbol: 'refundRetainer',
      handling: 'refuses',
      withheld: 'no-field',
      passesMoneyCurrency: false,
      readsMoneyCurrency: true,
      strikesAtDayRate: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('its body reads one')
    expect(verdict.why).toContain('ADR 0136')
  })

  it('refuses to let a path post a figure the statement will not show', () => {
    // The reason `recoverWriteOff` is not simply wired up like the other four.
    // Having the currency is necessary and not sufficient.
    const verdict = askingFor({
      symbol: 'recoverWriteOff',
      handling: 'matched',
      passesMoneyCurrency: true,
      readsMoneyCurrency: true,
      strikesAtDayRate: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('not what the statement will show')
  })

  it('makes a refusing path give a reason at all', () => {
    const verdict = askingFor({
      symbol: 'somethingNew',
      handling: 'refuses',
      passesMoneyCurrency: false,
      readsMoneyCurrency: false,
      strikesAtDayRate: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('does not say why')
  })

  it('catches a withheld reason that overstates what the path knows', () => {
    const verdict = askingFor({
      symbol: 'receivePledge',
      handling: 'refuses',
      withheld: 'no-day-rate',
      passesMoneyCurrency: false,
      readsMoneyCurrency: false,
      strikesAtDayRate: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('overstates what the path knows')
  })

  it('catches a converting path claiming to withhold something', () => {
    const verdict = askingFor({
      symbol: 'buildLines',
      handling: 'converts',
      withheld: 'no-field',
      passesMoneyCurrency: false,
      readsMoneyCurrency: true,
      strikesAtDayRate: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('nothing it is withholding')
  })

  it('leaves the four that convert alone', () => {
    // They reach the account through the feed rather than the guard, and have
    // known its currency since Phase 128.
    expect(
      askingFor({
        symbol: 'buildLines',
        handling: 'converts',
        passesMoneyCurrency: false,
        readsMoneyCurrency: true,
        strikesAtDayRate: true,
      }).ok,
    ).toBe(true)
  })
})
