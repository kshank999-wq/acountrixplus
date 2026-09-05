import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  CURRENCY_CARRIERS,
  bankTransactionFunctional,
  carrierFor,
  carrierProperties,
} from '@/modules/fx/carriers'

/**
 * The registry is asked, and the database answers (Phase 128).
 *
 * Phase 127's scan narrowed by a list of currency-bearing tables typed out by
 * hand. It named nine; the schema has thirteen. The four it missed —
 * `financial_accounts`, `checkouts`, `payouts`, `refunds` — took twenty-two
 * posting sites out of reach of the check, including the bank feed, which is
 * where money first enters the books.
 *
 * A list a person maintains drifts the moment somebody adds a column. This is
 * the shape `paired-money` has used since Phase 116 for its constraints, for
 * the same reason: the only trustworthy source for what the schema contains is
 * the schema.
 */

describe('what carries a currency', () => {
  it('names every table the schema says has one, and no others', async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'currency'
         -- The functional currency itself, which is what the others are
         -- measured against rather than another face amount.
         AND table_name <> 'companies'
       ORDER BY table_name
    `)

    const inSchema = [...rows].map((row) => row.table_name).sort()
    const declared = CURRENCY_CARRIERS.map((row) => row.table).sort()

    expect(declared).toEqual(inSchema)
  })

  it('argues each one from whose currency it is', () => {
    for (const row of CURRENCY_CARRIERS) {
      expect(row.because.length, row.table).toBeGreaterThan(100)
    }
  })

  it('refuses a table nobody declared', () => {
    expect(() => carrierFor('journal_lines')).toThrow(/No currency carrier is declared/)
  })

  it('gives the drizzle property for every one, so a source scan can match', () => {
    // snake_case to camelCase, checked rather than assumed — the scan matches
    // on the property and the schema check above matches on the table, and a
    // mismatch between them would make the scan silently narrower again.
    for (const row of CURRENCY_CARRIERS) {
      const expected = row.table.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
      expect(row.property, row.table).toBe(expected)
    }
    expect(carrierProperties()).toHaveLength(CURRENCY_CARRIERS.length)
  })
})

describe('what a bank transaction puts into the ledger', () => {
  it('is the same number on a domestic account, which is why nobody noticed', () => {
    expect(bankTransactionFunctional(50_000, 1_000_000)).toBe(50_000)
  })

  it('converts at the rate on the day the money moved', () => {
    // €500 at 1.10 — the defect in one assertion: this posted 50000 before
    // Phase 128, on every categorised transaction of every foreign account.
    expect(bankTransactionFunctional(50_000, 1_100_000)).toBe(55_000)
  })

  it('refuses rather than guessing when no rate covers that day', () => {
    // Phase 117's rule. Posting at some rate nobody chose would be the same
    // defect wearing a hat, and the transaction staying in the feed is
    // something a person can see and act on.
    expect(bankTransactionFunctional(50_000, null)).toBeNull()
  })

  it('rounds to the cent rather than truncating', () => {
    expect(bankTransactionFunctional(3_333, 1_100_000)).toBe(3_666)
  })
})
