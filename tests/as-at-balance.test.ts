import { describe, expect, it } from 'vitest'
import {
  SETTLEMENT_PATHS,
  balanceAsAt,
  describeRestoration,
  pathFor,
  wasOpenAt,
  type Settlement,
} from '@/modules/ledger/as-at'

/**
 * What a document owed on a date that is not today (Phase 108).
 *
 * Every report comparing the ledger against the documents walks the ledger back
 * to `asOf` and then reads the document balance as it stands now.
 * `receivables-check.ts` said so since Phase 31, with a reason:
 *
 * > reconstructing historical document balances means replaying every payment
 * > application, which is a bigger machine than this check justifies.
 *
 * The reason is false. All four paths that reduce a balance write a dated row,
 * so it is four sums rather than a replay — and believing it cost three
 * different answers to "what was owed on 31 March", none of them right, with
 * the control-account check reporting a $45,758.75 fault on healthy books.
 */

const settled = (over: Partial<Settlement> = {}): Settlement => ({
  kind: 'payment',
  on: '2026-06-28',
  cents: 30_000,
  functionalCents: 30_000,
  ...over,
})

const now = { balanceCents: 70_000, functionalBalanceCents: 70_000 }

describe('the paths that reduce a balance', () => {
  it('names all four, each with the column that dates it', () => {
    expect(SETTLEMENT_PATHS.map((path) => path.kind)).toEqual([
      'payment',
      'credit_note',
      'write_off',
      'retainer',
    ])
    for (const path of SETTLEMENT_PATHS) {
      expect(path.dateColumn.length, path.kind).toBeGreaterThan(0)
      expect(path.table.length, path.kind).toBeGreaterThan(0)
    }
  })

  it('records that a payment is dated on the payment, not the application', () => {
    // The detail that made this look unreconstructible: payment_applications
    // carries no date column of its own.
    expect(pathFor('payment').dateColumn).toBe('payments.payment_date')
    expect(pathFor('payment').because).toContain('carries no date of its own')
  })

  it('makes every path argue for itself', () => {
    for (const path of SETTLEMENT_PATHS) {
      expect(path.because.length, path.kind).toBeGreaterThan(60)
    }
  })

  it('refuses a kind nobody declared', () => {
    // A silent zero here would put history quietly wrong, which is the whole
    // failure this phase is about.
    expect(() => pathFor('recovery' as never)).toThrow(/declares how a recovery/)
  })

  it('declares each kind once', () => {
    const kinds = SETTLEMENT_PATHS.map((path) => path.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })
})

describe('putting a settlement back', () => {
  it('restores what was paid after the date asked about', () => {
    const balance = balanceAsAt(now, [settled()], '2026-03-31')

    expect(balance.balanceCents).toBe(100_000)
    expect(balance.functionalBalanceCents).toBe(100_000)
  })

  it('leaves a settlement that happened before it alone', () => {
    const balance = balanceAsAt(now, [settled({ on: '2026-03-01' })], '2026-03-31')

    expect(balance.balanceCents).toBe(70_000)
    expect(balance.undone).toEqual([])
  })

  it('treats a settlement on the date itself as already happened', () => {
    // A payment dated 31 March is money received on 31 March, so a report as at
    // 31 March shows the invoice already reduced by it.
    const balance = balanceAsAt(now, [settled({ on: '2026-03-31' })], '2026-03-31')

    expect(balance.balanceCents).toBe(70_000)
  })

  it('puts back every kind, not just payments', () => {
    const balance = balanceAsAt(
      now,
      [
        settled({ kind: 'payment', cents: 10_000, functionalCents: 10_000 }),
        settled({ kind: 'credit_note', cents: 5_000, functionalCents: 5_000 }),
        settled({ kind: 'write_off', cents: 3_000, functionalCents: 3_000 }),
        settled({ kind: 'retainer', cents: 2_000, functionalCents: 2_000 }),
      ],
      '2026-03-31',
    )

    expect(balance.balanceCents).toBe(90_000)
    expect(balance.undone).toHaveLength(4)
  })

  it('adds up several settlements of one kind', () => {
    const balance = balanceAsAt(
      now,
      [settled({ cents: 10_000, functionalCents: 10_000 }), settled({ on: '2026-07-06' })],
      '2026-03-31',
    )

    expect(balance.undone).toEqual([
      { kind: 'payment', cents: 40_000, functionalCents: 40_000 },
    ])
  })

  it('restores the two currencies independently', () => {
    // A euro invoice settled at one rate: the face value and what it was worth
    // are different numbers, and both have to come back (Phases 65, 107).
    const balance = balanceAsAt(
      { balanceCents: 0, functionalBalanceCents: 0 },
      [settled({ cents: 250_000, functionalCents: 270_875 })],
      '2026-03-31',
    )

    expect(balance.balanceCents).toBe(250_000)
    expect(balance.functionalBalanceCents).toBe(270_875)
  })

  it('is a no-op for a document nothing has settled', () => {
    const balance = balanceAsAt(now, [], '2026-03-31')

    expect(balance.balanceCents).toBe(70_000)
    expect(balance.undone).toEqual([])
  })

  it('orders what it put back largest first', () => {
    const balance = balanceAsAt(
      now,
      [
        settled({ kind: 'credit_note', cents: 5_000, functionalCents: 5_000 }),
        settled({ kind: 'payment', cents: 40_000, functionalCents: 40_000 }),
      ],
      '2026-03-31',
    )

    expect(balance.undone.map((entry) => entry.kind)).toEqual(['payment', 'credit_note'])
  })
})

describe('whether it was open then', () => {
  const open = { balanceCents: 100_000, functionalBalanceCents: 100_000, undone: [] }
  const closed = { balanceCents: 0, functionalBalanceCents: 0, undone: [] }

  it('counts a document issued by then and still owing', () => {
    expect(wasOpenAt({ issueDate: '2026-03-01' }, open, '2026-03-31')).toBe(true)
  })

  it('excludes one issued after the date', () => {
    expect(wasOpenAt({ issueDate: '2026-04-01' }, open, '2026-03-31')).toBe(false)
  })

  it('excludes one already settled by then', () => {
    // The condition that was missing: a restored balance of nil means it was
    // paid before the date, not that it never existed.
    expect(wasOpenAt({ issueDate: '2026-03-01' }, closed, '2026-03-31')).toBe(false)
  })

  it('counts one issued on the date itself', () => {
    expect(wasOpenAt({ issueDate: '2026-03-31' }, open, '2026-03-31')).toBe(true)
  })
})

describe('the sentence a person reads', () => {
  it('says what came off since, in the company’s own money', () => {
    const balance = balanceAsAt(
      now,
      [
        settled({ kind: 'payment', cents: 40_000, functionalCents: 40_000 }),
        settled({ kind: 'write_off', cents: 5_000, functionalCents: 5_000 }),
      ],
      '2026-03-31',
    )

    expect(describeRestoration(balance)).toBe('Since then: $400.00 paid, $50.00 written off')
  })

  it('names the currency it was given', () => {
    const balance = balanceAsAt(now, [settled()], '2026-03-31')
    expect(describeRestoration(balance, 'EUR')).toContain('€')
  })

  it('stays quiet when nothing was put back', () => {
    // A report asked about today is exactly as quiet as it was before this phase.
    expect(describeRestoration(balanceAsAt(now, [], '2026-09-03'))).toBeUndefined()
  })
})
