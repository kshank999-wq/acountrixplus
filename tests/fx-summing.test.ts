import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { convert, RATE_ONE } from '@/modules/fx/rates'
import {
  RATE_PROPERTY,
  convertedSumStands,
  faceSumStands,
  functionalSum,
} from '@/modules/fx/summing'

/**
 * Adding documents that are not in one currency (Phase 152).
 *
 * `summing.ts` states one piece of arithmetic in two languages — Postgres, for
 * the aggregates that happen in the query, and TypeScript, for the rows that
 * come back before they are added. Two statements of one question is the defect
 * this project keeps naming, so the two are held to each other here rather than
 * assumed to agree.
 */

/** What Postgres makes of the expression `functionalSumSql` builds, for one row. */
async function inPostgres(amountCents: number, rateMillionths: number): Promise<number> {
  const result = await db.execute(
    sql`select coalesce(sum(round((${amountCents}::numeric * coalesce(${rateMillionths}, ${RATE_ONE})::numeric) / ${RATE_ONE}::numeric)), 0) as total`,
  )
  // The driver hands back an array here and a `{ rows }` envelope elsewhere in
  // this suite, so both shapes are read rather than one being assumed.
  const rows = (
    Array.isArray(result)
      ? (result as unknown as { total: string }[])
      : ((result as unknown as { rows?: { total: string }[] }).rows ?? [])
  ) as { total: string }[]
  return Number(rows[0].total)
}

describe('the same arithmetic in two languages', () => {
  const amounts = [0, 1, 7, 99, 100, 4_999, 60_000, 123_457, 999_999_99]
  const rates = [RATE_ONE, 1_100_000, 1_089_432, 917_311, 3_642_007, 12_345]

  it('agrees on every amount and rate, cent for cent', async () => {
    const disagreements: string[] = []

    for (const amountCents of amounts) {
      for (const rateMillionths of rates) {
        const postgres = await inPostgres(amountCents, rateMillionths)
        const typescript = functionalSum([{ amountCents, rateMillionths }])
        if (postgres !== typescript) {
          disagreements.push(`${amountCents} @ ${rateMillionths}: sql ${postgres} ts ${typescript}`)
        }
      }
    }

    expect(disagreements).toEqual([])
    // A check only ever seen to agree is not a check (Phase 121) — so the
    // comparison has to be over enough cases that a rounding rule written the
    // other way would show. Half away from zero and half to even differ on a
    // .5, and `123457 @ 1089432` is one.
    expect(amounts.length * rates.length).toBeGreaterThan(50)
  })

  it('agrees on a negative amount, which is where the rounding rules part', async () => {
    // `convert` rounds half away from zero and says so; Postgres `round(numeric)`
    // does too. On a negative half, away-from-zero and toward-zero give
    // different cents, so this is the case that says which one is running.
    expect(await inPostgres(-2_505, 1_000_000)).toBe(-2_505)
    expect(await inPostgres(-5, 1_100_000)).toBe(convert(-5, 1_100_000))
    expect(functionalSum([{ amountCents: -5, rateMillionths: 1_100_000 }])).toBe(-6)
  })

  it('treats a missing rate as the identity, not as nothing', async () => {
    // A left join to payments leaves the rate null for a vendor paid nothing,
    // and that row has to add its own amount rather than vanish or zero.
    expect(functionalSum([{ amountCents: 80_000, rateMillionths: null }])).toBe(80_000)
    expect(
      functionalSum([
        { amountCents: 80_000, rateMillionths: null },
        { amountCents: 60_000, rateMillionths: 1_100_000 },
      ]),
    ).toBe(146_000)
  })

  it('adds nothing for no rows', () => {
    expect(functionalSum([])).toBe(0)
  })
})

describe('what a sum of face amounts is worth saying at all', () => {
  it('lets a converted figure be reported', () => {
    const verdict = faceSumStands({ purpose: 'reported', converts: true, counts: false })
    expect(verdict).toEqual({ sound: true, how: 'converted' })
  })

  it('refuses an unconverted figure that somebody files', () => {
    const verdict = faceSumStands({ purpose: 'reported', converts: false, counts: false })
    expect(verdict.sound).toBe(false)
    expect(verdict.sound === false && verdict.why).toMatch(/somebody files it/)
  })

  it('wants a count where only presence is tested, not a correct number', () => {
    // `cashBasisCaveats`, and the answer its own sibling query had already
    // reached nine phases earlier: converting a number with no reader makes a
    // correct number nobody wants.
    expect(faceSumStands({ purpose: 'presence', converts: false, counts: true })).toEqual({
      sound: true,
      how: 'counted',
    })

    const stillMoney = faceSumStands({ purpose: 'presence', converts: true, counts: false })
    expect(stillMoney.sound).toBe(false)
    expect(stillMoney.sound === false && stillMoney.why).toMatch(/Count the rows instead/)
  })

  it('does not let a conversion answer the presence question', () => {
    // The distinction the type exists for. A presence test with a correctly
    // converted sum is still the wrong shape: it asks for money to answer a
    // yes-or-no, and it is refused for that rather than for its arithmetic.
    const verdict = faceSumStands({ purpose: 'presence', converts: true, counts: false })
    expect(verdict.sound).toBe(false)
  })
})

describe('whether a converted sum is converting anything', () => {
  const scope = new Set(['invoices', 'documentTaxLines', 'payments'])

  it('accepts a rate from a table the query joins', () => {
    expect(
      convertedSumStands(
        { amount: 'payment_applications.amount_cents', rate: `payments.${RATE_PROPERTY}` },
        scope,
      ),
    ).toEqual({ sound: true, how: 'converted' })
  })

  it('refuses a second argument that is not a rate', () => {
    const verdict = convertedSumStands(
      { amount: 'invoices.subtotal_cents', rate: 'invoices.taxCents' },
      scope,
    )
    expect(verdict.sound).toBe(false)
    expect(verdict.sound === false && verdict.why).toMatch(/not a rate/)
  })

  it('refuses a rate from a table the query never joined', () => {
    // The expensive one, and the reason this is a check rather than a stamp.
    // `functionalSumSql` coalesces a null rate to RATE_ONE so a left-joined row
    // with no payment adds zero instead of vanishing. An *unjoined* rate column
    // is null on every row, so the same kindness turns the whole sum back into
    // the face-amount addition it was repaired from — with a helper's name on
    // it saying it was handled.
    const verdict = convertedSumStands(
      { amount: 'document_tax_lines.taxable_cents', rate: `invoices.${RATE_PROPERTY}` },
      new Set(['documentTaxLines', 'taxCodes']),
    )
    expect(verdict.sound).toBe(false)
    expect(verdict.sound === false && verdict.why).toMatch(/never joined/)
  })
})
