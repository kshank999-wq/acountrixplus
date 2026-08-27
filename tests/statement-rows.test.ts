import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  fingerprintRows,
  normalizeDescription,
  signedAmountCents,
  type StatementRow,
} from '@/modules/importing/statement-rows'

/**
 * Giving a statement row an identity it does not have (Phase 39).
 *
 * The pure half. No database, no clock — a row goes in, a signed amount and a
 * stable identity come out, and the same file twice produces the same answers.
 */

const row = (postedDate: string, amountCents: number, description: string): StatementRow => ({
  postedDate,
  amountCents,
  description,
})

describe('signedAmountCents', () => {
  it('takes a single signed column as written', () => {
    expect(signedAmountCents({ amount: -450 })).toEqual({ ok: true, cents: -450 })
    expect(signedAmountCents({ amount: 120_000 })).toEqual({ ok: true, cents: 120_000 })
  })

  /**
   * The sign convention that inverts a profit and loss when it is wrong.
   *
   * A statement is written from the bank's side, where your balance is their
   * liability — so their "debit" is money leaving you.
   */
  it('reads the bank’s debit as money leaving the account', () => {
    expect(signedAmountCents({ debit: 450 })).toEqual({ ok: true, cents: -450 })
    expect(signedAmountCents({ credit: 450 })).toEqual({ ok: true, cents: 450 })
  })

  it('uses the magnitude in a labelled column, so a negative is not negated twice', () => {
    // Some banks write "-4.50" in a column already headed Withdrawal. Taking
    // the sign as well would turn a spend into income.
    expect(signedAmountCents({ debit: -450 })).toEqual({ ok: true, cents: -450 })
    expect(signedAmountCents({ credit: -450 })).toEqual({ ok: true, cents: 450 })
  })

  it('ignores an empty column beside a filled one', () => {
    expect(signedAmountCents({ debit: 450, credit: 0 })).toEqual({ ok: true, cents: -450 })
    expect(signedAmountCents({ debit: null, credit: 900 })).toEqual({ ok: true, cents: 900 })
  })

  it('refuses a row with figures in both columns rather than netting them', () => {
    // Netting would post a transaction that appears nowhere on the statement.
    expect(signedAmountCents({ debit: 450, credit: 900 })).toEqual({ ok: false, reason: 'both' })
  })

  it('refuses a row that says nothing', () => {
    expect(signedAmountCents({})).toEqual({ ok: false, reason: 'empty' })
    expect(signedAmountCents({ amount: 0 })).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('normalizeDescription', () => {
  it('ignores spacing and case, which a bank may re-export differently', () => {
    expect(normalizeDescription('  COFFEE   HOUSE  ')).toBe('coffee house')
    expect(normalizeDescription('Coffee House')).toBe('coffee house')
  })

  it('keeps digits and punctuation, because two cheques are two transactions', () => {
    expect(normalizeDescription('CHQ 001234')).not.toBe(normalizeDescription('CHQ 001235'))
  })
})

describe('fingerprintRows', () => {
  const account = 'acct-1'

  /**
   * The case that makes the ordinal necessary, and the reason a plain content
   * hash is a money-losing bug: two identical coffees on one day are two
   * transactions, and hashing content alone silently keeps one.
   */
  it('keeps two identical charges on one day apart', () => {
    const rows = [row('2026-03-14', -450, 'COFFEE HOUSE'), row('2026-03-14', -450, 'COFFEE HOUSE')]
    const out = fingerprintRows(account, rows)

    expect(out[0].ordinal).toBe(1)
    expect(out[1].ordinal).toBe(2)
    expect(out[0].fingerprint).not.toBe(out[1].fingerprint)
  })

  it('gives the same file the same identities twice, so a re-import adds nothing', () => {
    const rows = [
      row('2026-03-14', -450, 'COFFEE HOUSE'),
      row('2026-03-14', -450, 'COFFEE HOUSE'),
      row('2026-03-15', 250_000, 'CLIENT PAYMENT'),
    ]

    const first = fingerprintRows(account, rows).map((r) => r.fingerprint)
    const second = fingerprintRows(account, rows).map((r) => r.fingerprint)
    expect(second).toEqual(first)
  })

  it('re-identifies the overlapping days of a later export', () => {
    // The common real case: export January to March, then February to April.
    // February's rows must come back with the identities they already have.
    const january = [row('2026-01-31', -1_200, 'RENT')]
    const february = [row('2026-02-14', -450, 'COFFEE HOUSE'), row('2026-02-28', -1_200, 'RENT')]
    const march = [row('2026-03-31', -1_200, 'RENT')]

    const firstExport = fingerprintRows(account, [...january, ...february])
    const secondExport = fingerprintRows(account, [...february, ...march])

    const overlap = firstExport.slice(1).map((r) => r.fingerprint)
    expect(secondExport.slice(0, 2).map((r) => r.fingerprint)).toEqual(overlap)
  })

  it('separates the same row in different accounts', () => {
    const one = fingerprintRows('acct-1', [row('2026-03-14', -450, 'COFFEE')])
    const two = fingerprintRows('acct-2', [row('2026-03-14', -450, 'COFFEE')])
    expect(one[0].fingerprint).not.toBe(two[0].fingerprint)
  })

  it('separates rows that differ only in amount, date or description', () => {
    const base = row('2026-03-14', -450, 'COFFEE')
    const prints = new Set(
      [
        base,
        row('2026-03-15', -450, 'COFFEE'),
        row('2026-03-14', -451, 'COFFEE'),
        row('2026-03-14', -450, 'TEA'),
      ].map((r) => fingerprintRows('acct-1', [r])[0].fingerprint),
    )
    expect(prints.size).toBe(4)
  })

  it('is marked as coming from a file, and cannot collide with a provider id', () => {
    const [only] = fingerprintRows(account, [row('2026-03-14', -450, 'COFFEE')])
    expect(only.fingerprint.startsWith('csv:')).toBe(true)
    expect(only.fingerprint).toHaveLength(4 + 32)
  })

  /**
   * Length-prefixing the canonical form. Without it, a description ending in
   * the field separator could be arranged to look like the next field and
   * forge a collision with a different row.
   */
  it('cannot be made to collide by moving the separator', () => {
    const a = fingerprint({ financialAccountId: 'a|b', row: row('2026-03-14', -450, 'X'), ordinal: 1 })
    const b = fingerprint({ financialAccountId: 'a', row: row('2026-03-14', -450, 'b|X'), ordinal: 1 })
    expect(a).not.toBe(b)
  })
})
