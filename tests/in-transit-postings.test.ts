import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { checkouts, payouts } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { balanceForAccount } from '@/modules/ledger/balances'
import { accountByNumber } from '@/modules/coa/service'
import { updatePaymentSettings } from '@/modules/payments/settings'
import { importPayouts, settleCheckout, startCheckout } from '@/modules/payments/service'
import { paymentsInTransitPosition } from '@/modules/payments/reporting'
import { mockPaymentProvider } from '@/modules/payments/mock-provider'
import { putRate } from '@/modules/fx/service'

/**
 * The same rule against the database (Phase 134).
 *
 * `in-transit-currency.test.ts` proves the arithmetic. This proves the three
 * entries a euro card payment actually writes, and the one fact the whole phase
 * turns on: **`1250 Payments in Transit` reaches zero.**
 *
 * Before this phase it could not. The capture debited a converted figure and
 * the fee and payout credited face ones, so a €100 charge with a €5 fee at 1.10
 * left $10.00 behind that was not a balance, not a fee and not a gain.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture()
  mockPaymentProvider.reset()

  // The rate on every day this test touches. `rateFor` walks backwards to the
  // most recent rate on or before a date, so one entry well before the capture
  // covers the capture and the payout alike.
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2020-01-01',
    rateMillionths: 1_100_000,
    source: 'manual',
  })
})

/**
 * Somewhere for the payout to land.
 *
 * Takes a currency since Phase 136. A euro payout has to land in a euro
 * account: into a dollar account the *bank* does the conversion, at its own
 * rate, and `mayPostToBank` refuses rather than posting a guess at somebody
 * else's arithmetic. These tests were written against a dollar account in
 * Phase 134 and passed, which is what Phase 136 caught.
 */
async function enable(currency = 'USD') {
  const bank = await createFinancialAccount(fixture.ctx, {
    name: currency === 'USD' ? 'Business Checking' : 'Frankfurt Current',
    kind: 'checking',
    currency,
    mask: '4471',
  })

  await updatePaymentSettings(fixture.ctx, {
    enabled: true,
    payoutFinancialAccountId: bank.id,
  })

  return bank
}

/** A euro invoice, paid by card, end to end the way a customer does. */
async function payEuroInvoiceByCard(faceCents: number) {
  const customer = await createCustomer(fixture.ctx, { name: 'Rheinwerk GmbH' })
  const sales = await fixture.account('4000')

  const invoice = await createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'EUR',
    lines: [{ chartAccountId: sales.id, description: 'Kitchen refit', unitPriceCents: faceCents }],
  })

  const started = await startCheckout({ invoiceId: invoice.id })
  const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
  await mockPaymentProvider.confirm(row.providerCheckoutId)
  await settleCheckout(row.providerCheckoutId)

  const [after] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
  return { invoice, checkout: after }
}

const balanceOf = async (number: string) => {
  const account = await accountByNumber(fixture.companyId, number)
  return balanceForAccount(fixture.ctx, account!.id)
}

