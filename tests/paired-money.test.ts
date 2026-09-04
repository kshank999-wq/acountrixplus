import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { invoices } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { movingConstraints } from '@/modules/fx/paired'

/**
 * The pair that moves and the pair that does not (Phase 116).
 *
 * Five tables carry a money amount twice — once in the document's own currency
 * and once in the company's — and they divide into two kinds of pair:
 *
 * - **Fixed at raise time**: `total_cents` and `functional_total_cents`, joined
 *   by the rate beside them. Neither ever moves — but the functional figure is
 *   the **lines** converted and added, because the header stores what the
 *   journal entry posted, so it is not the conversion of the total either.
 * - **Moving**: `balance_cents` and `functional_balance_cents`, which come down
 *   together on every settlement. `relieveFunctional` subtracts
 *   `convert(part, rate)` on each part payment and the **whole remainder** on
 *   the last one — deliberately, so a fully paid document cannot be left
 *   carrying a stranded cent. That rule makes the moving pair *not* a
 *   conversion of each other: each part payment can round half a cent either
 *   way, and the differences accumulate.
 *
 * `fx.conversions` recomputed the **moving** pair and called more than a cent
 * apart a fault. Its `> 1` tolerance was the tell — somebody noticed the
 * arithmetic did not line up and widened the check instead of asking which
 * arithmetic. Three ordinary part payments drift it by two.
 *
 * The **fixed** pair is no better: a document's functional total is its lines
 * converted and added, so a two-line foreign invoice differs from a conversion
 * of its total by a cent. Nothing here is recomputable, which is why the check
 * is gone rather than repaired.
 *
 * What the moving pair *does* guarantee exactly — that both sides reach zero
 * together — was enforced by a database constraint on `retainers` and by
 * nothing at all on the other four.
 */

/**
 * The constraint a write tripped, or null.
 *
 * Drizzle wraps the driver error, so `message` carries the failed SQL and the
 * `constraint_name` sits on the cause. Asserting on the name rather than on
 * "it threw" is the difference between proving *this* rule stopped the write
 * and proving *something* did.
 */
async function constraintTrippedBy(write: () => Promise<unknown>): Promise<string | null> {
  try {
    await write()
    return null
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause
    return cause?.constraint_name ?? null
  }
}

let fixture: Fixture
let revenueId: string
let bankId: string
let customerId: string

/** The ECB rate this repository's own seed data uses: €1 = $1.0835. */
const RATE = 1_083_500

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Antwerp Marine Ltd' })
  revenueId = (await fixture.account('4000')).id
  bankId = fixture.financialAccountId

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-01-01',
    rateMillionths: RATE,
    source: 'ECB',
  })

  customerId = (await createCustomer(fixture.ctx, { name: 'Scheldt Handling NV' })).id
})

/** A €1,000 invoice. At 1.0835 the ledger posts $1,083.50. */
const euroInvoice = async () =>
  createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-01-10',
    dueDate: '2026-04-10',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Berthing', unitPriceCents: 100_000 }],
  })

/** One instalment of €250 against it. */
const payInstalment = async (invoiceId: string, on: string) =>
  recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: on,
    amountCents: 25_000,
    financialAccountId: bankId,
    applications: [{ invoiceId, amountCents: 25_000 }],
  })

describe('a foreign invoice paid in instalments', () => {
  it('carries a balance its own rate cannot reproduce, and that is correct', async () => {
    // €1,000 at 1.0835 posts $1,083.50. Three instalments of €250 each relieve
    // convert(25000) = $270.88, leaving $1,083.50 − $812.64 = $270.86 carried
    // against a €250 balance that recomputes to $270.88.
    //
    // Two cents. Neither figure is wrong: the carried one is the sum of what
    // was actually relieved, the recomputed one is what a single conversion
    // would give. They are answers to different questions.
    const invoice = await euroInvoice()
    await payInstalment(invoice.id, '2026-02-10')
    await payInstalment(invoice.id, '2026-03-10')
    await payInstalment(invoice.id, '2026-04-10')

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))

    expect(row.balanceCents).toBe(25_000)
    expect(row.functionalBalanceCents).toBe(27_086)
    expect(Math.round((row.balanceCents * RATE) / 1_000_000)).toBe(27_088)
  })

  it('does not make the nightly run report a fault', async () => {
    // Before this phase `fx.conversions` said `agrees: false`, severity
    // `fault`, on a euro invoice paid in three quarterly instalments. Nothing
    // is wrong with these books, and the check that remains says so — it
    // compares the documents against the ledger rather than against a
    // recomputation of themselves, and needs no tolerance to do it.
    const invoice = await euroInvoice()
    await payInstalment(invoice.id, '2026-02-10')
    await payInstalment(invoice.id, '2026-03-10')
    await payInstalment(invoice.id, '2026-04-10')

    const report = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })

    expect(report.agrees).toBe(true)
    expect(report.receivables.differenceCents).toBe(0)
  })
})

