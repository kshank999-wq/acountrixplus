import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { claimStands } from '@/modules/fx/no-currency-claim'
import { LEDGER_POSTINGS } from '@/modules/fx/ledger'
import { CURRENCY_CARRIERS } from '@/modules/fx/carriers'
import { INHERITED_CURRENCY } from '@/modules/fx/inherited'
import { BANK_POSTINGS } from '@/modules/fx/bank-side'

/**
 * The declaration that licensed the defect (Phase 140).
 *
 * No database, no clock. `LEDGER_POSTINGS` declares `applyDeposit` as
 * `domestic` and argues it from a fact that is not a fact — "the lease it is
 * applied to carries no currency either" — when a deposit is applied to an
 * **invoice**, which carries both a currency and a rate.
 *
 * The registry did not overlook that site. It declared it safe, and the code did
 * what the declaration said. ADR 0134 met the same shape when `currencyAware`
 * excused a site rather than failing to reach it, and called it worse than
 * missing it: a gap invites a look, a declaration ends one.
 */

/** Drizzle's identifier for a snake_case table. */
function identifierFor(table: string): string {
  const [head, ...rest] = table.split('_')
  return head + rest.map((part) => part[0].toUpperCase() + part.slice(1)).join('')
}

const CARRIER_IDENTIFIERS = new Map(
  [...new Set([...CURRENCY_CARRIERS.map((r) => r.table), ...INHERITED_CURRENCY.map((r) => r.table)])]
    .map((table) => [identifierFor(table), table] as const),
)

