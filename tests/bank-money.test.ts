import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BANK_MONEY_SITES,
  bankMoneyLines,
  bankMoneySiteFor,
  bankMoneyStands,
  type BankMoneyInput,
  type BankMoneySite,
} from '@/modules/fx/bank-money'
import { BANK_POSTINGS } from '@/modules/fx/bank-side'
import { PENDING_WIRING } from '@/modules/staging/wiring'
import { RATE_ONE } from '@/modules/fx/rates'
import { RegistryError } from '@/modules/errors/registry'
import { declaresFunction } from '@/modules/source/enclosing'

/**
 * Which balance the bank line is posted against (Phase 153).
 *
 * The four paths `BANK_POSTINGS` has carried as `withheld: 'no-field'` since
 * Phase 136. Three relieve a balance the books already carry; one creates it.
 * Both mistakes balance, which is why the question is declared and measured
 * rather than left to each caller.
 */

const source = (file: string) => readFileSync(file, 'utf8')

/** The body of one exported function, so a measurement is about that path. */
function bodyOf(file: string, symbol: string): string {
  const src = source(file)
  const starts = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)]
  const index = starts.findIndex((match) => match[1] === symbol)
  if (index < 0) throw new Error(`${symbol} is not a top-level function in ${file}`)
  const from = starts[index].index
  const to = starts[index + 1]?.index ?? src.length
  return src.slice(from, to)
}

/** Still on the wiring register, and therefore not yet held to the source. */
function stillBlocked(site: BankMoneySite): boolean {
  return PENDING_WIRING.some((entry) =>
    entry.targets.some((target) => target.file === site.file && target.symbol === site.symbol),
  )
}

describe('the sites, and that they are the four that were blocked', () => {
  it('names the four, none of them withheld any longer', () => {
    // The set is four because `withheld: 'no-field'` was four when Phase 136
    // measured it. Three were cleared by Phase 153's migration; the fourth needed
    // a row rather than a column and was cleared by Phase 157, which is the last
    // path on `BANK_POSTINGS` that refused anything.
    expect(BANK_MONEY_SITES).toHaveLength(4)

    const withheld = BANK_POSTINGS.filter((row) => row.withheld === 'no-field').map(
      (row) => `${row.file}:${row.symbol}`,
    )
    expect(withheld).toEqual([])
    // And nothing refuses a foreign account at all now, which is what the ten
    // paths Phase 133 found all did.
    expect(BANK_POSTINGS.filter((row) => row.handling === 'refuses')).toEqual([])

    // And every site is in `BANK_POSTINGS` under one heading or the other, so
    // the two registers cannot drift into describing different sets.
    for (const site of BANK_MONEY_SITES) {
      expect(
        BANK_POSTINGS.some((row) => row.file === site.file && row.symbol === site.symbol),
        site.symbol,
      ).toBe(true)
    }
  })

  it('leaves no site blocked, which it did for twenty-one phases', () => {
    // `PENDING_WIRING` is empty since Phase 157 — the first time since Phase 139
    // built it. So every site here is held to the source below, with nothing
    // excused.
    expect(BANK_MONEY_SITES.filter(stillBlocked)).toEqual([])
    expect(PENDING_WIRING).toEqual([])
  })

  it('points every entry at a function that exists', () => {
    // Phase 140's repair, applied here from the start: a registry keyed by
    // `file:symbol` can be asked whether its keys are real.
    for (const site of BANK_MONEY_SITES) {
      expect(declaresFunction(source(site.file), site.symbol), site.symbol).toBe(true)
    }
  })

  it('argues each one from what raised the balance', () => {
    for (const site of BANK_MONEY_SITES) {
      expect(site.because.length, site.symbol).toBeGreaterThan(140)
    }
  })

  it('uses all three origins, so none is decoration', () => {
    // Phase 147's rule. A registry where every entry answers the same way is a
    // registry that has not been asked anything.
    //
    // Three since Phase 157, and the third was found by **wiring** the site this
    // registry had declared and never acted on. `origin` as Phase 153 wrote it
    // asked whether the balance pre-exists; what decides whether a difference
    // arises is whether it carries a rate. `receivePledge`'s receivable
    // pre-exists and is held in the books' own money, which the first two values
    // could not spell — so `already-carried` goes from three entries to two.
    const origins = new Set(BANK_MONEY_SITES.map((row) => row.origin))
    expect([...origins].sort()).toEqual([
      'already-carried',
      'carried-in-home-money',
      'created-here',
    ])

    expect(BANK_MONEY_SITES.filter((row) => row.origin === 'already-carried')).toHaveLength(2)
    expect(BANK_MONEY_SITES.filter((row) => row.origin === 'created-here')).toHaveLength(1)
    expect(BANK_MONEY_SITES.filter((row) => row.origin === 'carried-in-home-money')).toHaveLength(1)
  })

  it('tells the two deposit siblings apart', () => {
    // The pair that makes per-site declaration necessary. Taking a deposit in
    // creates the liability; giving it back relieves one the books may have
    // carried for years. Same file, same table, opposite answers.
    expect(
      bankMoneySiteFor('src/modules/properties/deposits.ts', 'receiveDeposit').origin,
    ).toBe('created-here')
    expect(
      bankMoneySiteFor('src/modules/properties/deposits.ts', 'refundDeposit').origin,
    ).toBe('already-carried')
  })

  it('refuses a site nobody declared', () => {
    expect(() => bankMoneySiteFor('src/modules/nowhere/x.ts', 'y')).toThrow(RegistryError)
    try {
      bankMoneySiteFor('src/modules/nowhere/x.ts', 'y')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('BANK_MONEY_SITES')
    }
  })
})

