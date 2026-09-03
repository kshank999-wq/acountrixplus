import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { listPayments } from '@/modules/receivables/payment-voiding'
import { putRate } from '@/modules/fx/service'

/**
 * What the payments list adds up (Phase 115).
 *
 * `listPayments` returned `amountCents` and nothing else about the money, and
 * the screen above it did two things with that: rendered each row through
 * `formatCents`, whose currency argument nobody passed, and **summed the rows**
 * into a "RECEIVED" tile. A €5,000 receipt therefore appeared as `$5,000.00`
 * and contributed 500,000 to a dollar total.
 *
 * The row keeps the face amount, because that is the money the payer sent and
 * what their own bank statement says. The total needs the other one.
 */

let fixture: Fixture
let revenueId: string
let bankId: string
let customerId: string

/** €1 = $1.10. */
const RATE = 1_100_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Calais Freight Co' })
  revenueId = (await fixture.account('4000')).id
  bankId = fixture.financialAccountId

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-01-10',
    rateMillionths: RATE,
    source: 'manual',
  })

  customerId = (await createCustomer(fixture.ctx, { name: 'Dunkerque Maritime SA' })).id
})

/** A €4,000 invoice settled in full by a €4,000 receipt. */
const euroReceipt = async () => {
  const invoice = await createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Freight', unitPriceCents: 400_000 }],
  })

  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-01-10',
    amountCents: 400_000,
    financialAccountId: bankId,
    applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
  })
}

/** A $1,500 invoice settled in full by a $1,500 receipt. */
const dollarReceipt = async () => {
  const invoice = await createInvoice(fixture.ctx, {
    customerId,
    issueDate: '2026-02-01',
    dueDate: '2026-03-01',
    lines: [{ chartAccountId: revenueId, description: 'Haulage', unitPriceCents: 150_000 }],
  })

  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-02-01',
    amountCents: 150_000,
    financialAccountId: bankId,
    applications: [{ invoiceId: invoice.id, amountCents: 150_000 }],
  })
}

describe('a payment says what money it moved', () => {
  it('keeps the face amount, and names the currency it is in', async () => {
    await euroReceipt()
    const [row] = await listPayments(fixture.ctx, { today: '2026-09-03' })

    expect(row.amountCents).toBe(400_000)
    expect(row.currency).toBe('EUR')
  })

  it('carries what that was worth in the company’s own money', async () => {
    // €4,000 at 1.10. Converted at the rate fixed when the money arrived, so it
    // stays what the bank line was posted at however the rate moves afterwards.
    await euroReceipt()
    const [row] = await listPayments(fixture.ctx, { today: '2026-09-03' })

    expect(row.functionalAmountCents).toBe(440_000)
  })

  it('leaves a receipt in the company’s own currency alone', async () => {
    // The common case, asserted so the repair is shown not to have moved it.
    await dollarReceipt()
    const [row] = await listPayments(fixture.ctx, { today: '2026-09-03' })

    expect(row.currency).toBe('USD')
    expect(row.amountCents).toBe(150_000)
    expect(row.functionalAmountCents).toBe(150_000)
  })
})

describe('the total the screen shows', () => {
  it('is a figure in one currency', async () => {
    // What the "RECEIVED" tile sums. Before this phase it added 400,000 and
    // 150,000 to 550,000 and put a dollar sign on it; $4,400 plus $1,500 is
    // $5,900, and that is a number about money.
    await euroReceipt()
    await dollarReceipt()

    const rows = await listPayments(fixture.ctx, { today: '2026-09-03' })
    const received = rows
      .filter((row) => row.kind === 'receipt' && row.status === 'posted')
      .reduce((sum, row) => sum + row.functionalAmountCents, 0)

    expect(received).toBe(590_000)
  })
})

describe('what a void would put back', () => {
  it('is stated in the document’s currency, not the payment’s', async () => {
    // `payment_applications` records what the document was relieved by, so a
    // restoration goes back onto a euro invoice in euro whatever the receipt
    // was denominated in. The panel said "$4,000.00 owed" for €4,000.
    await euroReceipt()
    const [row] = await listPayments(fixture.ctx, { today: '2026-09-03' })

    expect(row.restorations).toHaveLength(1)
    expect(row.restorations[0].currency).toBe('EUR')
    expect(row.restorations[0].amountCents).toBe(400_000)
  })
})
