import { describe, expect, it } from 'vitest'
import { recoverHeld, settleHeld } from '@/modules/fx/settlement'
import { convert } from '@/modules/fx/rates'
import { relieveFunctional } from '@/modules/fx/documents'

/**
 * Which side the balance is on (Phase 68).
 *
 * `settleHeld` was written in Phase 66 for held money — a liability, debited as
 * it leaves — and its names said so. That hid the thing that actually decides
 * the sign.
 *
 * A vendor credit posts `Dr Accounts Payable / Cr Expense` when it is issued,
 * so an unapplied one is an **asset**: money the supplier owes back. Recovering
 * it debits the bank and credits the payable, which is the same settlement with
 * the sides swapped — and handing it to `settleHeld` in liability order would
 * return a gain carrying a loss's sign, in an entry that still balances.
 */

/** 1.0835 when the credit was raised; 1.10 when the money came back. */
const RAISED = 1_083_500
const RETURNED = 1_100_000

describe('the invariant both functions share', () => {
  it('is the debit side less the credit side, whichever is which', () => {
    expect(settleHeld({ releasedCents: 54_175, relievedCents: 55_000 }).realisedCents).toBe(-825)
    expect(recoverHeld({ receivedCents: 55_000, relievedCents: 54_175 }).realisedCents).toBe(825)
  })

  /**
   * The same two numbers, opposite signs — which is the point of there being
   * two functions rather than one with a flag somebody forgets to set.
   */
  it('gives opposite answers to the same pair, because they are opposite questions', () => {
    const settled = settleHeld({ releasedCents: 54_175, relievedCents: 55_000 })
    const recovered = recoverHeld({ receivedCents: 54_175, relievedCents: 55_000 })

    expect(settled.realisedCents).toBe(recovered.realisedCents)

    // Read the way each caller actually posts, they disagree — a euro that got
    // dearer is a loss on money you hold for somebody and a gain on money
    // somebody holds for you.
    const held = settleHeld({ releasedCents: 54_175, relievedCents: 55_000 })
    const owed = recoverHeld({ receivedCents: 55_000, relievedCents: 54_175 })
    expect(held.realisedCents).toBeLessThan(0)
    expect(owed.realisedCents).toBeGreaterThan(0)
  })
})

describe('recovering a balance owed to the business', () => {
  it('debits the bank with what actually arrived', () => {
    const receivedCents = convert(50_000, RETURNED)

    expect(recoverHeld({ receivedCents, relievedCents: convert(50_000, RAISED) }).receivedCents).toBe(
      receivedCents,
    )
  })

  it('credits the payable with what it has been carried at', () => {
    const relievedCents = convert(50_000, RAISED)

    expect(recoverHeld({ receivedCents: convert(50_000, RETURNED), relievedCents }).relievedCents).toBe(
      relievedCents,
    )
  })

  /**
   * €500 raised at 1.0835 is a $541.75 debit in payables. The supplier returns
   * it when the euro is worth 1.10, so $550.00 arrives — $8.25 more than the
   * books were carrying, and that is a gain.
   */
  it('realises the movement as a gain when the currency owed got dearer', () => {
    const recovery = recoverHeld({
      receivedCents: convert(50_000, RETURNED),
      relievedCents: convert(50_000, RAISED),
    })

    expect(recovery.realisedCents).toBe(825)
    expect(recovery.receivedCents).toBe(recovery.relievedCents + recovery.realisedCents)
  })

  it('realises a loss when it got cheaper', () => {
    const recovery = recoverHeld({
      receivedCents: convert(50_000, RAISED),
      relievedCents: convert(50_000, RETURNED),
    })

    expect(recovery.realisedCents).toBeLessThan(0)
  })

  it('realises nothing at home, where both sides are the same money', () => {
    expect(recoverHeld({ receivedCents: 50_000, relievedCents: 50_000 }).realisedCents).toBe(0)
  })

  /** The entry balances by construction, not by a rounding argument. */
  it('always balances: the debit equals the two credits', () => {
    for (const amount of [1, 7, 99, 1_234, 50_000, 999_999]) {
      const recovery = recoverHeld({
        receivedCents: convert(amount, RETURNED),
        relievedCents: convert(amount, RAISED),
      })

      expect(recovery.receivedCents).toBe(recovery.relievedCents + recovery.realisedCents)
    }
  })
})

describe('recovering it a piece at a time', () => {
  /**
   * Phase 66's lesson, which a database check caught: the sum of three
   * conversions is not the conversion of the sum. `relieveFunctional`'s rule
   * that the last relief takes the whole remainder is what stops a credit
   * reaching zero on one column and not the other.
   */
  it('empties both columns together across three recoveries', () => {
    let balanceCents = 50_000
    let functionalBalanceCents = convert(50_000, RAISED)

    for (const piece of [20_000, 20_000, 10_000]) {
      const relief = relieveFunctional(
        { balanceCents, exchangeRateMillionths: RAISED, functionalBalanceCents },
        piece,
      )

      const recovery = recoverHeld({
        receivedCents: convert(piece, RETURNED),
        relievedCents: relief.functionalCents,
      })
      expect(recovery.receivedCents).toBe(recovery.relievedCents + recovery.realisedCents)

      balanceCents -= piece
      functionalBalanceCents = relief.functionalBalanceCents
    }

    expect(balanceCents).toBe(0)
    expect(functionalBalanceCents).toBe(0)
  })
})
