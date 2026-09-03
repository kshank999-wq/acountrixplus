import { describe, expect, it } from 'vitest'
import {
  BUCKETS,
  agingBucket,
  buildAging,
  creditNote,
  foreignNote,
  type AgeableDocument,
  type Buckets,
} from '@/modules/ledger/aging'

/**
 * The report that put a dollar sign on a euro (Phase 107).
 *
 * `arAging` aged `invoices.balance_cents` — the amount the customer was
 * invoiced — and rendered it through `formatCents` with no currency. Phase 61
 * found the same thing in the statement and said so about this report too:
 *
 * > A customer invoiced €4,000 and $1,200 was told they owed $5,200.00: a
 * > number in no currency at all, with a dollar sign on it. **The aging buckets
 * > added the same way.**
 *
 * It fixed the statement and left the report. Measured on the development
 * books: Bremen Hafenbau GmbH owes €2,500.00, worth $2,708.75, and their row
 * read $2,500.00.
 *
 * The claim this file is about: aging takes the *functional* figure because it
 * is an internal report spanning every customer — the opposite of Phase 61's
 * answer for statements, from the same argument.
 */

const doc = (over: Partial<AgeableDocument> = {}): AgeableDocument => ({
  partyId: 'c1',
  partyName: 'Harborview LLC',
  dueDate: '2026-03-31',
  currency: 'USD',
  balanceCents: 100_000,
  functionalBalanceCents: 100_000,
  ...over,
})

const bremen = (over: Partial<AgeableDocument> = {}): AgeableDocument =>
  doc({
    partyId: 'c2',
    partyName: 'Bremen Hafenbau GmbH',
    currency: 'EUR',
    balanceCents: 250_000,
    functionalBalanceCents: 270_875,
    ...over,
  })

const build = (documents: AgeableDocument[], over: Record<string, unknown> = {}) =>
  buildAging(documents, { asOfDate: '2026-04-15', currency: 'USD', ...over })

describe('which figure ages', () => {
  it('ages what the invoice is worth, not what it says', () => {
    // The defect in one assertion: 270875, not 250000.
    const report = build([bremen()])

    expect(report.totals.totalCents).toBe(270_875)
    expect(report.rows[0].totalCents).toBe(270_875)
  })

  it('makes a mixed-currency total a number in one currency', () => {
    const report = build([doc(), bremen()])

    // $1,000.00 + $2,708.75. The old sum was 100000 + 250000 = 350000, a
    // figure in no currency at all.
    expect(report.totals.totalCents).toBe(370_875)
    expect(report.currency).toBe('USD')
  })

  it('names the currency every figure is in', () => {
    expect(build([doc()], { currency: 'GBP' }).currency).toBe('GBP')
  })

  it('skips a document worth nothing in the company’s own money', () => {
    // Tested on the functional figure, because that is the one being aged.
    const report = build([doc({ balanceCents: 1, functionalBalanceCents: 0 })])
    expect(report.rows).toEqual([])
  })
})

describe('what a foreign row says it was invoiced', () => {
  it('carries the currency the customer actually owes in', () => {
    const report = build([bremen()])

    expect(report.rows[0].foreign).toEqual([{ currency: 'EUR', balanceCents: 250_000 }])
    expect(foreignNote(report.rows[0])).toBe('Invoiced €2,500.00')
  })

  it('says nothing for a customer billed in the company’s own currency', () => {
    // The overwhelming majority of rows, where nothing about the report changes.
    const report = build([doc()])

    expect(report.rows[0].foreign).toEqual([])
    expect(foreignNote(report.rows[0])).toBeUndefined()
  })

  it('keeps two foreign currencies apart, in a fixed order', () => {
    const report = build([
      bremen({ currency: 'GBP', balanceCents: 40_000, functionalBalanceCents: 50_000 }),
      bremen(),
    ])

    expect(foreignNote(report.rows[0])).toBe('Invoiced €2,500.00 and £400.00')
  })

  it('adds up a customer’s documents within each currency', () => {
    const report = build([bremen(), bremen({ balanceCents: 100_000, functionalBalanceCents: 108_350 })])

    expect(report.rows[0].foreign).toEqual([{ currency: 'EUR', balanceCents: 350_000 }])
    expect(report.rows[0].totalCents).toBe(379_225)
  })

  it('leaves the home-currency part of a mixed customer out of the note', () => {
    // They owe $1,000 and €2,500. Quoting "Invoiced $1,000.00 and €2,500.00"
    // beside a $3,708.75 total would be three numbers and no explanation.
    const report = build([
      bremen(),
      bremen({ currency: 'USD', balanceCents: 100_000, functionalBalanceCents: 100_000 }),
    ])

    expect(report.rows[0].totalCents).toBe(370_875)
    expect(foreignNote(report.rows[0])).toBe('Invoiced €2,500.00')
  })
})

