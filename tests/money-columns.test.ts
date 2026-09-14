import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  BLIND_FACE_SUMS,
  FACE_COLUMNS,
  MONEY_COLUMNS,
  SAFE_FACE_SUMS,
  blindFaceSumFor,
} from '@/modules/fx/comparable'
import { CURRENCY_CARRIERS } from '@/modules/fx/carriers'
import { INHERITED_CURRENCY } from '@/modules/fx/inherited'
import { PAIRED_COLUMNS } from '@/modules/fx/paired'

/**
 * Every money column says which money it is (Phase 143).
 *
 * Phase 128 made `CURRENCY_CARRIERS` answerable to `information_schema` after a
 * hand-typed list of nine missed four tables and took twenty-two posting sites
 * out of reach. `FACE_COLUMNS` was the same shape and was never given the same
 * treatment: **seventeen columns typed by hand, against fifty-four the schema
 * has on those very tables.**
 *
 * The thirty-seven nobody classified were not excused by the sum scans. They
 * were invisible to them — which is a different and worse thing, because an
 * excused site has an argument somebody can disagree with and an unseen one has
 * nothing at all.
 */

/** Tables whose rows carry a currency, their own or an inherited one. */
const CARRIER_TABLES = [
  ...new Set([
    ...CURRENCY_CARRIERS.map((row) => row.table),
    ...INHERITED_CURRENCY.map((row) => row.table),
  ]),
].sort()

describe('what money a column holds', () => {
  it('classifies every money column the schema has, and no others', async () => {
    // The assertion the phase exists for, and the one that stops this list
    // drifting again: a new `*_cents` column on a currency-carrying table has
    // to say which money it is before the suite will go green.
    //
    // `functional_*` columns are excluded by name — they are the answer rather
    // than the question, and `PAIRED_COLUMNS` already holds them to their twins.
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name LIKE '%cents'
         AND column_name NOT LIKE 'functional%'
       ORDER BY table_name, column_name
    `)

    // Narrowed in JavaScript rather than in the query: the table list comes
    // from two registries, and binding it as an array parameter is the kind of
    // detail that fails quietly and leaves the assertion comparing two empty
    // lists — which would pass.
    const carriers = new Set(CARRIER_TABLES)
    const inSchema = [...rows]
      .filter((row) => carriers.has(row.table_name))
      .map((row) => `${row.table_name}.${row.column_name}`)
      .sort()

    expect(inSchema.length).toBeGreaterThan(50)
    const declared = MONEY_COLUMNS.map((row) => `${row.table}.${row.column}`).sort()

    expect(declared).toEqual(inSchema)
  })

  it('finds enough of them for that to mean something', () => {
    // Measured, not bounded (Phase 126). Fifty-four columns across the carrier
    // tables; the hand-typed list had seventeen.
    expect(MONEY_COLUMNS.length).toBe(54)
    expect(FACE_COLUMNS.length).toBe(44)
    expect(MONEY_COLUMNS.filter((row) => row.side === 'functional').length).toBe(5)
    expect(MONEY_COLUMNS.filter((row) => row.side === 'account').length).toBe(5)
  })

  it('argues each one from whose money it is', () => {
    for (const row of MONEY_COLUMNS) {
      expect(row.because.length, `${row.table}.${row.column}`).toBeGreaterThan(40)
    }
  })

  it('names a functional twin only where the schema has one', async () => {
    // Both directions. A twin that does not exist is a claim the scans would
    // act on, and a twin that exists and is not named leaves the face column
    // looking unpairable.
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE 'functional%cents'
    `)

    const real = new Set([...rows].map((row) => `${row.table_name}.${row.column_name}`))
    const claimed = MONEY_COLUMNS.filter((row) => row.functionalColumn !== null).map(
      (row) => `${row.table}.${row.functionalColumn}`,
    )

    expect(claimed.filter((key) => !real.has(key))).toEqual([])
  })

  it('agrees with PAIRED_COLUMNS about which face columns have twins', () => {
    // `PAIRED_COLUMNS` is Phase 116's, and it carries the database constraint
    // that keeps each pair honest. Two registries describing one fact have to
    // agree, or one of them is wrong and nothing says which.
    for (const pair of PAIRED_COLUMNS) {
      const declared = MONEY_COLUMNS.find(
        (row) => row.table === pair.table && row.column === pair.faceColumn,
      )

      expect(declared?.side, `${pair.table}.${pair.faceColumn}`).toBe('face')
      expect(declared?.functionalColumn, `${pair.table}.${pair.faceColumn}`).toBe(
        pair.functionalColumn,
      )
    }
  })

  it('keeps functional and account money out of the face list', () => {
    // What stops the completed list making the scans noisier rather than
    // wider. A refund's `carried_cents` is already the company's money and
    // adding it across refunds is sound; a bank balance is the account's own
    // currency and `cashTieOut` already argues that case.
    const faceKeys = FACE_COLUMNS.map((row) => `${row.table}.${row.column}`)

    expect(faceKeys).not.toContain('refunds.carried_cents')
    expect(faceKeys).not.toContain('retainer_applications.carried_cents')
    expect(faceKeys).not.toContain('financial_accounts.current_balance_cents')
    expect(faceKeys).not.toContain('reconciliations.cleared_balance_cents')
    expect(faceKeys).toContain('payment_applications.amount_cents')
  })
})

describe('the sums the completed list found', () => {
  it('names them, and says what is wrong with each', () => {
    // A check seen to disagree rather than only to agree (Phase 121). These
    // three were not excused by the tripwire — they summed columns it had
    // never been told about.
    expect(BLIND_FACE_SUMS.map((row) => row.symbol).sort()).toEqual([
      'cashBasisCaveats',
      'contractorPayments',
      'salesTaxReturn',
    ])

    for (const row of BLIND_FACE_SUMS) {
      expect(row.liveDefect.length, row.symbol).toBeGreaterThan(140)
      expect(row.liveDefect, row.symbol).toMatch(/\b(?:sums|compares|adds|report)\b/i)
    }
  })

  it('points each at an acceptance test that is skipped and labelled', () => {
    // Phase 139's rule: a red suite nobody can fix teaches people to ignore the
    // suite, so the definition of done is skipped rather than failing — and it
    // has to exist and say so, or the entry is a plan wearing the clothes of a
    // fact.
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')

    for (const row of BLIND_FACE_SUMS) {
      expect(existsSync(row.acceptance), row.acceptance).toBe(true)
      const src = readFileSync(row.acceptance, 'utf8')
      expect(src, row.acceptance).toContain('describe.skip(')
      expect(src, row.acceptance).toContain('acceptance test for the repair')
      expect(src, row.acceptance).toContain(row.symbol)
    }
  })

  it('indicts rather than excuses, which is the whole difference', () => {
    // ADR 0134's rule, and why these are not `SAFE_FACE_SUMS` entries. A site
    // cannot be in both: one says "this is provably one currency" and the other
    // says "this adds two and here is the proof".
    for (const row of BLIND_FACE_SUMS) {
      expect(
        SAFE_FACE_SUMS.some((safe) => safe.file === row.file && safe.symbol === row.symbol),
        row.symbol,
      ).toBe(false)
    }

    expect(blindFaceSumFor('src/modules/payroll/sales-tax.ts', 'salesTaxReturn')).not.toBeNull()
    expect(blindFaceSumFor('src/modules/nowhere/x.ts', 'y')).toBeNull()
  })
})
