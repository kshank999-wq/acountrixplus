import { describe, expect, it } from 'vitest'
import {
  PAIRED_COLUMNS,
  PairedColumnsError,
  movingConstraints,
  pairsFor,
} from '@/modules/fx/paired'
import { convert } from '@/modules/fx/rates'

/**
 * The paired-money core (Phase 116). No database, no clock.
 *
 * Its job is to hold the distinction the system had been getting wrong, and the
 * arithmetic below is why it matters: no functional figure in this system is a
 * conversion of its face amount, so nothing may recompute one.
 */

/** The ECB rate this repository's own seed data carries: €1 = $1.0835. */
const RATE = 1_083_500

describe('why nothing may be recomputed', () => {
  it('a sum of conversions is not the conversion of a sum', () => {
    // A two-line euro invoice, €10.01 each. The header stores the lines
    // converted and added, because that is what the journal entry posted.
    // Converting the €20.02 total instead gives a different cent.
    const lines = convert(1_001, RATE) + convert(1_001, RATE)
    const total = convert(2_002, RATE)

    expect(lines).toBe(2_170)
    expect(total).toBe(2_169)
    expect(lines).not.toBe(total)
  })

  it('drifts further the more movements a document has had', () => {
    // €1,000 at 1.0835 posts $1,083.50. Three instalments of €250 each relieve
    // convert(25000) = $270.88, leaving $270.86 carried against a €250 balance
    // that recomputes to $270.88.
    //
    // Two cents, from five roundings. `fx.conversions` called more than one a
    // fault, so it fired on a euro invoice paid in quarterly instalments.
    let functional = convert(100_000, RATE)
    for (let i = 0; i < 3; i++) functional -= convert(25_000, RATE)

    expect(functional).toBe(27_086)
    expect(convert(25_000, RATE)).toBe(27_088)
    expect(Math.abs(functional - convert(25_000, RATE))).toBeGreaterThan(1)
  })

  it('reaches zero exactly, which is the one thing that can be asserted', () => {
    // The last relief takes the whole remaining functional balance rather than
    // a computed one, so the accumulated rounding is absorbed there instead of
    // being stranded for ever.
    let balance = 100_000
    let functional = convert(100_000, RATE)

    for (const part of [25_000, 25_000, 25_000, 25_000]) {
      const after = balance - part
      functional -= after === 0 ? functional : convert(part, RATE)
      balance = after
    }

    expect(balance).toBe(0)
    expect(functional).toBe(0)
  })
})

describe('the registry', () => {
  it('names a pair for every table that carries one', () => {
    const tables = [...new Set(PAIRED_COLUMNS.map((pair) => pair.table))].sort()
    expect(tables).toEqual(['bills', 'credit_notes', 'invoices', 'payments', 'retainers'])
  })

  it('gives every entry a reason in the terms of its own table', () => {
    // The registry-with-prose device: an entry that cannot say why it is the
    // kind it is has not been thought about, and the next person cannot tell a
    // decision from a default.
    for (const pair of PAIRED_COLUMNS) {
      expect(pair.because.length, `${pair.table}.${pair.functionalColumn}`).toBeGreaterThan(80)
    }
  })

  it('gives every moving pair a constraint and every fixed pair none', () => {
    // A moving pair has a zero to reach and the database guards it. A fixed
    // pair has none — it is written once and never moves — so there is nothing
    // for a constraint to say about it.
    for (const pair of PAIRED_COLUMNS) {
      if (pair.kind === 'moving') expect(pair.constraint, pair.table).toBeTruthy()
      else expect(pair.constraint, pair.table).toBeNull()
    }
  })

  it('refuses a table nobody has declared', () => {
    // Rather than answering "no pairs", which is also what a table somebody
    // forgot looks like.
    expect(() => pairsFor('journal_lines')).toThrow(PairedColumnsError)
    expect(() => pairsFor('journal_lines')).toThrow(/do not ask/)
  })

  it('answers for a table that carries both kinds', () => {
    expect(
      pairsFor('invoices')
        .map((pair) => pair.kind)
        .sort(),
    ).toEqual(['fixed', 'moving'])
  })

  it('answers for a table that carries only a moving pair', () => {
    // `payments` has no converted total to be fixed, and says why.
    const pairs = pairsFor('payments')
    expect(pairs).toHaveLength(1)
    expect(pairs[0].kind).toBe('moving')
  })

  it('lists the constraints the moving pairs rely on', () => {
    expect(
      movingConstraints()
        .map((row) => row.constraint)
        .sort(),
    ).toEqual([
      'bills_functional_balance_sane',
      'credit_notes_functional_remaining_sane',
      'invoices_functional_balance_sane',
      'payments_functional_unapplied_sane',
      'retainers_functional_remaining_sane',
    ])
  })
})
