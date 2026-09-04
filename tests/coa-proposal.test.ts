import { describe, expect, it } from 'vitest'
import { NUMBER_RANGES, labelFor, proposeAccount, rangeFor } from '@/modules/coa/proposal'
import { STANDARD_ACCOUNTS, SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { accountsForIndustry } from '@/modules/coa/service'
import { INDUSTRY_PACKS } from '@/modules/coa/industry'

/**
 * Whether a proposed account is coherent (Phase 118). No database, no clock.
 *
 * `createAccount` was written in Phase 1 — *"spec §5 allows full
 * customization"* — and called by nothing for 117 phases. There was no screen
 * showing the chart of accounts at all. It also validated nothing, so the
 * refusals arrive with the screen.
 */

describe('the bands the chart is laid out in', () => {
  it('covers every account type exactly once, with no gap and no overlap', () => {
    const sorted = [...NUMBER_RANGES].sort((a, b) => a.from - b.from)
    expect(sorted[0].from).toBe(1000)
    expect(sorted[sorted.length - 1].to).toBe(9999)

    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].from, `${sorted[i].type} follows ${sorted[i - 1].type}`).toBe(
        sorted[i - 1].to + 1,
      )
    }

    expect(new Set(NUMBER_RANGES.map((row) => row.type)).size).toBe(NUMBER_RANGES.length)
  })

  it('describes every band in the terms of the books, not by its number', () => {
    for (const band of NUMBER_RANGES) {
      expect(band.because.length, band.type).toBeGreaterThan(60)
    }
  })

  it('refuses to place a type nobody declared a home for', () => {
    // The Phase 101 device: adding an account type has to answer where in the
    // chart it belongs before an account of it can be numbered.
    expect(() => rangeFor('crypto' as never)).toThrow(/No number range is declared/)
  })

  it('names each band in a sentence a person would say', () => {
    for (const band of NUMBER_RANGES) {
      expect(labelFor(band.type).length).toBeGreaterThan(4)
    }
  })
})

describe('the bands describe the chart this application actually installs', () => {
  it('holds for every standard account', () => {
    // Grounded in the seeded chart rather than a convention from a book — if
    // the standard chart ever contradicted the bands, the screen would be
    // refusing numbers the software itself uses.
    for (const account of STANDARD_ACCOUNTS) {
      const band = rangeFor(account.type)
      const value = Number(account.number)
      expect(
        value >= band.from && value <= band.to,
        `${account.number} ${account.name} (${account.type}) outside ${band.from}-${band.to}`,
      ).toBe(true)
    }
  })

  it('holds for every industry pack too', () => {
    for (const industry of Object.keys(INDUSTRY_PACKS) as (keyof typeof INDUSTRY_PACKS)[]) {
      for (const account of accountsForIndustry(industry)) {
        const band = rangeFor(account.type)
        const value = Number(account.number)
        expect(
          value >= band.from && value <= band.to,
          `${industry}: ${account.number} ${account.name} (${account.type})`,
        ).toBe(true)
      }
    }
  })
})

const NOTHING_TAKEN = { taken: [] as string[], reserved: [] as string[] }

describe('proposing an account', () => {
  it('accepts a plain one and trims what a person typed', () => {
    const verdict = proposeAccount({
      proposal: { number: ' 6210 ', name: '  Van hire  ', type: 'expense' },
      ...NOTHING_TAKEN,
    })

    expect(verdict).toEqual({ ok: true, number: '6210', name: 'Van hire' })
  })

  it('refuses one with no name, because a report shows the name', () => {
    const verdict = proposeAccount({
      proposal: { number: '6210', name: '   ', type: 'expense' },
      ...NOTHING_TAKEN,
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toMatch(/needs a name/)
  })

  it.each(['621', '62100', '62a0', '', 'six thousand'])(
    'refuses %j, which is not an account number',
    (number) => {
      const verdict = proposeAccount({
        proposal: { number, name: 'Van hire', type: 'expense' },
        ...NOTHING_TAKEN,
      })

      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.why).toMatch(/Four digits/)
    },
  )

  it('refuses a number the application installs and looks up by name', () => {
    // Before this, taking 1100 left the software posting receivables into an
    // account somebody else had named.
    const verdict = proposeAccount({
      proposal: { number: SYSTEM_ACCOUNTS.accountsReceivable, name: 'Mine now', type: 'asset' },
      taken: [],
      reserved: Object.values(SYSTEM_ACCOUNTS),
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toMatch(/installs and looks up by number/)
  })

  it('refuses a number already on the chart, in a sentence rather than a unique index', () => {
    const verdict = proposeAccount({
      proposal: { number: '6210', name: 'Van hire', type: 'expense' },
      taken: ['6210'],
      reserved: [],
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toMatch(/already on this chart/)
  })

  it('refuses a retired account’s number, because its history still points there', () => {
    // `taken` is every number, active or not — reusing one would file two
    // different accounts' entries under a single heading.
    const verdict = proposeAccount({
      proposal: { number: '6210', name: 'Van hire again', type: 'expense' },
      taken: ['6210'],
      reserved: [],
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toMatch(/retired account keeps its number/)
  })

  it('refuses an expense numbered among the assets', () => {
    const verdict = proposeAccount({
      proposal: { number: '1050', name: 'Van hire', type: 'expense' },
      ...NOTHING_TAKEN,
    })

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.why).toMatch(/outside 6000–6999/)
      // The refusal carries the band's argument, so the reader learns the rule
      // rather than only that they broke one.
      expect(verdict.why).toMatch(/overheads/)
    }
  })

  it('accepts the same number for the type it belongs to', () => {
    expect(
      proposeAccount({
        proposal: { number: '1050', name: 'Petty cash tin', type: 'asset' },
        ...NOTHING_TAKEN,
      }).ok,
    ).toBe(true)
  })

  it('accepts an account at either edge of its band', () => {
    for (const band of NUMBER_RANGES) {
      for (const number of [String(band.from), String(band.to)]) {
        expect(
          proposeAccount({
            proposal: { number, name: 'Edge', type: band.type },
            ...NOTHING_TAKEN,
          }).ok,
          `${number} for ${band.type}`,
        ).toBe(true)
      }
    }
  })

  it('says what would fix it every time it refuses', () => {
    const refusals = [
      { number: '621', name: 'A', type: 'expense' as const },
      { number: '1050', name: 'A', type: 'expense' as const },
      { number: '6210', name: '', type: 'expense' as const },
    ]

    for (const proposal of refusals) {
      const verdict = proposeAccount({ proposal, taken: [], reserved: [] })
      expect(verdict.ok).toBe(false)
      // Phase 47's rule: a sentence a person can act on beats a violation they
      // cannot.
      if (!verdict.ok) expect(verdict.why.length).toBeGreaterThan(60)
    }
  })
})
