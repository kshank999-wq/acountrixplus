import { describe, expect, it } from 'vitest'
import {
  balancesByCurrency,
  describeBalances,
  foreignBalanceNote,
  homeCurrencyOwed,
  soleCurrency,
  type CurrencyLine,
} from '@/modules/receivables/statement-currency'

/**
 * The statement that told the customer a made-up number (Phase 61).
 *
 * `openInvoices` selected the document balance and `buildStatement` added those
 * together, so a customer invoiced €4,000 and $1,200 was told they owed
 * **$5,200.00** — a figure in no currency at all. The same file asserted in a
 * comment that every figure on the statement was already the home-currency one.
 *
 * It is the worst place in the system for that: Phase 42 links the customer to
 * it, Phase 55 emails it, and Phase 57 sends it monthly with nobody looking.
 */

const line = (over: Partial<CurrencyLine> = {}): CurrencyLine => {
  const balanceCents = over.balanceCents ?? 120_000
  return {
    currency: 'USD',
    balanceCents,
    // Domestic by default, so the two agree and keep agreeing.
    functionalBalanceCents: balanceCents,
    ...over,
  }
}

/** €4,000, worth $4,320 at 1.08. */
const euro = (over: Partial<CurrencyLine> = {}): CurrencyLine =>
  line({ currency: 'EUR', balanceCents: 400_000, functionalBalanceCents: 432_000, ...over })

describe('splitting a statement by currency', () => {
  it('leaves an ordinary single-currency customer as one balance', () => {
    const balances = balancesByCurrency([line({ balanceCents: 50_000 }), line({ balanceCents: 70_000 })])

    expect(balances).toHaveLength(1)
    expect(balances[0].currency).toBe('USD')
    expect(balances[0].balanceCents).toBe(120_000)
  })

  it('keeps each currency’s money apart', () => {
    const balances = balancesByCurrency([euro(), line({ balanceCents: 120_000 })])

    expect(balances.map((row) => row.currency)).toEqual(['EUR', 'USD'])
    expect(balances[0].balanceCents).toBe(400_000)
    expect(balances[1].balanceCents).toBe(120_000)
  })

  /** Largest exposure first, judged in the money the business actually keeps. */
  it('leads with what the business is most exposed in', () => {
    // €400 is $432, which is more than $400 — so euro leads despite the
    // smaller-looking face value ordering the other way.
    const balances = balancesByCurrency([
      line({ balanceCents: 40_000 }),
      euro({ balanceCents: 40_000, functionalBalanceCents: 43_200 }),
    ])

    expect(balances.map((row) => row.currency)).toEqual(['EUR', 'USD'])
  })

  /** A document that reorders itself between renders is one nobody trusts. */
  it('breaks a tie by currency code, so the order never moves', () => {
    const balances = balancesByCurrency([
      line({ currency: 'USD', balanceCents: 10_000, functionalBalanceCents: 10_000 }),
      line({ currency: 'GBP', balanceCents: 8_000, functionalBalanceCents: 10_000 }),
    ])

    expect(balances.map((row) => row.currency)).toEqual(['GBP', 'USD'])
  })

  it('has nothing to split when there are no lines', () => {
    expect(balancesByCurrency([])).toEqual([])
  })
})

describe('whether a single total exists', () => {
  it('names the currency when every line agrees', () => {
    expect(soleCurrency([line(), line({ balanceCents: 5_000 })])).toBe('USD')
  })

  /** Null means "no single total", not "something went wrong". */
  it('is null when they do not', () => {
    expect(soleCurrency([line(), euro()])).toBeNull()
  })

  it('is null for an empty statement', () => {
    expect(soleCurrency([])).toBeNull()
  })
})

describe('what held credit may be set against', () => {
  /**
   * Held credit is `payments.unapplied_cents`, and nothing on the payment
   * records which currency the receipt was in — so the only currency it can
   * safely be read as is the company's own.
   */
  it('nets only against the home-currency balance', () => {
    const balances = balancesByCurrency([euro(), line({ balanceCents: 120_000 })])

    expect(homeCurrencyOwed(balances, 'USD')).toBe(120_000)
  })

  /** Netting a dollar credit against a euro invoice is the same substitution. */
  it('is nothing when the customer owes only in another currency', () => {
    const balances = balancesByCurrency([euro()])

    expect(homeCurrencyOwed(balances, 'USD')).toBe(0)
  })

  it('is the whole balance for an ordinary customer', () => {
    const balances = balancesByCurrency([line({ balanceCents: 120_000 })])

    expect(homeCurrencyOwed(balances, 'USD')).toBe(120_000)
  })
})

describe('saying what is outstanding', () => {
  it('says it plainly for one currency', () => {
    const balances = balancesByCurrency([line({ balanceCents: 120_000 })])

    expect(describeBalances(balances)).toBe('$1,200.00 is outstanding.')
  })

  it('refuses to invent a total for two', () => {
    const balances = balancesByCurrency([euro(), line({ balanceCents: 120_000 })])
    const sentence = describeBalances(balances)

    expect(sentence).toContain('€4,000.00')
    expect(sentence).toContain('$1,200.00')
    expect(sentence).toContain('there is no single total')
    // The number the old code printed, which was neither amount.
    expect(sentence).not.toContain('$5,200.00')
  })

  it('has something to say about nothing', () => {
    expect(describeBalances([])).toBe('Nothing is outstanding.')
  })
})

describe('the note beneath Phase 54’s sentence', () => {
  /**
   * Phase 54 stopped a statement asking for money the business was holding.
   * Its sentence covers the home-currency balance alone, so staying silent
   * would leave a customer reading "nothing is due" over a euro invoice
   * listed right above it.
   */
  it('says the foreign balance is still outstanding', () => {
    const balances = balancesByCurrency([euro(), line({ balanceCents: 120_000 })])
    const note = foreignBalanceNote(balances, 'USD')!

    expect(note).toContain('€4,000.00')
    expect(note).toContain('outstanding separately')
    expect(note).toContain('has not been set against it')
  })

  it('says nothing for an ordinary customer', () => {
    const balances = balancesByCurrency([line({ balanceCents: 120_000 })])

    expect(foreignBalanceNote(balances, 'USD')).toBeNull()
  })

  it('lists more than one foreign currency', () => {
    const balances = balancesByCurrency([
      euro(),
      line({ currency: 'GBP', balanceCents: 90_000, functionalBalanceCents: 114_000 }),
      line({ balanceCents: 10_000 }),
    ])
    const note = foreignBalanceNote(balances, 'USD')!

    expect(note).toContain('€4,000.00')
    expect(note).toContain('£900.00')
    expect(note).toContain('those currencies')
  })
})
