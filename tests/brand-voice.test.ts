import { describe, expect, it } from 'vitest'
import { BRAND } from '@/modules/brand/identity'
import { OUR_NAME, senderName } from '@/modules/brand/voice'

/**
 * Whose name goes on a letter (Phase 74).
 *
 * Pure. No database, no clock.
 */

describe('what the product signs its own letters with', () => {
  it('is the brand, not a literal somebody typed again', () => {
    expect(OUR_NAME).toBe(BRAND.full)
  })
})

describe('the name on a letter a company sends', () => {
  it('uses what they chose for this campaign', () => {
    expect(
      senderName({
        chosen: 'Ridgeline Site Team',
        legalName: 'Ridgeline Construction LLC',
        companyName: 'Ridgeline Construction',
      }),
    ).toBe('Ridgeline Site Team')
  })

  it('falls back to the legal name on their profile', () => {
    expect(
      senderName({
        chosen: null,
        legalName: 'Ridgeline Construction LLC',
        companyName: 'Ridgeline Construction',
      }),
    ).toBe('Ridgeline Construction LLC')
  })

  /**
   * The one that was missing. `companyProfiles` is optional and `legalName` is
   * nullable, so this is the state every company is in on the day it registers.
   */
  it('falls back to the company itself when there is no profile at all', () => {
    expect(senderName({ companyName: 'Ridgeline Construction' })).toBe('Ridgeline Construction')
  })

  /**
   * The whole point. Before this function, a company with no profile and no
   * chosen sender mailed its own customers from "Accountrix Plus", over its own
   * unsubscribe link.
   */
  it('can never sign a company’s letter with ours', () => {
    const inputs = [
      { chosen: null, legalName: null, companyName: 'Ridgeline Construction' },
      { chosen: '', legalName: '', companyName: 'Ridgeline Construction' },
      { chosen: undefined, legalName: undefined, companyName: 'Ridgeline Construction' },
      { chosen: '   ', legalName: null, companyName: 'Ridgeline Construction' },
    ]

    for (const input of inputs) {
      expect(senderName(input)).not.toBe(OUR_NAME)
      expect(senderName(input)).toBe('Ridgeline Construction')
    }
  })

  /**
   * A sender field somebody emptied is the same as one they never filled in.
   * `''` on the `From:` line is how a message arrives from nobody.
   */
  it('does not treat blank as a choice', () => {
    expect(
      senderName({ chosen: '  ', legalName: '  ', companyName: '  Ridgeline Construction  ' }),
    ).toBe('Ridgeline Construction')
  })

  it('trims what it is given', () => {
    expect(senderName({ chosen: '  Ridgeline Site Team ', companyName: 'Ridgeline' })).toBe(
      'Ridgeline Site Team',
    )
  })

  /**
   * `companies.name` is NOT NULL and exists from the moment a tenant registers,
   * so this cannot happen through the front door. Signing such a company's post
   * with ours would hide a broken tenant rather than fix it.
   */
  it('refuses rather than falling through to us when a company has no name', () => {
    expect(() => senderName({ companyName: '' })).toThrow(/must have a name/)
    expect(() => senderName({ chosen: null, companyName: '   ' })).toThrow(/must have a name/)
  })
})