/** The body of one top-level function. */
function bodyOf(file: string, symbol: string): string | null {
  const src = readFileSync(file, 'utf8')
  const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${symbol}\\(`, 'm'))
  if (start < 0) return null

  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end < 0 ? undefined : end)
}

/** Currency-carrying tables a body names directly. */
function carriersIn(body: string): string[] {
  return [...CARRIER_IDENTIFIERS]
    .filter(([identifier]) => new RegExp(`\\b${identifier}\\b`).test(body))
    .map(([, table]) => table)
}

/**
 * What a function reaches, **following one call**.
 *
 * The hop is the point. `applyDeposit` reaches `invoices` through
 * `settleInvoiceWithoutCash`, so a body scan reports it clean — and it is the
 * entry the whole phase is about. Stopping at the body would be the reach
 * failure of Phases 128, 131, 133 and 136 committed by the check built to catch
 * a cousin of it.
 */
function reaches(file: string, symbol: string): string[] {
  const body = bodyOf(file, symbol)
  if (body === null) return []

  const found = new Set(carriersIn(body))

  // Every helper this body calls that is defined somewhere in `src/modules`.
  for (const [, callee] of body.matchAll(/\b(?:await )?(\w+)\(/g)) {
    if (callee === symbol) continue
    for (const candidate of CALLABLE_FILES) {
      const hop = bodyOf(candidate, callee)
      if (hop === null) continue
      carriersIn(hop).forEach((table) => found.add(table))
    }
  }

  return [...found].sort()
}

/** The files a hop may land in — every module file a declaration names. */
const CALLABLE_FILES = [
  ...new Set([
    ...LEDGER_POSTINGS.map((row) => row.file),
    'src/modules/receivables/service.ts',
    'src/modules/properties/deposits.ts',
  ]),
]

/** Which paths refuse when the account's currency differs (Phase 133). */
const REFUSES_FOREIGN = new Set(
  BANK_POSTINGS.filter((row) => row.handling === 'refuses').map((row) => row.symbol),
)

/** Does this entry's prose argue from nothing nearby carrying a currency? */
function claimsNoCurrency(because: string): boolean {
  return /no currency|carries no|needs no conversion|both sides .{0,30}(?:books|own money)/i.test(
    because,
  )
}

describe('declarations that argue from nothing carrying a currency', () => {
  const claiming = LEDGER_POSTINGS.filter((row) => claimsNoCurrency(row.because))

  it('finds them, so a broken scan cannot pass silently', () => {
    // Measured, not bounded (Phase 126). Eleven of the thirty-eight entries
    // argue this way, which is why it is worth making the class checkable
    // rather than correcting one sentence.
    expect(claiming.length).toBeGreaterThanOrEqual(8)
    expect(LEDGER_POSTINGS.length).toBeGreaterThanOrEqual(38)
  })

  it('names exactly the one whose argument the source contradicts', () => {
    // **The assertion the phase exists for**, and a check seen to disagree
    // rather than only to agree (Phase 121).
    //
    // `applyDeposit` is declared `domestic` because "the lease carries no
    // currency", reaches `invoices` — which carries one — through
    // `settleInvoiceWithoutCash`, and has nothing that refuses when the two
    // differ. That sentence is what licensed the defect Phase 138 measured, and
    // `PENDING_WIRING` tracks the repair.
    //
    // When the wiring pass fixes `applyDeposit`, this list empties and the test
    // fails — which is the point: the entry must then be corrected too.
    const contradicted = claiming
      .map((row) => ({
        row,
        verdict: claimStands({
          symbol: row.symbol,
          basis: row.basis,
          claimsNoCurrency: true,
          reaches: reaches(row.file, row.symbol),
          refusesForeign: REFUSES_FOREIGN.has(row.symbol),
        }),
      }))
      .filter(({ verdict }) => !verdict.ok)
      .map(({ row }) => row.symbol)

    expect(contradicted).toEqual(['applyDeposit'])
  })

  it('finds the invoice through the call, which a body scan misses', () => {
    // The hop, asserted on its own so that narrowing the scan fails here rather
    // than silently emptying the list above.
    const body = bodyOf('src/modules/properties/deposits.ts', 'applyDeposit') ?? ''

    expect(carriersIn(body)).not.toContain('invoices')
    expect(reaches('src/modules/properties/deposits.ts', 'applyDeposit')).toContain('invoices')
  })

  it('leaves the ones a refusal protects alone', () => {
    // Three touch `financial_accounts` and are still right: Phase 133 made them
    // refuse a foreign account, so their figures really are the books' money —
    // not because no currency is near, but because the path declines when it
    // differs. Reaching a carrier is not what makes a claim false.
    for (const symbol of ['recordRemittance', 'receiveDeposit']) {
      expect(REFUSES_FOREIGN.has(symbol), symbol).toBe(true)

      const row = LEDGER_POSTINGS.find((entry) => entry.symbol === symbol)
      expect(
        claimStands({
          symbol,
          basis: row?.basis ?? 'domestic',
          claimsNoCurrency: true,
          reaches: ['financial_accounts'],
          refusesForeign: true,
        }).ok,
      ).toBe(true)
    }
  })
})

describe('what claimStands refuses', () => {
  it('catches a no-currency argument beside a reachable carrier', () => {
    const verdict = claimStands({
      symbol: 'applyDeposit',
      basis: 'domestic',
      claimsNoCurrency: true,
      reaches: ['invoices'],
      refusesForeign: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return

    expect(verdict.why).toContain('invoices')
    expect(verdict.why).toContain('licensed rather than missed')
  })

  it('catches the argument used for a basis it cannot support', () => {
    // "Nothing here carries a currency" can only argue for `domestic`. A
    // converted figure came from somewhere by definition.
    const verdict = claimStands({
      symbol: 'somePath',
      basis: 'converted',
      claimsNoCurrency: true,
      reaches: [],
      refusesForeign: false,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('only supports `domestic`')
  })

  it('says nothing about an entry that never makes the claim', () => {
    // Most entries argue from something else entirely, and this check has no
    // opinion about those. It is three phrases against one declaration, the
    // same deliberately small reach ADR 0135 gave `DENIALS`.
    expect(
      claimStands({
        symbol: 'buildLines',
        basis: 'converted',
        claimsNoCurrency: false,
        reaches: ['bank_transactions', 'invoices'],
        refusesForeign: false,
      }).ok,
    ).toBe(true)
  })

  it('lets a claim stand when nothing with a currency is in reach', () => {
    expect(
      claimStands({
        symbol: 'openShift',
        basis: 'domestic',
        claimsNoCurrency: true,
        reaches: [],
        refusesForeign: false,
      }).ok,
    ).toBe(true)
  })
})
