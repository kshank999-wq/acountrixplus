import { describe, expect, it } from 'vitest'
import {
  addressLines,
  contactLines,
  letterheadFor,
  letterheadText,
  type LetterheadProfile,
} from '@/modules/brand/letterhead'
import { OUR_NAME } from '@/modules/brand/voice'

/**
 * Who a company is on a document it sends (Phase 75).
 *
 * Pure. No database, no clock.
 */

const FULL: LetterheadProfile = {
  legalName: 'Ridgeline Construction LLC',
  addressLine1: '412 Cedar Way',
  addressLine2: 'Suite 300',
  city: 'Seattle',
  region: 'WA',
  postalCode: '98104',
  country: 'United States',
  phone: '(206) 555-0142',
  email: 'accounts@ridgeline.test',
  website: 'ridgeline.test',
  documentFooter: 'WA contractor licence RIDGEC*781QK',
}

describe('the letterhead of a company that filled everything in', () => {
  const head = letterheadFor({ companyName: 'Ridgeline Construction', profile: FULL })

  it('is headed by the registered name', () => {
    expect(head.name).toBe('Ridgeline Construction LLC')
  })

  it('does not print the same name twice', () => {
    // `companies.name` is "Ridgeline Construction" and the registered name is
    // "Ridgeline Construction LLC" — different strings, so both are kept.
    expect(head.tradingName).toBe('Ridgeline Construction')
  })

  it('lays the address out the way an envelope is', () => {
    expect(head.address).toEqual([
      '412 Cedar Way',
      'Suite 300',
      'Seattle, WA 98104',
      'United States',
    ])
  })

  it('keeps the three channels apart, and joins them in that order', () => {
    expect(head.phone).toBe('(206) 555-0142')
    expect(head.email).toBe('accounts@ridgeline.test')
    expect(head.website).toBe('ridgeline.test')

    // A PDF prints all three; the customer-facing page wants the email as a
    // `mailto:` on its own. One representation, two views of it.
    expect(contactLines(head)).toEqual([
      '(206) 555-0142',
      'accounts@ridgeline.test',
      'ridgeline.test',
    ])
  })

  it('carries what they chose to say at the foot', () => {
    expect(head.footer).toBe('WA contractor licence RIDGEC*781QK')
  })
})

/**
 * The rule: **a blank box is an unanswered question, not an answer.** The
 * Design Center saves `''` for a cleared field (ADR 0074), and `''` does not
 * trip `??`.
 */
describe('a blank box is not an answer', () => {
  it('falls back to the company when the legal name was cleared', () => {
    const head = letterheadFor({
      companyName: 'Ridgeline Construction',
      profile: { ...FULL, legalName: '' },
    })

    expect(head.name).toBe('Ridgeline Construction')
    expect(head.tradingName).toBeNull()
  })

  it('drops a blank line rather than printing an empty one', () => {
    const head = letterheadFor({
      companyName: 'Ridgeline Construction',
      profile: { ...FULL, addressLine2: '   ', phone: '', website: null },
    })

    expect(head.address).toEqual(['412 Cedar Way', 'Seattle, WA 98104', 'United States'])
    expect(contactLines(head)).toEqual(['accounts@ridgeline.test'])
  })

  /** "Seattle, " with a missing region is worse than "Seattle". */
  it('does not leave a separator hanging off a half-filled city line', () => {
    expect(addressLines({ city: 'Seattle', postalCode: '98104' })).toEqual(['Seattle 98104'])
    expect(addressLines({ region: 'WA' })).toEqual(['WA'])
    expect(addressLines({ city: 'Seattle', region: '' })).toEqual(['Seattle'])
  })

  it('reduces to the name alone for a company that has filled in nothing', () => {
    const head = letterheadFor({ companyName: 'Ridgeline Construction', profile: null })

    expect(head).toEqual({
      name: 'Ridgeline Construction',
      tradingName: null,
      address: [],
      phone: null,
      email: null,
      website: null,
      footer: null,
    })
    expect(letterheadText(head)).toBe('Ridgeline Construction')
  })

  /** Inherited from Phase 74: theirs is never signed with ours. */
  it('never heads a company’s document with our name', () => {
    for (const profile of [null, {}, { legalName: '' }, { legalName: '  ' }]) {
      expect(letterheadFor({ companyName: 'Ridgeline Construction', profile }).name).not.toBe(
        OUR_NAME,
      )
    }
  })
})

describe('a trading name that differs from the registered one', () => {
  /**
   * `companies.name` is what they call themselves day to day; `legalName` is
   * what is on the registration. When they differ, an invoice needs both — the
   * customer knows one and the payment has to reach the other.
   */
  it('keeps both, headed by the registered name', () => {
    const head = letterheadFor({
      companyName: 'Ridgeline',
      profile: { legalName: 'Ridgeline Construction LLC' },
    })

    expect(head.name).toBe('Ridgeline Construction LLC')
    expect(head.tradingName).toBe('Ridgeline')
    expect(letterheadText(head)).toBe('Ridgeline Construction LLC\ntrading as Ridgeline')
  })

  it('says it once when they are the same', () => {
    const head = letterheadFor({
      companyName: 'Ridgeline Construction LLC',
      profile: { legalName: 'Ridgeline Construction LLC' },
    })

    expect(head.tradingName).toBeNull()
    expect(letterheadText(head)).toBe('Ridgeline Construction LLC')
  })

  it('prints one block, blanks and all, in reading order', () => {
    expect(letterheadText(letterheadFor({ companyName: 'Ridgeline Construction', profile: FULL })))
      .toBe(
        [
          'Ridgeline Construction LLC',
          'trading as Ridgeline Construction',
          '412 Cedar Way',
          'Suite 300',
          'Seattle, WA 98104',
          'United States',
          '(206) 555-0142',
          'accounts@ridgeline.test',
          'ridgeline.test',
        ].join('\n'),
      )
  })
})
