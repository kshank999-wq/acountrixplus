import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { CURRENCY_CARRIERS } from '@/modules/fx/carriers'
import {
  INHERITED_CURRENCY,
  denominatedProperties,
  inheritedFor,
} from '@/modules/fx/inherited'

/**
 * Money on a row that has no currency of its own (Phase 131).
 *
 * Phase 128 asked the schema which tables carry a currency. This asks the
 * second half of the question — which tables hold money belonging to one — and
 * asks it the same way, because the answer drifts every time somebody adds a
 * table and the only source that cannot be out of date is the database.
 *
 * The rule is a **mandatory** foreign key to a carrier. A nullable one is a
 * link: a time entry exists long before anybody bills it, and its rate is the
 * company's own money whether or not it is ever put on an invoice. A parent
 * that must be there is a parent the row has no meaning without.
 */

/** Tables holding money that cannot exist without a row carrying a currency. */
async function inheritorsInSchema() {
  const rows = await db.execute<{ child: string; col: string; parent: string }>(sql`
    WITH carriers AS (
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'currency'
         AND table_name <> 'companies'
    ), money AS (
      SELECT DISTINCT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%\\_cents'
    ), fks AS (
      SELECT tc.table_name AS child, ccu.table_name AS parent, kcu.column_name AS col
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    )
    SELECT f.child, f.col, f.parent
      FROM fks f
      JOIN money m ON m.table_name = f.child
      JOIN carriers c ON c.table_name = f.parent
      JOIN information_schema.columns k
        ON k.table_name = f.child AND k.column_name = f.col AND k.table_schema = 'public'
     WHERE f.child NOT IN (SELECT table_name FROM carriers)
       AND k.is_nullable = 'NO'
     ORDER BY f.child, f.parent
  `)

  return [...rows]
}

describe('what inherits a currency', () => {
  it('names every table the schema says must have a carrier for a parent', async () => {
    const inSchema = [...new Set((await inheritorsInSchema()).map((row) => row.child))].sort()
    const declared = INHERITED_CURRENCY.map((row) => row.table).sort()

    expect(declared).toEqual(inSchema)
  })

  it('names every mandatory parent of each, and no others', async () => {
    const rows = await inheritorsInSchema()
    const inSchema = rows.map((row) => `${row.child}.${row.col} -> ${row.parent}`).sort()
    const declared = INHERITED_CURRENCY.flatMap((row) =>
      row.parents.map((parent) => `${row.table}.${parent.column} -> ${parent.table}`),
    ).sort()

    // Both directions. A declared parent that is nullable is a link somebody
    // mistook for a denomination, and it would put a screen in reach on a
    // relationship that does not hold.
    expect(declared).toEqual(inSchema)
  })

  it('classifies every money column the table actually has', async () => {
    for (const row of INHERITED_CURRENCY) {
      const columns = await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${row.table}
           AND column_name LIKE '%\\_cents'
         ORDER BY column_name
      `)

      // The split is what this registry is for. A column added later that
      // nobody classified would otherwise sit in whichever currency the reader
      // assumed, which is the whole defect one table over.
      expect([...row.faceColumns, ...row.booksColumns].sort(), row.table).toEqual(
        [...columns].map((column) => column.column_name).sort(),
      )
    }
  })

  it('names a real carrier for every face column, and none without', () => {
    const carriers = new Set(CURRENCY_CARRIERS.map((carrier) => carrier.table))

    for (const row of INHERITED_CURRENCY) {
      expect(row.faceOf.length > 0, row.table).toBe(row.faceColumns.length > 0)
      for (const parent of row.faceOf) {
        expect(carriers.has(parent), `${row.table} takes ${parent}`).toBe(true)
        expect(
          row.parents.some((declared) => declared.table === parent),
          `${row.table} takes ${parent}, which is not one of its parents`,
        ).toBe(true)
      }
    }
  })

  it('argues each split from what writes the row', () => {
    for (const row of INHERITED_CURRENCY) {
      expect(row.because.length, row.table).toBeGreaterThan(140)
    }
  })

  it('makes a table with two parents say how they are kept from disagreeing', () => {
    // `retainer_applications` and `payout_items` are the two, and they are
    // different answers: one is held equal by a refusal in this codebase, the
    // other by the payment processor. Both have to say which.
    for (const row of INHERITED_CURRENCY.filter((entry) => entry.faceOf.length > 1)) {
      expect(row.because, row.table).toMatch(/refus|declines/i)
    }
  })

  it('refuses a table nobody declared', () => {
    expect(() => inheritedFor('journal_lines')).toThrow(/No currency inheritance is declared/)
  })

  it('gives the drizzle property for every one, so a source scan can match', () => {
    for (const row of INHERITED_CURRENCY) {
      const expected = row.table.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
      expect(row.property, row.table).toBe(expected)
    }
  })

  it('counts what a screen scan may now reach', () => {
    // Measured, not bounded (Phase 126's lesson). Thirteen carriers from
    // Phase 128 plus the eleven inheritors whose money is a parent's — the two
    // that answer "the books'" are deliberately not here, because a page
    // reaching `invoice_costings` learns nothing about foreign money.
    expect(denominatedProperties().length).toBe(24)
    expect(new Set(denominatedProperties()).size).toBe(24)
  })
})
