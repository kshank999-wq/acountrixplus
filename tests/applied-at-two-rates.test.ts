import { describe, expect, it } from 'vitest'
import { meets } from '@/modules/fx/applied'

/**
 * When two carried balances meet (Phase 137).
 *
 * No database, no clock. Applying a credit note reduces two balances carried at
 * two different rates for one face amount, and until this phase it reduced both
 * and posted nothing — leaving the difference in the control account with no
 * document behind it.
 *
 * The figures here are the ones the probe measured: a €1,000 invoice raised at
 * 1.10 and a €1,000 credit note issued at 1.0835.
 */

const INVOICE = 110_000
const NOTE = 108_350

describe('a credit note carried at a different rate from the invoice', () => {
  it('names the difference the ledger would otherwise keep', () => {
    const verdict = meets({ relievedCents: INVOICE, releasedCents: NOTE, control: 'receivable' })

    expect(verdict.posts).toBe(true)
    if (!verdict.posts) return

    // $16.50 — measured against the database before this phase, where it stayed
    // in Accounts Receivable and failed `ledger.receivables` every night.
    expect(verdict.differenceCents).toBe(1_650)
    expect(verdict.outcome).toBe('loss')
  })

  it('credits the receivable, because that is what is overstated', () => {
    const verdict = meets({ relievedCents: INVOICE, releasedCents: NOTE, control: 'receivable' })

    if (!verdict.posts) throw new Error('expected an entry')

    // The invoice put 110000 into Accounts Receivable and the note took 108350
    // out. The customer owes nothing, so the 1650 left has to come out, and the
    // exchange account is what it comes out against.
    expect(verdict.control).toBe('credit')
    expect(verdict.exchange).toBe('debit')
  })

  it('calls the same movement a gain on something we owe', () => {
    // The direction that is not symmetric, and the reason `control` is a
    // parameter rather than an assumption. We were billed when the euro was
    // strong and credited when it was weak: on money owed *to* us that is a
    // loss, and on money *we* owe it is a gain, because the debt got cheaper
    // before we settled it.
    const verdict = meets({ relievedCents: INVOICE, releasedCents: NOTE, control: 'payable' })

    if (!verdict.posts) throw new Error('expected an entry')

    expect(verdict.differenceCents).toBe(1_650)
    expect(verdict.outcome).toBe('gain')
    expect(verdict.control).toBe('debit')
    expect(verdict.exchange).toBe('credit')
  })

  it('turns round when the credit is worth more than the document', () => {
    // A credit note issued when the euro was *stronger* than when the invoice
    // went out. Nothing here assumes which way rates moved.
    const verdict = meets({ relievedCents: NOTE, releasedCents: INVOICE, control: 'receivable' })

    if (!verdict.posts) throw new Error('expected an entry')

    expect(verdict.differenceCents).toBe(1_650)
    expect(verdict.outcome).toBe('gain')
    expect(verdict.control).toBe('debit')
  })

  it('mirrors that on a payable too', () => {
    const verdict = meets({ relievedCents: NOTE, releasedCents: INVOICE, control: 'payable' })

    if (!verdict.posts) throw new Error('expected an entry')
    expect(verdict.outcome).toBe('loss')
    expect(verdict.control).toBe('credit')
  })
})

describe('when the two are carried at the same rate', () => {
  it('posts nothing, which is every domestic application', () => {
    const verdict = meets({
      relievedCents: 100_000,
      releasedCents: 100_000,
      control: 'receivable',
    })

    expect(verdict.posts).toBe(false)
    if (verdict.posts) return

    // Why a hundred and thirty phases never saw this: with one currency the two
    // carried rates are both 1.0 and the difference is always zero.
    expect(verdict.why).toContain('nothing to name')
  })

  it('says so for a payable as well', () => {
    expect(meets({ relievedCents: 5_000, releasedCents: 5_000, control: 'payable' }).posts).toBe(
      false,
    )
  })
})

describe('what the sentence has to carry', () => {
  it('names both figures and what the difference is', () => {
    const verdict = meets({ relievedCents: INVOICE, releasedCents: NOTE, control: 'receivable' })

    if (!verdict.posts) throw new Error('expected an entry')

    // Phase 119's standard: a sentence written for a reader has to say enough
    // that somebody can check it without reading the code.
    expect(verdict.why).toContain('110000')
    expect(verdict.why).toContain('108350')
    expect(verdict.why).toContain('1650')
    expect(verdict.why).toContain('realised exchange loss')
    expect(verdict.why).toContain('no document behind it')
  })

  it('calls the document a bill when it is one', () => {
    const verdict = meets({ relievedCents: INVOICE, releasedCents: NOTE, control: 'payable' })

    if (!verdict.posts) throw new Error('expected an entry')
    expect(verdict.why).toContain('bill')
    expect(verdict.why).not.toContain('invoice came down')
  })
})

describe('the arithmetic that must not drift', () => {
  it('never reports a negative difference, because the side says the direction', () => {
    for (const [relieved, released] of [
      [110_000, 108_350],
      [108_350, 110_000],
      [1, 999_999],
      [999_999, 1],
    ]) {
      for (const control of ['receivable', 'payable'] as const) {
        const verdict = meets({ relievedCents: relieved, releasedCents: released, control })
        if (!verdict.posts) throw new Error('expected an entry')
        expect(verdict.differenceCents).toBeGreaterThan(0)
        // The two sides are always opposite, or the entry would not balance.
        expect(verdict.control).not.toBe(verdict.exchange)
      }
    }
  })

  it('is exactly the gap between what each document gave up', () => {
    // The property that makes the control account agree again: the entry is the
    // difference, never a fresh conversion of the face amount at some third
    // rate. Phase 116's rule — read the pair that moved, do not recompute it.
    for (const [relieved, released] of [
      [110_000, 108_350],
      [4_321, 8_765],
      [1_000_000, 999_999],
    ]) {
      const verdict = meets({
        relievedCents: relieved,
        releasedCents: released,
        control: 'receivable',
      })
      if (!verdict.posts) throw new Error('expected an entry')
      expect(verdict.differenceCents).toBe(Math.abs(relieved - released))
    }
  })
})
