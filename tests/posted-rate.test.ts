import { describe, expect, it } from 'vitest'
import { bookedAtFace, rateForPosting, rateFromPosted } from '@/modules/fx/posted-rate'

/**
 * A rate is answered once (Phase 129).
 *
 * Phase 128 left `bank_transactions` as the only money reaching the ledger with
 * no rate beside it, and two callers deriving that rate independently —
 * `buildLines` to post and `cashTieOut` to check. `rateFor` walks backwards to
 * the most recent rate on or before a date, so entering a rate for a day that
 * did not have one changes what an older question resolves to. Measured on the
 * database: a €500 charge posted at 1.10 read $575 to the check afterwards, and
 * re-posted itself at $575 the next time anybody re-categorised it.
 */

describe('what rate a posting uses', () => {
  it('answers from the rate table the first time, because nothing has been decided yet', () => {
    expect(rateForPosting({ storedRateMillionths: null, currentRateMillionths: 1_100_000 })).toEqual(
      { rateMillionths: 1_100_000, because: 'first' },
    )
  })

  it('keeps what it posted at, even when the table now says something else', () => {
    // The defect in one assertion. Both numbers are real answers to different
    // questions: 1.15 is what the table says about that day *now*, 1.10 is what
    // this money actually went into the books at. A posting needs the second.
    expect(
      rateForPosting({ storedRateMillionths: 1_100_000, currentRateMillionths: 1_150_000 }),
    ).toEqual({ rateMillionths: 1_100_000, because: 'kept' })
  })

  it('is stable under repetition, which is what makes re-categorising safe', () => {
    const first = rateForPosting({ storedRateMillionths: null, currentRateMillionths: 1_100_000 })
    const second = rateForPosting({
      storedRateMillionths: first.rateMillionths,
      currentRateMillionths: 1_150_000,
    })
    const third = rateForPosting({
      storedRateMillionths: second.rateMillionths,
      currentRateMillionths: 1_900_000,
    })

    expect(third.rateMillionths).toBe(first.rateMillionths)
    expect(third.because).toBe('kept')
  })

  it('treats a nonsense stored rate as absent rather than honouring it', () => {
    // Only a corrupted write produces these, and posting at zero would drop a
    // real bank movement out of the books without saying so.
    for (const stored of [0, -1_100_000, Number.NaN]) {
      expect(rateForPosting({ storedRateMillionths: stored, currentRateMillionths: 1_100_000 })).toEqual(
        { rateMillionths: 1_100_000, because: 'first' },
      )
    }
  })

  it('keeps a rate below parity, which is a real rate and not a missing one', () => {
    expect(
      rateForPosting({ storedRateMillionths: 800_000, currentRateMillionths: 1_100_000 }),
    ).toEqual({ rateMillionths: 800_000, because: 'kept' })
  })
})

describe('the rate a posting already made implies', () => {
  it('divides what the ledger took by what the statement said', () => {
    expect(rateFromPosted(50_000, 55_000)).toBe(1_100_000)
  })

  it('cancels the sign, so an outflow and an inflow agree', () => {
    expect(rateFromPosted(-50_000, -55_000)).toBe(1_100_000)
  })

  it('reads a face-value posting as parity, which is how the damage shows up', () => {
    // Phase 128's defect, read off history: euros in a dollar ledger as though
    // they were dollars. The backfill records this rather than the rate the
    // table would give today, because the ledger is what actually happened.
    expect(rateFromPosted(-50_000, -50_000)).toBe(1_000_000)
  })

  it('has no rate for a zero movement rather than an infinite one', () => {
    expect(rateFromPosted(0, 0)).toBeNull()
  })

  it('rounds to the millionth', () => {
    expect(rateFromPosted(3_333, 3_666)).toBe(1_099_910)
  })
})

describe('whether a foreign transaction went in at its face value', () => {
  it('catches euros posted as dollars', () => {
    expect(
      bookedAtFace({ isForeign: true, amountCents: -50_000, functionalAmountCents: -50_000 }),
    ).toBe(true)
  })

  it('leaves a correctly converted one alone', () => {
    expect(
      bookedAtFace({ isForeign: true, amountCents: -50_000, functionalAmountCents: -55_000 }),
    ).toBe(false)
  })

  it('never accuses a domestic account, where the two are equal by definition', () => {
    expect(
      bookedAtFace({ isForeign: false, amountCents: -50_000, functionalAmountCents: -50_000 }),
    ).toBe(false)
  })

  it('says nothing about a transaction that never posted', () => {
    expect(
      bookedAtFace({ isForeign: true, amountCents: -50_000, functionalAmountCents: null }),
    ).toBe(false)
  })

  it('ignores a zero movement, where face and functional agree at nothing', () => {
    expect(bookedAtFace({ isForeign: true, amountCents: 0, functionalAmountCents: 0 })).toBe(false)
  })
})