describe('the lines, from the face amount and the day', () => {
  /** 1.10 — the euro on the day the money moved. */
  const DAY = 1_100_000

  it('posts what arrived and relieves what was carried, in', () => {
    // A €1,000 pledge raised when the euro was worth 1.0835 and paid now.
    // The receivable comes off at what it was carried at; the bank takes the
    // day's rate; the $165 between them is realised.
    const lines = bankMoneyLines({
      faceCents: 100_000,
      dayRateMillionths: DAY,
      origin: 'already-carried',
      direction: 'in',
      carriedCents: 108_350,
    })

    expect(lines.bankCents).toBe(110_000)
    expect(lines.againstCents).toBe(108_350)
    // Debit less credit. A gain: the euro owed to us got dearer.
    expect(lines.realisedCents).toBe(1_650)
  })

  it('posts what left and relieves what was carried, out', () => {
    // $1,200 owed to an agency, paid from a euro account. €1,100 left, worth
    // $1,210 on the day, so the company gave up $10 more than it owed.
    const lines = bankMoneyLines({
      faceCents: 110_000,
      dayRateMillionths: DAY,
      origin: 'already-carried',
      direction: 'out',
      carriedCents: 120_000,
    })

    expect(lines.bankCents).toBe(121_000)
    expect(lines.againstCents).toBe(120_000)
    // Debit less credit again, and a loss this time. Same arithmetic, opposite
    // sign, which is the thing ADR 0068 said nobody should have to remember.
    expect(lines.realisedCents).toBe(-1_000)
  })

  it('balances, which is what the three figures are for', () => {
    // `debit === credit + realised` by construction. Asserted because the whole
    // reason both mistakes are quiet is that a wrong entry still foots.
    for (const direction of ['in', 'out'] as const) {
      const lines = bankMoneyLines({
        faceCents: 100_000,
        dayRateMillionths: DAY,
        origin: 'already-carried',
        direction,
        carriedCents: 97_311,
      })

      const debit = direction === 'in' ? lines.bankCents : lines.againstCents
      const credit = direction === 'in' ? lines.againstCents : lines.bankCents
      expect(debit, direction).toBe(credit + lines.realisedCents)
    }
  })

  it('gives a created balance the converted figure and no difference', () => {
    const lines = bankMoneyLines({
      faceCents: 300_000,
      dayRateMillionths: DAY,
      origin: 'created-here',
      direction: 'in',
    })

    expect(lines.bankCents).toBe(330_000)
    expect(lines.againstCents).toBe(330_000)
    expect(lines.realisedCents).toBe(0)
  })

  it('cannot be asked for either mistake, because neither compiles', () => {
    // **A constraint beats a check** (Phase 116), and this is what says the
    // constraint is real rather than a comment claiming one. The first draft
    // threw at runtime for both of these; `origin` discriminates a union now, so
    // a wrong call site fails before it runs.
    //
    // Written as assignability rather than `@ts-expect-error`, because these
    // assert something stronger: not that one spelling errors today, but that
    // the shape is *not assignable at all*. If either constraint were loosened
    // the conditional below would resolve to `false` and this file would stop
    // typechecking.

    /** A created balance handed a carried figure: a gain from one conversion. */
    type Conjured = {
      faceCents: number
      dayRateMillionths: number
      origin: 'created-here'
      direction: 'in'
      carriedCents: number
    }
    const conjuredIsRejected: Conjured extends BankMoneyInput ? false : true = true

    /** A carried balance with nothing to relieve: the bank left short. */
    type Unrelieved = {
      faceCents: number
      dayRateMillionths: number
      origin: 'already-carried'
      direction: 'out'
    }
    const unrelievedIsRejected: Unrelieved extends BankMoneyInput ? false : true = true

    expect([conjuredIsRejected, unrelievedIsRejected]).toEqual([true, true])

    // And the shapes that *are* right still are, so the constraint has not
    // simply refused everything.
    type Sound = Unrelieved & { carriedCents: number }
    const soundIsAccepted: Sound extends BankMoneyInput ? true : false = true
    expect(soundIsAccepted).toBe(true)
  })

  it('changes nothing for a domestic account', () => {
    // Why every existing row is unaffected. At the identity rate the converted
    // figure is the face figure, and a balance carried at the same number
    // realises nothing.
    const lines = bankMoneyLines({
      faceCents: 45_000,
      dayRateMillionths: RATE_ONE,
      origin: 'already-carried',
      direction: 'out',
      carriedCents: 45_000,
    })

    expect(lines).toEqual({ bankCents: 45_000, againstCents: 45_000, realisedCents: 0 })
  })
})

