import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { payments } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice, recordPayment } from '@/modules/receivables/service'
import { applyCredit } from '@/modules/receivables/customer-credit'
import { putRate } from '@/modules/fx/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { FX_ACCOUNTS } from '@/modules/fx/service'
import { checkByKey } from '@/modules/integrity/register'

/**
 * Held credit spent at a rate it was never carried at (Phase 114).
 *
 * `customer-credit.ts` settles the same liability in two places and only one of
 * them is right. `refundCredit` — giving the money back — uses Phase 68's
 * `settleHeld`: it relieves the held balance at **the rate the money came in
 * at**, relieves the other side at its own rate, and posts the difference as a
 * realised gain or loss. `applyCredit` — spending the credit against an invoice
 * — converts at the **invoice's** rate for the ledger while relieving the
 * subledger column at the **payment's**:
 *
 * ```ts
 * const functionalCents = convert(amountCents, invoice.exchangeRateMillionths)
 * ...
 * { chartAccountId: held.id, debitCents: functionalCents },
 * ```
 *
 * against
 *
 * ```ts
 * functionalUnappliedCents: relieveFunctional(
 *   { ...payment, exchangeRateMillionths: payment.exchangeRateMillionths }, amountCents,
 * ).functionalBalanceCents,
 * ```
 *
 * Two rates, one movement. The rates need not even be different currencies: a
 * euro receipt in January and a euro invoice in June are the same currency at
 * two rates, which is the ordinary case rather than an exotic one.
 *
 * `applyRetainer` has done this correctly since Phase 66, and `refundCredit`
 * does it correctly in this very file — so this is one settlement with two
 * answers, and the wrong one is the path a customer's overpayment takes.
 */

let fixture: Fixture
let revenueId: string
let bankId: string
let customerId: string

/** €1 = $1.10 in January, $1.25 in June. A rate that moved, which they do. */
const JANUARY = 1_100_000
const JUNE = 1_250_000

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Meridian Trading' })
  revenueId = (await fixture.account('4000')).id
  bankId = fixture.financialAccountId

  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-01-10',
    rateMillionths: JANUARY,
    source: 'manual',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-06-01',
    rateMillionths: JUNE,
    source: 'manual',
  })

  customerId = (await createCustomer(fixture.ctx, { name: 'Zeeland Import BV' })).id
})

const euroInvoice = (cents: number, issueDate: string) =>
  createInvoice(fixture.ctx, {
    customerId,
    issueDate,
    dueDate: issueDate,
    currency: 'EUR',
    lines: [{ chartAccountId: revenueId, description: 'Work', unitPriceCents: cents }],
  })

/**
 * €5,000 arrives in January against a €3,000 invoice, leaving €2,000 held.
 * At 1.10 that leftover is carried at $2,200.
 */
const overpaidInJanuary = async () => {
  const january = await euroInvoice(300_000, '2026-01-10')
  return recordPayment(fixture.ctx, {
    kind: 'receipt',
    customerId,
    paymentDate: '2026-01-10',
    amountCents: 500_000,
    financialAccountId: bankId,
    applications: [{ invoiceId: january.id, amountCents: 300_000 }],
  })
}

const heldAccountBalance = async () => {
  const held = await accountByNumber(fixture.companyId, SYSTEM_ACCOUNTS.customerOverpayments)
  return balanceForAccount(fixture.ctx, held!.id)
}

describe('the credit is carried at the rate it arrived at', () => {
  it('holds €2,000 at January’s rate', async () => {
    const payment = await overpaidInJanuary()
    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))

    expect(row.unappliedCents).toBe(200_000)
    expect(row.functionalUnappliedCents).toBe(220_000)
  })
})

describe('spending it against an invoice raised at another rate', () => {
  it('relieves the liability at what it was carried at, not at the invoice’s rate', async () => {
    // The whole defect in one number. The held credit is $2,200 on the books;
    // relieving it by $2,500 because June's rate is higher takes out money that
    // was never put in.
    const payment = await overpaidInJanuary()
    const june = await euroInvoice(200_000, '2026-06-01')

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: june.id,
      appliedOn: '2026-06-05',
    })

    // A liability fully spent holds nothing — signed in the account's normal
    // direction, so zero either way.
    expect(await heldAccountBalance()).toBe(0)
  })

  it('leaves the subledger and the ledger saying the same thing', async () => {
    // Which is what `receivables.customer_credit` exists to notice, and it is a
    // fault: nothing legitimate posts to that account except a receipt holding
    // a leftover and the application or refund that clears it.
    const payment = await overpaidInJanuary()
    const june = await euroInvoice(200_000, '2026-06-01')

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: june.id,
      appliedOn: '2026-06-05',
    })

    const check = checkByKey('receivables.customer_credit')!
    const outcome = await check.run(fixture.ctx, '2026-09-03')

    expect(outcome.leftCents).toBe(outcome.rightCents)
    expect(outcome.agrees).toBe(true)
  })

  it('recognises the rate movement as a realised gain or loss', async () => {
    // $2,200 of liability extinguishing $2,500 of receivable is a $300 loss,
    // and it belongs in the P&L rather than nowhere. `refundCredit` in this
    // same file has posted it since Phase 68.
    const payment = await overpaidInJanuary()
    const june = await euroInvoice(200_000, '2026-06-01')

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: june.id,
      appliedOn: '2026-06-05',
    })

    const fx = await accountByNumber(fixture.companyId, FX_ACCOUNTS.gainOrLoss)
    expect(fx, 'the FX account should have been created by the settlement').toBeTruthy()
    // `7100` is typed `other_income`, and `balanceForAccount` signs in the
    // account's normal direction — so a loss, which is a debit, reads negative.
    expect(await balanceForAccount(fixture.ctx, fx!.id)).toBe(-30_000)
  })

  it('still clears the invoice for what the invoice gives up', async () => {
    // The other side is unchanged: the receivable is relieved at the invoice's
    // own rate, which is what it has been carried at since it was raised.
    const payment = await overpaidInJanuary()
    const june = await euroInvoice(200_000, '2026-06-01')

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: june.id,
      appliedOn: '2026-06-05',
    })

    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id))
    expect(row.unappliedCents).toBe(0)
    expect(row.functionalUnappliedCents).toBe(0)
  })
})

describe('when the rate has not moved', () => {
  it('posts no gain or loss, and nothing else changes', async () => {
    // The common case, asserted so the repair is shown not to have disturbed
    // it: same rate on both sides, no difference to realise.
    const payment = await overpaidInJanuary()
    const second = await euroInvoice(200_000, '2026-01-10')

    await applyCredit(fixture.ctx, {
      paymentId: payment.id,
      invoiceId: second.id,
      appliedOn: '2026-01-15',
    })

    expect(await heldAccountBalance()).toBe(0)

    const check = checkByKey('receivables.customer_credit')!
    expect((await check.run(fixture.ctx, '2026-09-03')).agrees).toBe(true)
  })
})
