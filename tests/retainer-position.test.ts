import { describe, expect, it } from 'vitest'
import {
  verdictFor,
  weakerBecauseShared,
  type Holding,
  type Position,
} from '@/modules/timebilling/retainer-position'

/**
 * What the retainers say against what the ledger says (Phase 105).
 *
 * The integrity register checked gift cards against 2590, tenant deposits
 * against 2580, overpayments against 2520 and practitioner earnings against
 * 2320, and had nothing at all for retainers — a client's money, taken before
 * the work is done.
 *
 * The judgement this file is about: `retainerAccount` falls back from
 * `2550 Client Retainers Held` to `2500 Unearned Revenue`, and that fallback is
 * the common case rather than the rare one. Equality is simply not true on a
 * shared account, so the check makes a weaker claim there and says that it did.
 */

const position = (over: Partial<Position> = {}): Position => ({
  heldCents: 320_000,
  ledgerCents: 320_000,
  holding: 'dedicated',
  accountNumber: '2550',
  accountName: 'Client Retainers Held',
  openCount: 2,
  ...over,
})

describe('a dedicated account', () => {
  it('agrees when the two are equal', () => {
    const verdict = verdictFor(position())

    expect(verdict.agrees).toBe(true)
    expect(verdict.claim).toBe('Σ retainers equals 2550 Client Retainers Held')
    // Nothing to say when nothing is wrong.
    expect(verdict.detail).toBeUndefined()
  })

  it('fails on any difference, and says what a difference means', () => {
    const verdict = verdictFor(position({ ledgerCents: 250_000 }))

    expect(verdict.agrees).toBe(false)
    expect(verdict.detail).toContain('2 retainers hold 3200.00')
    expect(verdict.detail).toContain('carries 2500.00')
    // The reason it is a fault rather than a timing artefact.
    expect(verdict.detail).toContain('one half happened without the other')
  })

  it('fails when the ledger is the larger of the two as well', () => {
    // Not a "not more than" check: on a dedicated account an excess in the
    // ledger is just as wrong as a shortfall.
    expect(verdictFor(position({ ledgerCents: 400_000 })).agrees).toBe(false)
  })

  it('has nothing to add about sharing', () => {
    expect(weakerBecauseShared(position())).toBeUndefined()
  })
})

describe('a shared account', () => {
  const shared = (over: Partial<Position> = {}): Position =>
    position({
      holding: 'shared',
      accountNumber: '2500',
      accountName: 'Unearned Revenue',
      ...over,
    })

  it('claims only that the retainers do not exceed the account', () => {
    const verdict = verdictFor(shared())

    expect(verdict.claim).toBe('Σ retainers does not exceed 2500 Unearned Revenue')
    expect(verdict.agrees).toBe(true)
  })

  it('agrees when the account is larger, because other deferred revenue is there', () => {
    // The case that would make a naive equality check cry wolf on six of the
    // seven companies in the development database.
    expect(verdictFor(shared({ ledgerCents: 900_000 })).agrees).toBe(true)
  })

  it('fails when the retainers exceed everything deferred', () => {
    const verdict = verdictFor(shared({ heldCents: 500_000, ledgerCents: 320_000 }))

    expect(verdict.agrees).toBe(false)
    expect(verdict.detail).toContain('more than the 3200.00')
    // Why this is impossible rather than merely surprising.
    expect(verdict.detail).toContain('should be the larger of the two')
    expect(verdict.detail).toContain('A ledger half is missing')
  })

  it('says out loud that it checked the weaker thing', () => {
    // A check that quietly downgrades what it asserts is worse than one that is
    // absent: the screen shows a tick either way.
    const note = weakerBecauseShared(shared())

    expect(note).toContain('2500 Unearned Revenue')
    expect(note).toContain('only "not more than"')
    // And turns the limitation into an instruction.
    expect(note).toContain('Installing 2550')
  })
})

describe('the sentence a person reads', () => {
  it('counts one retainer as one, verb and all', () => {
    // Phase 96 shipped "1 recurring invoices" by pluralising the noun and
    // hardcoding the rest of the clause. The same sentence has three things
    // that must agree on the count, so all three are asserted.
    const verdict = verdictFor(position({ openCount: 1, ledgerCents: 0 }))

    expect(verdict.detail).toContain('1 retainer holds 3200.00')
    expect(verdict.detail).not.toContain('retainers')
    // One retainer holds its money on its own, not "between them".
    expect(verdict.detail).not.toContain('between them')
  })

  it('says "between them" only when there is more than one', () => {
    const verdict = verdictFor(position({ openCount: 2, ledgerCents: 0 }))
    expect(verdict.detail).toContain('2 retainers hold 3200.00 between them')
  })

  it('renders money the way the rest of the register does', () => {
    const verdict = verdictFor(position({ heldCents: 7, ledgerCents: 0 }))
    expect(verdict.detail).toContain('0.07')
  })

  it('does not lose a negative ledger balance in the wording', () => {
    // A liability account gone the wrong way is exactly what somebody needs to
    // see, so it must not come out as an unsigned number.
    const verdict = verdictFor(position({ ledgerCents: -5000 }))
    expect(verdict.detail).toContain('-50.00')
  })

  it('makes the claim readable whichever holding it ran under', () => {
    for (const holding of ['dedicated', 'shared'] as Holding[]) {
      const verdict = verdictFor(position({ holding }))
      expect(verdict.claim.length, holding).toBeGreaterThan(20)
      expect(verdict.claim, holding).toContain('Σ retainers')
    }
  })
})