describe('a euro card payment, from charge to bank', () => {
  it('writes down what the capture actually put through the clearing account', async () => {
    await enable('EUR')
    const { checkout } = await payEuroInvoiceByCard(10_000)

    // €100 at 1.10. The fee is the mock's own, converted at the same rate as
    // the gross because both entries are posted against the same charge.
    expect(checkout.functionalGrossCents).toBe(11_000)
    expect(checkout.functionalFeeCents).toBe(352)
    expect(checkout.currency).toBe('EUR')

    // Stated rather than derived: what the clearing account would have kept if
    // the fee and the payout had stayed face, which is what this phase fixes.
    expect(checkout.functionalGrossCents! - checkout.feeCents - 9_680).toBe(1_000)
  })

  it('empties the clearing account, which is the whole phase', async () => {
    const bank = await enable('EUR')
    await payEuroInvoiceByCard(10_000)

    // Measured, on the mock's own fee schedule: a EUR100.00 charge with a
    // EUR3.20 fee at 1.10 debits $110.00 and credits $3.52, leaving $106.48 for
    // the payout of EUR96.80 to take out at $106.48.
    //
    // The old way credited the *face* figures — $3.20 and $96.80 — against a
    // converted $110.00 debit, and left exactly $10.00 behind. That is the
    // conversion uplift on the gross, and it is the number in ADR 0134.
    const held = await balanceOf('1250')
    expect(held).toBe(10_648)

    const result = await importPayouts(fixture.ctx)
    expect(result.imported).toBe(1)
    expect(result.mismatched).toEqual([])

    // The fact the phase exists for. Before this it was $10.00 short of zero.
    expect(await balanceOf('1250')).toBe(0)

    // And the bank holds what actually arrived, in the books' money.
    const [payout] = await db.select().from(payouts).where(eq(payouts.companyId, fixture.companyId))
    expect(await balanceForAccount(fixture.ctx, bank.chartAccountId)).toBe(
      payout.functionalAmountCents,
    )
  })

  it('records the rate the payout posted at, rather than deriving it twice', async () => {
    await enable('EUR')
    await payEuroInvoiceByCard(10_000)
    await importPayouts(fixture.ctx)

    const [payout] = await db.select().from(payouts).where(eq(payouts.companyId, fixture.companyId))

    // Phase 129's shape: the entry and the nightly check read one stored fact.
    expect(payout.currency).toBe('EUR')
    expect(payout.rateMillionths).toBe(1_100_000)
    expect(payout.functionalAmountCents).toBe(Math.round((payout.amountCents * 11) / 10))
  })

  it('agrees with the nightly check, which used to compare two currencies', async () => {
    await enable('EUR')
    await payEuroInvoiceByCard(10_000)

    // `heldByProcessor` summed face figures and `balanceForAccount` returns the
    // company's own money, so a euro checkout made these differ by the exchange
    // difference — reported as a discrepancy in a currency it could not state.
    const before = await paymentsInTransitPosition(fixture.ctx)
    expect(before.differenceCents).toBe(0)
    expect(before.agrees).toBe(true)

    await importPayouts(fixture.ctx)

    const after = await paymentsInTransitPosition(fixture.ctx)
    expect(after.owedCents).toBe(0)
    expect(after.ledgerCents).toBe(0)
    expect(after.agrees).toBe(true)
  })
})

describe('a euro payout into a dollar account', () => {
  it('is refused, because the bank did the conversion and we do not have its rate', async () => {
    // What Phase 134 shipped and Phase 136 caught. The three tests above were
    // written against a dollar account and passed: the arithmetic was
    // self-consistent, and it described something a bank would not do.
    //
    // The statement would show whatever the bank's rate produced. Ours is an
    // estimate of that, so Phase 40's tie-out — which compares each account in
    // its own currency — would differ by the spread with nothing to name it.
    await enable('USD')
    await payEuroInvoiceByCard(10_000)

    await expect(importPayouts(fixture.ctx)).rejects.toThrow(/bank converts that at its own rate/)
  })
})

describe('a domestic card payment', () => {
  it('is untouched, to the cent', async () => {
    // Why a hundred and thirty phases of card payments are unchanged: at parity
    // every conversion in this path is the identity.
    const bank = await enable()

    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
    const sales = await fixture.account('4000')
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [{ chartAccountId: sales.id, description: 'Kitchen refit', unitPriceCents: 100_000 }],
    })

    const started = await startCheckout({ invoiceId: invoice.id })
    const [row] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    await mockPaymentProvider.confirm(row.providerCheckoutId)
    await settleCheckout(row.providerCheckoutId)

    const [after] = await db.select().from(checkouts).where(eq(checkouts.id, started.checkoutId))
    expect(after.functionalGrossCents).toBe(after.grossCents)
    expect(after.functionalFeeCents).toBe(after.feeCents)

    const result = await importPayouts(fixture.ctx)
    expect(result.imported).toBe(1)

    const [payout] = await db.select().from(payouts).where(eq(payouts.companyId, fixture.companyId))
    expect(payout.rateMillionths).toBe(1_000_000)
    expect(payout.functionalAmountCents).toBe(payout.amountCents)

    expect(await balanceOf('1250')).toBe(0)
    expect(await balanceForAccount(fixture.ctx, bank.chartAccountId)).toBe(payout.amountCents)
  })
})