describe('the buckets', () => {
  it('puts a document in the bucket its due date earns', () => {
    expect(agingBucket('2026-04-20', '2026-04-15')).toBe('current')
    expect(agingBucket('2026-04-15', '2026-04-15')).toBe('current')
    expect(agingBucket('2026-04-14', '2026-04-15')).toBe('d1_30')
    expect(agingBucket('2026-03-16', '2026-04-15')).toBe('d1_30')
    expect(agingBucket('2026-03-15', '2026-04-15')).toBe('d31_60')
    expect(agingBucket('2026-01-14', '2026-04-15')).toBe('d90_plus')
  })

  it('ages the functional figure into the bucket, not the face value', () => {
    const report = build([bremen({ dueDate: '2026-01-01' })])

    expect(report.totals.d90_plus).toBe(270_875)
    expect(report.totals.current).toBe(0)
  })

  it('declares its columns in order, with labels', () => {
    expect(BUCKETS.map((bucket) => bucket.key)).toEqual([
      'current',
      'd1_30',
      'd31_60',
      'd61_90',
      'd90_plus',
    ])
    for (const bucket of BUCKETS) expect(bucket.label.length).toBeGreaterThan(0)
  })

  it('sums the buckets to the total, per row and overall', () => {
    const report = build([doc(), bremen({ dueDate: '2026-01-01' })])
    const sum = (b: Buckets) => b.current + b.d1_30 + b.d31_60 + b.d61_90 + b.d90_plus

    expect(sum(report.totals)).toBe(report.totals.totalCents)
    for (const row of report.rows) expect(sum(row)).toBe(row.totalCents)
  })

  it('orders parties by name so the report does not reshuffle', () => {
    const report = build([doc({ partyId: 'z', partyName: 'Zenith' }), doc({ partyId: 'a', partyName: 'Apex' })])
    expect(report.rows.map((row) => row.partyName)).toEqual(['Apex', 'Zenith'])
  })
})

describe('the credits that have no age', () => {
  it('leaves them out of every bucket', () => {
    // Phase 54's rule: an unapplied credit has no age, because nobody has
    // decided which invoice it belongs to.
    const report = build([doc()], { credits: { count: 1, functionalCents: 60_000 } })

    expect(report.totals.totalCents).toBe(100_000)
    expect(report.totals.current + report.totals.d1_30).toBe(100_000)
  })

  it('states what the control account should read instead', () => {
    // The gap ADR 0106 left open: a credit note reduces 1100 when it is issued,
    // so the aging total and the balance sheet differ by exactly the unapplied
    // credits — and nothing on either report said so.
    const report = build([doc()], { credits: { count: 1, functionalCents: 60_000 } })

    expect(report.controlAccountCents).toBe(40_000)
  })

  it('ties exactly when there are none', () => {
    const report = build([doc(), bremen()])
    expect(report.controlAccountCents).toBe(report.totals.totalCents)
  })

  it('explains the difference in a sentence that agrees with itself throughout', () => {
    // Six things agree on the count here: the noun, three verbs, a pronoun and
    // "each". Browser verification of the first draft read "1 credit note …
    // They already reduce … which invoice each belongs to" — Phase 105's
    // "1 retainer hold" in a longer sentence. So all of them are asserted.
    const one = creditNote(build([doc()], { credits: { count: 1, functionalCents: 60_000 } }))!

    expect(one).toContain('1 credit note worth')
    expect(one).toContain('has been issued')
    expect(one).toContain('It already reduces')
    expect(one).toContain('it is not aged here')
    expect(one).toContain('which invoice it belongs to')
    expect(one).toContain('$400.00')
    expect(one).not.toContain('credit notes')
    expect(one).not.toContain('They')
    expect(one).not.toContain('each')

    const many = creditNote(build([doc()], { credits: { count: 3, functionalCents: 60_000 } }))!

    expect(many).toContain('3 credit notes worth')
    expect(many).toContain('have been issued')
    expect(many).toContain('They already reduce')
    expect(many).toContain('they are not aged here')
    expect(many).toContain('which invoice each belongs to')
  })

  it('says nothing when there is nothing to explain', () => {
    expect(creditNote(build([doc()]))).toBeUndefined()
  })

  it('states the reconciliation in the report’s own currency', () => {
    const report = build([doc()], {
      currency: 'GBP',
      credits: { count: 1, functionalCents: 60_000 },
    })
    expect(creditNote(report)).toContain('£')
  })
})
