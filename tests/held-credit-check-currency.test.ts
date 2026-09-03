import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'
import { checkByKey } from '@/modules/integrity/register'
import { heldCredits } from '@/modules/receivables/customer-credit'

/**
 * The check that compared euros with dollars (Phase 115).
 *
 * `receivables.customer_credit` sums `heldCredits`' `availableCents` and
 * compares the total against the balance on `2520`. Per row that figure is the
 * **payment's own currency** — which is right for a list, where each credit is
 * shown to somebody in the money the customer actually sent. Summing them is
 * not: the ledger is in the company's own money, so a euro receipt puts €2,000
 * against $2,200 and reports broken books on correct ones.
 *
 * This is Phase 65's defect again — *"the three sums that still add
 * currencies"* — in a **fault**-severity check that every company gets, and
 * `payments.functional_unapplied_cents` has existed since that phase for
 * exactly this.
 *
 * Phase 114's tests did not catch it because they applied the credit in full:
 * both sides were zero, and zero is zero in any currency.
 */

let fixture: Fixture
let revenueId: string
let bankId: string
let customerId: string

/** €1 = $1.10. */
const RATE = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Sablon Freight' })
  revenueId = (await fixture.account('4000')).id
  bankId = fixture.financialAccountId

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-01-10',
    rateMillionths: RATE,
    source: 'manual',
  })

  customerId = (await createCustomer(fixture.ctx, { name: 'Ostend Logistiek NV' })).id
})

/** €5,000 against a €3,000 invoice: €2,000 held, carried at $2,200. */
const overpaidInEuros = async () => {
  const invoice = await createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Freight', unitPriceCents: 300_000 }],
  })

  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-01-10',
    amountCents: 500_000,
    financialAccountId: bankId,
    applications: [{ invoiceId: invoice.id, amountCents: 300_000 }],
  })
}

describe('the list is in the money the customer sent', () => {
  it('shows what is left in euros, which is what they overpaid', async () => {
    // Unchanged, and deliberately: somebody looking at a held credit wants the
    // figure the customer would recognise on their own statement.
    await overpaidInEuros()
    const rows = await heldCredits(fixture.ctx)

    expect(rows).toHaveLength(1)
    expect(rows[0].availableCents).toBe(200_000)
  })

  it('says what that is worth in the company’s own money as well', async () => {
    // The second number, which the check needs and the list never carried.
    await overpaidInEuros()
    const rows = await heldCredits(fixture.ctx)

    expect(rows[0].currency).toBe('EUR')
    expect(rows[0].functionalCents).toBe(220_000)
  })
})

describe('the check compares one currency with itself', () => {
  it('agrees on a euro credit nobody has spent', async () => {
    // Before this phase: 200000 against 220000, a fault on correct books.
    await overpaidInEuros()

    const outcome = await checkByKey('receivables.customer_credit')!.run(fixture.ctx, '2026-09-03')

    expect(outcome.leftCents).toBe(220_000)
    expect(outcome.rightCents).toBe(220_000)
    expect(outcome.agrees).toBe(true)
  })

  it('still agrees when the company’s own money is all there is', async () => {
    // The common case, asserted so the repair is shown not to have moved it:
    // at a rate of one the two figures coincide, and they must stay coincident.
    const invoice = await createInvoice(fixture.ctx, {
      customerId,
      issueDate: '2026-01-10',
      dueDate: '2026-02-10',
      lines: [{ chartAccountId: revenueId, description: 'Haulage', unitPriceCents: 100_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId,
      paymentDate: '2026-01-10',
      amountCents: 150_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    const outcome = await checkByKey('receivables.customer_credit')!.run(fixture.ctx, '2026-09-03')

    expect(outcome.leftCents).toBe(50_000)
    expect(outcome.agrees).toBe(true)
  })

  it('adds two currencies without adding two currencies', async () => {
    // The sum the check actually performs. A euro credit and a dollar one are
    // both money the business is holding; the only figure they can be added in
    // is the company's own.
    await overpaidInEuros()

    const dollarInvoice = await createInvoice(fixture.ctx, {
      customerId,
      issueDate: '2026-02-01',
      dueDate: '2026-03-01',
      lines: [{ chartAccountId: revenueId, description: 'Haulage', unitPriceCents: 100_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId,
      paymentDate: '2026-02-01',
      amountCents: 140_000,
      financialAccountId: bankId,
      applications: [{ invoiceId: dollarInvoice.id, amountCents: 100_000 }],
    })

    const outcome = await checkByKey('receivables.customer_credit')!.run(fixture.ctx, '2026-09-03')

    // $2,200 of euros plus $400 of dollars.
    expect(outcome.leftCents).toBe(260_000)
    expect(outcome.rightCents).toBe(260_000)
    expect(outcome.agrees).toBe(true)
  })
})