describe('the pair that never moves is not recomputable either', () => {
  it('holds when the document has one line', async () => {
    // Which is why the defect stayed hidden: on a single-line invoice the sum
    // of converted lines and the conversion of the total are the same number,
    // and most invoices in the seed data have one line.
    const invoice = await euroInvoice()
    await payInstalment(invoice.id, '2026-02-10')

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))

    expect(row.totalCents).toBe(100_000)
    expect(row.functionalTotalCents).toBe(108_350)
  })

  it('parts company on two lines, which is an ordinary invoice', async () => {
    // €10.01 twice. The header stores what the journal entry posted — the lines
    // converted and added, $21.70 — where converting the €20.02 total gives
    // $21.69. Both are right; only one was posted.
    const twoLine = await createInvoice(fixture.ctx, {
      customerId,
      issueDate: '2026-01-10',
      dueDate: '2026-04-10',
      currency: 'EUR',
      lines: [
        { chartAccountId: revenueId, description: 'Pilotage', unitPriceCents: 1_001 },
        { chartAccountId: revenueId, description: 'Towage', unitPriceCents: 1_001 },
      ],
    })

    const [row] = await db.select().from(invoices).where(eq(invoices.id, twoLine.id))

    expect(row.totalCents).toBe(2_002)
    expect(row.functionalTotalCents).toBe(2_170)
    expect(Math.round((row.totalCents * RATE) / 1_000_000)).toBe(2_169)
  })

  it('still leaves the ledger agreeing with the documents', async () => {
    // The point. A figure that cannot be recomputed can still be reconciled:
    // the control account holds exactly what the documents behind it say,
    // because both came from the same journal entry.
    await euroInvoice()
    const report = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })

    expect(report.agrees).toBe(true)
  })
})

describe('reaching zero together', () => {
  /**
   * `relieveFunctional` guarantees it: the final settlement takes the whole
   * remaining functional balance rather than a computed one, so a document
   * whose face balance is zero holds nothing in either currency.
   *
   * A row that breaks it is money sitting on a control account that no document
   * can ever clear — Phase 48's Goods Received Not Invoiced with the sign
   * flipped, and exactly what the comment on `relieveFunctional` warns about.
   */
  it('is refused by the database on a retainer', async () => {
    // `retainers_functional_remaining_sane`, added in a raw migration and never
    // declared in the schema file.
    const tripped = await constraintTrippedBy(() =>
      db.execute(sql`
        INSERT INTO retainers (company_id, customer_id, received_on, amount_cents,
                               remaining_cents, currency, exchange_rate_millionths,
                               functional_remaining_cents)
        VALUES (${fixture.companyId}, ${customerId}, '2026-01-10', 100000,
                0, 'EUR', ${RATE}, 500)
      `),
    )

    expect(tripped).toBe('retainers_functional_remaining_sane')
  })

  it('is refused by the database on an invoice too', async () => {
    // Before this phase it was accepted: a paid invoice still carrying $5.00 on
    // the receivables control account, which `fx.conversions` could not see
    // because it reads only open documents.
    const invoice = await euroInvoice()
    await payInstalment(invoice.id, '2026-02-10')

    const tripped = await constraintTrippedBy(() =>
      db
        .update(invoices)
        .set({ balanceCents: 0, functionalBalanceCents: 500, status: 'paid' })
        .where(eq(invoices.id, invoice.id)),
    )

    expect(tripped).toBe('invoices_functional_balance_sane')
  })

  it('leaves an ordinary settlement alone', async () => {
    // The constraint must permit the thing the system does every day: four
    // instalments taking a euro invoice to zero on both sides at once.
    const invoice = await euroInvoice()
    await payInstalment(invoice.id, '2026-02-10')
    await payInstalment(invoice.id, '2026-03-10')
    await payInstalment(invoice.id, '2026-04-10')
    await payInstalment(invoice.id, '2026-05-10')

    const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))

    expect(row.balanceCents).toBe(0)
    expect(row.functionalBalanceCents).toBe(0)
    expect(row.status).toBe('paid')
  })
})

describe('the registry is not taken at its word', () => {
  /**
   * The Phase 110 lesson, applied to a different kind of declaration.
   *
   * `PAIRED_COLUMNS` claims a database constraint for every moving pair, and a
   * claim nobody checked is exactly what this project keeps finding at the
   * bottom of a defect — the retainer constraint was real but undeclared for
   * fifty phases, which is the same failure with the sides swapped.
   *
   * So the registry is asked, and the database answers.
   */
  it('every constraint it names is really in the database', async () => {
    const declared = movingConstraints()
    // Six since Phase 127 gave a write-off's recovery its functional twin. The
    // number is a floor against the list quietly shrinking; the database
    // answering below is the check that each one is real.
    expect(declared.length).toBe(6)

    const rows = await db.execute<{ table_name: string; constraint_name: string }>(sql`
      SELECT conrelid::regclass::text AS table_name, conname AS constraint_name
        FROM pg_constraint
       WHERE contype = 'c' AND conname LIKE '%functional%sane%'
    `)

    const present = new Set(
      [...rows].map((row) => `${row.table_name}.${row.constraint_name}`),
    )

    for (const { table, constraint } of declared) {
      expect(present.has(`${table}.${constraint}`), `${table}.${constraint}`).toBe(true)
    }
  })

  it('names every table the database guards, so neither list grows alone', async () => {
    // The other direction. A constraint added in a migration and left out of
    // the registry is how the retainer one went fifty phases unmentioned.
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT DISTINCT conrelid::regclass::text AS table_name
        FROM pg_constraint
       WHERE contype = 'c' AND conname LIKE '%functional%sane%'
    `)

    const guarded = [...rows].map((row) => row.table_name).sort()
    const declared = [...new Set(movingConstraints().map((row) => row.table))].sort()

    expect(guarded).toEqual(declared)
  })
})
