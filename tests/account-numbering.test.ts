import { describe, expect, it } from 'vitest'
import { bandFor, ledgerNameFor, nextAccountNumber } from '@/modules/banking/numbering'

/**
 * Where a new bank account's ledger account goes (Phase 40).
 *
 * The pure half. No database — a kind and a set of numbers already in use go
 * in, and a number a report can sort sensibly comes out.
 */

describe('bandFor', () => {
  it('puts a second current account beside the first, not at the end of the chart', () => {
    // The reason bands are bounded at all: every report sorts by number, so an
    // account numbered 1150 sits among the receivables for ever.
    const band = bandFor('checking')
    expect(band.from).toBe(1000)
    expect(band.to).toBeLessThan(1010)
  })

  it('makes a card a liability and an account an asset', () => {
    expect(bandFor('checking').type).toBe('asset')
    expect(bandFor('savings').type).toBe('asset')
    expect(bandFor('cash').type).toBe('asset')
    expect(bandFor('credit_card').type).toBe('liability')
    expect(bandFor('loan').type).toBe('liability')
  })

  /**
   * Guessing that an unclassified account is a debt overstates what is owed,
   * and an overstated debt is the error nobody queries.
   */
  it('treats something the aggregator could not classify as an asset', () => {
    expect(bandFor('other').type).toBe('asset')
  })

  it('gives every kind a band that does not overlap another', () => {
    const kinds = ['checking', 'savings', 'cash', 'other', 'credit_card', 'loan'] as const
    const bands = kinds.map(bandFor).sort((a, b) => a.from - b.from)

    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i].from).toBeGreaterThan(bands[i - 1].to)
    }
  })

  it('leaves the standard chart’s own numbers as the first of their band', () => {
    // 1000 Checking, 1010 Savings, 1050 Petty Cash, 2100 Credit Card, 2400
    // Loans Payable all exist already, and a company's first account of each
    // kind should land on the one the chart already has a name for.
    expect(bandFor('checking').from).toBe(1000)
    expect(bandFor('savings').from).toBe(1010)
    expect(bandFor('cash').from).toBe(1050)
    expect(bandFor('credit_card').from).toBe(2100)
    expect(bandFor('loan').from).toBe(2400)
  })
})

describe('nextAccountNumber', () => {
  it('takes the first of the band when nothing is in the way', () => {
    expect(nextAccountNumber([], bandFor('checking'))).toBe('1000')
    expect(nextAccountNumber([], bandFor('credit_card'))).toBe('2100')
  })

  it('steps past what a company already has', () => {
    expect(nextAccountNumber(['1000'], bandFor('checking'))).toBe('1001')
    expect(nextAccountNumber(['1000', '1001', '1002'], bandFor('checking'))).toBe('1003')
  })

  it('fills a gap rather than always taking the highest', () => {
    // An account somebody deleted leaves a hole, and there is no reason to
    // walk past it towards the end of the band.
    expect(nextAccountNumber(['1000', '1002'], bandFor('checking'))).toBe('1001')
  })

  it('ignores numbers outside the band', () => {
    expect(nextAccountNumber(['2100', '5000', '1100'], bandFor('checking'))).toBe('1000')
  })

  /**
   * A number is unique per company across the whole chart, so a collision
   * anywhere is a collision — the caller passes every number, not the band's.
   */
  it('refuses a number the chart already uses for something else entirely', () => {
    expect(nextAccountNumber(['1000'], bandFor('checking'))).not.toBe('1000')
  })

  it('says the band is full rather than spilling into the next one', () => {
    const band = bandFor('checking')
    const full = Array.from({ length: band.to - band.from + 1 }, (_, i) => String(band.from + i))
    expect(nextAccountNumber(full, band)).toBeNull()
  })

  it('is not fooled by whitespace around a stored number', () => {
    expect(nextAccountNumber([' 1000 '], bandFor('checking'))).toBe('1001')
  })
})

describe('ledgerNameFor', () => {
  /**
   * One name for one thing. A chart account called "Checking Account 2" beside
   * a bank account called "Deposit Account" is two names for one thing, and
   * somebody eventually reconciles the wrong one.
   */
  it('names the ledger account after the bank account', () => {
    expect(ledgerNameFor({ name: 'Deposit Account' })).toBe('Deposit Account')
  })

  it('carries the mask, which is the only thing telling two accounts apart', () => {
    expect(ledgerNameFor({ name: 'Business Checking', mask: '4471' })).toBe(
      'Business Checking ••4471',
    )
  })

  it('tidies the spacing somebody typed', () => {
    expect(ledgerNameFor({ name: '  Business   Checking ', mask: null })).toBe('Business Checking')
  })
})
