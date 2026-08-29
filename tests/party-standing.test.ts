import { describe, expect, it } from 'vitest'
import { partyStanding } from '@/modules/parties/standing'

/**
 * Where a party actually stands (Phase 56).
 *
 * The claim under test: **the customers screen's number is the net, in the home
 * currency, with its age attached** — and the banding follows the net, so a
 * customer whose money the business is holding is not painted as a debtor.
 *
 * The netting itself is asserted in `net-position.test.ts`. This module
 * composes that function rather than answering the same question twice, so what
 * is tested here is the age, the band and the sentence.
 */

const base = {
  owedCents: 90_000,
  heldCents: 0,
  oldestDueDate: '2026-01-31',
  asOf: '2026-06-01',
}

describe('how late it is', () => {
  it('counts whole days past the oldest due date', () => {
    expect(partyStanding(base).daysOverdue).toBe(121)
  })

  /**
   * Not negative. "Due in 12 days" is a different fact from "12 days overdue",
   * and a negative overdue count is a number nobody reads correctly.
   */
  it('is null when nothing has fallen due yet', () => {
    const standing = partyStanding({ ...base, oldestDueDate: '2026-07-01' })

    expect(standing.daysOverdue).toBeNull()
    expect(standing.band).toBe('current')
  })

  it('is null on the due date itself', () => {
    expect(partyStanding({ ...base, oldestDueDate: '2026-06-01' }).daysOverdue).toBeNull()
  })

  it('is null when nothing is owed at all', () => {
    const standing = partyStanding({ ...base, owedCents: 0, oldestDueDate: null })

    expect(standing.daysOverdue).toBeNull()
    expect(standing.band).toBe('settled')
  })

  it('survives a date it cannot read rather than reporting nonsense', () => {
    expect(partyStanding({ ...base, oldestDueDate: 'not-a-date' }).daysOverdue).toBeNull()
  })
})

describe('the band', () => {
  it('is overdue inside ninety days', () => {
    expect(partyStanding({ ...base, oldestDueDate: '2026-05-01' }).band).toBe('overdue')
  })

  it('becomes long overdue past ninety days, which is a different conversation', () => {
    expect(partyStanding({ ...base, oldestDueDate: '2026-01-01' }).band).toBe('long_overdue')
  })

  /**
   * The substance of the phase's banding decision. A customer with a $900
   * invoice 200 days old and $900 of *their own money* sitting in 2520 is not
   * somebody to chase — they are somebody whose credit needs applying. Painting
   * that row red sends a person to have the wrong conversation.
   */
  it('is settled when the credit covers the debt, however old the debt is', () => {
    const standing = partyStanding({
      ...base,
      heldCents: 90_000,
      oldestDueDate: '2025-01-01',
    })

    expect(standing.band).toBe('settled')
    expect(standing.position.dueCents).toBe(0)
  })

  it('stays overdue when the credit only dents it', () => {
    const standing = partyStanding({ ...base, heldCents: 60_000, oldestDueDate: '2026-05-01' })

    expect(standing.band).toBe('overdue')
    expect(standing.position.dueCents).toBe(30_000)
  })
})

describe('what the screen says', () => {
  it('names the amount and the age', () => {
    expect(partyStanding(base).note).toBe('They owe $900.00, oldest 121 days overdue.')
  })

  it('names the credit when there is one', () => {
    const note = partyStanding({ ...base, heldCents: 60_000 }).note

    expect(note).toContain('$300.00')
    expect(note).toContain('$600.00 held')
  })

  it('leaves the age off when nothing is late', () => {
    const note = partyStanding({ ...base, oldestDueDate: '2026-07-01' }).note

    expect(note).toBe('They owe $900.00.')
  })

  it('says nothing is owed when nothing is', () => {
    expect(partyStanding({ ...base, owedCents: 0, oldestDueDate: null }).note).toBe(
      'Nothing owed.',
    )
  })

  it('says the credit covered it when it exactly did', () => {
    const note = partyStanding({ ...base, heldCents: 90_000 }).note

    expect(note).toContain('Nothing due')
    expect(note).toContain('$900.00 held covers it')
  })

  /** The case somebody needs to act on: the business owes the customer. */
  it('says out loud when we are holding more than they owe', () => {
    const standing = partyStanding({ ...base, heldCents: 150_000 })

    expect(standing.position.stance).toBe('we_owe')
    expect(standing.note).toContain('holding $1,500.00 for them')
    expect(standing.note).toContain('$600.00 more than they owe')
  })

  it('speaks the home currency it is given', () => {
    expect(partyStanding({ ...base, currency: 'EUR' }).note).toContain('€900.00')
  })
})

describe('the supplier side', () => {
  it('reads as money we owe, not money owed to us', () => {
    const note = partyStanding({ ...base, side: 'vendor' }).note

    expect(note).toContain('We owe $900.00')
    expect(note).toContain('121 days overdue')
  })

  it('names an unspent vendor credit as theirs against nothing', () => {
    const note = partyStanding({
      ...base,
      side: 'vendor',
      owedCents: 0,
      heldCents: 40_000,
      oldestDueDate: null,
    }).note

    expect(note).toContain('$400.00 of our credit')
  })
})