describe('the declaration held to the source', () => {
  /** Measured: does this path hand `bankGlAccountFor` a currency argument? */
  function passesCurrency(site: BankMoneySite): boolean {
    const body = bodyOf(site.file, site.symbol)
    // Five arguments, not four: ctx, id, what, exec, currency. A call that stops
    // at the executor is the Phase 133 call, which refuses a foreign account.
    const call = /bankGlAccountFor\(([\s\S]*?)\n\s*\)/.exec(body)?.[1]
    if (!call) return false
    return call.split(',').filter((part) => part.trim().length > 0).length >= 5
  }

  function reachesFxAccount(site: BankMoneySite): boolean {
    return /ensureFxAccount\(/.test(bodyOf(site.file, site.symbol))
  }

  it('matches every site that is wired', () => {
    const wrong = BANK_MONEY_SITES.filter((site) => !stillBlocked(site))
      .map((site) => ({
        site,
        verdict: bankMoneyStands({
          site,
          reachesFxAccount: reachesFxAccount(site),
          passesCurrency: passesCurrency(site),
        }),
      }))
      .filter((row) => !row.verdict.ok)
      .map((row) => `${row.site.symbol}: ${row.verdict.ok === false && row.verdict.why}`)

    expect(wrong).toEqual([])
  })

  it('says no to a home-money balance that reaches the exchange account', () => {
    // The measurable half of the third origin, and a check seen to disagree
    // (Phase 121). `receivePledge` relieves a receivable carrying no rate, so a
    // posting to `7100` from there would be the difference between a figure and
    // itself.
    const site = bankMoneySiteFor('src/modules/funds/contributions.ts', 'receivePledge')
    expect(site.origin).toBe('carried-in-home-money')
    expect(reachesFxAccount(site)).toBe(false)

    const verdict = bankMoneyStands({ site, reachesFxAccount: true, passesCurrency: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/a figure and itself/)
  })

  it('reaches the exchange account from the two wired sites that relieve', () => {
    // Measured both ways rather than asserted once. The one that creates its
    // balance must *not* reach it, and that is the half a looser check would
    // have excused.
    const reaching = BANK_MONEY_SITES.filter(reachesFxAccount)
      .map((site) => site.symbol)
      .sort()

    // The two that relieve a balance carrying its own rate, and only those.
    // `receiveDeposit` creates its balance and `receivePledge`'s is home money,
    // so neither may reach it — for different reasons, which is the whole point
    // of the third origin.
    expect(reaching).toEqual(['recordRemittance', 'refundDeposit'])
    expect(reachesFxAccount(bankMoneySiteFor('src/modules/properties/deposits.ts', 'receiveDeposit'))).toBe(
      false,
    )
  })

  it('says no when a path keeps the currency to itself', () => {
    // A check only ever seen to agree is not a check (Phase 121).
    const site = bankMoneySiteFor('src/modules/payroll/remittance.ts', 'recordRemittance')
    const verdict = bankMoneyStands({ site, reachesFxAccount: true, passesCurrency: false })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/still refused outright/)
  })

  it('says no when a carried balance has nowhere to put the difference', () => {
    const site = bankMoneySiteFor('src/modules/properties/deposits.ts', 'refundDeposit')
    const verdict = bankMoneyStands({ site, reachesFxAccount: false, passesCurrency: true })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/understates it by exactly the movement/)
  })

  it('says no when a created balance posts a gain', () => {
    const site = bankMoneySiteFor('src/modules/properties/deposits.ts', 'receiveDeposit')
    const verdict = bankMoneyStands({ site, reachesFxAccount: true, passesCurrency: true })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toMatch(/conjured out of one conversion/)
  })
})
