import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, customers, invoices, vendors, creditNotes } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { createBill, createInvoice, recordPayment } from '@/modules/receivables/service'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import {
  FX_ACCOUNTS,
  RATE_ONE,
  RateError,
  convert,
  describeRate,
  functionalCurrency,
  isForeign,
  listRates,
  normalise,
  parseRate,
  putRate,
  rateFor,
  revalue,
  settlementFor,
} from '@/modules/fx/service'
import { relieveFunctional } from '@/modules/fx/documents'
import { createCreditNote, writeOffInvoice } from '@/modules/receivables/credits'
import { foreignExposure } from '@/modules/fx/reporting'
import { INTEGRITY_CHECKS } from '@/modules/integrity/register'

/**
 * Money in two currencies (Phase 35).
 *
 * Five claims under test:
 *
 *  1. **A document is owed in its own currency**, and the ledger is only ever
 *     in the company's.
 *  2. **The rate on the day is not the rate on payment day**, and the
 *     difference is a realised gain or loss — a real one, in its own account.
 *  3. **Nothing converts a converted number.** The home amount is written once
 *     and never recomputed from a later rate.
 *  4. **A missing rate refuses**, rather than quietly using parity.
 *  5. **What is still owed is exposure, reported and not posted.**
 */

async function usd(): Promise<Fixture> {
  return createCompanyFixture({ name: 'Harbourline Trading', industry: 'general' })
}

/** A company that has a EUR rate on file for the dates the tests use. */
async function withRates(fixture: Fixture) {
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-04-01',
    rateMillionths: 1_083_500,
    source: 'ECB',
  })
  await putRate(fixture.ctx, {
    baseCurrency: 'EUR',
    rateDate: '2026-05-01',
    rateMillionths: 1_100_000,
    source: 'ECB',
  })
  return fixture
}

async function aCustomer(fixture: Fixture, name = 'Zeitgeist GmbH') {
  const [customer] = await db
    .insert(customers)
    .values({ companyId: fixture.companyId, name })
    .returning()
  return customer
}

async function aVendor(fixture: Fixture, name = 'Milano Forniture') {
  const [vendor] = await db
    .insert(vendors)
    .values({ companyId: fixture.companyId, name })
    .returning()
  return vendor
}

async function aEuroInvoice(fixture: Fixture, amountCents = 400_000, issueDate = '2026-04-01') {
  const customer = await aCustomer(fixture)
  const revenue = await accountByNumber(fixture.companyId, '4000')

  return createInvoice(fixture.ctx, {
    customerId: customer.id,
    issueDate,
    dueDate: '2026-05-31',
    currency: 'EUR',
    lines: [
      {
        description: 'Consultancy',
        quantityMilli: 1_000,
        unitPriceCents: amountCents,
        chartAccountId: revenue!.id,
      },
    ],
  })
}

async function fxBalance(fixture: Fixture): Promise<number> {
  const account = await accountByNumber(fixture.companyId, FX_ACCOUNTS.gainOrLoss)
  return account ? balanceForAccount(fixture.ctx, account.id) : 0
}

describe('converting money (Phase 35)', () => {
  it('multiplies by the rate and rounds half away from zero', () => {
    // €4,000 at 1.0835 is $4,334.00 exactly.
    expect(convert(400_000, 1_083_500)).toBe(433_400)
    // A half-cent rounds up, not to even. Being consistently half a cent
    // different from every other system is worse than the bias half-up has.
    expect(convert(1, 1_500_000)).toBe(2)
    expect(convert(-1, 1_500_000)).toBe(-2)
  })

  it('leaves an amount untouched at parity', () => {
    // The domestic path. Every document raised before this phase is this, and
    // its arithmetic has to be byte-identical or history moves.
    expect(convert(123_456, RATE_ONE)).toBe(123_456)
  })

  it('refuses a rate of zero or less', () => {
    expect(() => convert(100, 0)).toThrow(RateError)
    expect(() => convert(100, -1)).toThrow(RateError)
  })

  it('refuses a figure the arithmetic cannot hold exactly', () => {
    // Rather than silently losing precision at the top of the double range.
    expect(() => convert(Number.MAX_SAFE_INTEGER, 2_000_000)).toThrow(RateError)
  })

  it('refuses nonsense rather than producing NaN', () => {
    expect(() => convert(Number.NaN, RATE_ONE)).toThrow(RateError)
    expect(() => convert(100, Number.POSITIVE_INFINITY)).toThrow(RateError)
  })

  it('checks a currency code for shape, not against a list', () => {
    expect(normalise(' eur ')).toBe('EUR')
    expect(() => normalise('EUROS')).toThrow(RateError)
    expect(() => normalise('E')).toThrow(RateError)
    // Deliberately accepted: the ISO list changes, and refusing a real currency
    // is a worse failure than accepting a typo somebody can see.
    expect(normalise('XYZ')).toBe('XYZ')
  })

  it('writes a rate the way somebody would', () => {
    expect(describeRate(1_083_500)).toBe('1.083500')
  })

  it('knows what is foreign', () => {
    expect(isForeign('EUR', 'USD')).toBe(true)
    expect(isForeign('usd', 'USD')).toBe(false)
  })
})

describe('what settling at a different rate earns (Phase 35)', () => {
  it('names the gain between the two rates', () => {
    const settled = settlementFor({
      amountCents: 400_000,
      documentRateMillionths: 1_083_500,
      paymentRateMillionths: 1_100_000,
    })

    expect(settled.carriedCents).toBe(433_400)
    expect(settled.receivedCents).toBe(440_000)
    expect(settled.gainCents).toBe(6_600)
  })

  it('names the loss when the rate goes the other way', () => {
    const settled = settlementFor({
      amountCents: 400_000,
      documentRateMillionths: 1_100_000,
      paymentRateMillionths: 1_083_500,
    })
    expect(settled.gainCents).toBe(-6_600)
  })

  it('restates an open balance without claiming it is realised', () => {
    const result = revalue({
      outstandingCents: 400_000,
      documentRateMillionths: 1_083_500,
      closingRateMillionths: 1_100_000,
    })

    expect(result.carriedCents).toBe(433_400)
    expect(result.restatedCents).toBe(440_000)
    expect(result.unrealisedCents).toBe(6_600)
  })
})

describe('a rate is a fact with a date (Phase 35)', () => {
  it('reads back what was put in', async () => {
    const fixture = await withRates(await usd())
    const rate = await rateFor(fixture.ctx, 'EUR', '2026-04-01')

    expect(rate.rateMillionths).toBe(1_083_500)
    expect(rate.source).toBe('ECB')
  })

  it('walks backwards to the most recent rate on or before the day', async () => {
    const fixture = await withRates(await usd())

    // Mid-April: the 1 April rate still stands.
    expect((await rateFor(fixture.ctx, 'EUR', '2026-04-20')).rateMillionths).toBe(1_083_500)
    // On and after 1 May the newer one does.
    expect((await rateFor(fixture.ctx, 'EUR', '2026-05-02')).rateMillionths).toBe(1_100_000)
  })

  it('never walks forwards to a rate published after the fact', async () => {
    const fixture = await withRates(await usd())
    // A rate published in May is not what a March transaction happened at.
    await expect(rateFor(fixture.ctx, 'EUR', '2026-03-01')).rejects.toBeInstanceOf(RateError)
  })

  it('refuses rather than quietly using parity', async () => {
    const fixture = await usd()

    // The whole point. Parity turns a €4,000 invoice into a $4,000 one, and
    // nothing downstream ever looks wrong enough for anybody to notice.
    await expect(rateFor(fixture.ctx, 'EUR', '2026-04-01')).rejects.toBeInstanceOf(RateError)
  })

  it('needs no rate for the books own currency', async () => {
    const fixture = await usd()
    const rate = await rateFor(fixture.ctx, 'USD', '2026-04-01')

    expect(rate.rateMillionths).toBe(RATE_ONE)
    expect(rate.rateDate).toBeNull()
  })

  it('replaces a correction rather than sitting alongside it', async () => {
    const fixture = await usd()
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-04-01', rateMillionths: 1_080_000 })
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-04-01', rateMillionths: 1_083_500 })

    // Two rows for one day with no rule for choosing between them is how two
    // entries posted the same morning end up at different rates.
    const rates = await listRates(fixture.ctx, { currency: 'EUR' })
    expect(rates).toHaveLength(1)
    expect(rates[0].rateMillionths).toBe(1_083_500)
  })

  it('refuses a rate from the books currency to itself', async () => {
    const fixture = await usd()
    await expect(
      putRate(fixture.ctx, { baseCurrency: 'USD', rateDate: '2026-04-01', rateMillionths: 1_100_000 }),
    ).rejects.toBeInstanceOf(RateError)
  })

  it('needs the journal permission to set one', async () => {
    const fixture = await usd()
    await expect(
      putRate(
        { ...fixture.ctx, role: 'sales' },
        { baseCurrency: 'EUR', rateDate: '2026-04-01', rateMillionths: 1_083_500 },
      ),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it("keeps one company's rates out of another's", async () => {
    const first = await withRates(await usd())
    const second = await usd()

    expect(await listRates(second.ctx)).toHaveLength(0)
    await expect(rateFor(second.ctx, 'EUR', '2026-04-01')).rejects.toBeInstanceOf(RateError)
    expect(await listRates(first.ctx)).toHaveLength(2)
  })

  it('reads the company own currency', async () => {
    const fixture = await usd()
    expect(await functionalCurrency(fixture.companyId)).toBe('USD')

    await db
      .update(companies)
      .set({ currency: 'GBP' })
      .where(eq(companies.id, fixture.companyId))

    expect(await functionalCurrency(fixture.companyId)).toBe('GBP')
  })
})

describe('a foreign invoice (Phase 35)', () => {
  it('is owed in its own currency and posted in the books', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    // What the customer owes: €4,000. Not "about $4,300".
    expect(invoice.currency).toBe('EUR')
    expect(invoice.totalCents).toBe(400_000)
    expect(invoice.balanceCents).toBe(400_000)

    // What the ledger carries.
    expect(invoice.exchangeRateMillionths).toBe(1_083_500)
    expect(invoice.functionalTotalCents).toBe(433_400)
    expect(invoice.functionalBalanceCents).toBe(433_400)

    const receivable = await accountByNumber(fixture.companyId, '1100')
    expect(await balanceForAccount(fixture.ctx, receivable!.id)).toBe(433_400)
  })

  it('leaves a domestic invoice exactly as it was', async () => {
    const fixture = await usd()
    const customer = await aCustomer(fixture, 'Acme Domestic')
    const revenue = await accountByNumber(fixture.companyId, '4000')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      lines: [
        {
          description: 'Work',
          quantityMilli: 1_000,
          unitPriceCents: 250_000,
          chartAccountId: revenue!.id,
        },
      ],
    })

    // No rate on file and none needed. Every invoice raised before this phase
    // is this case, and its arithmetic must not have moved.
    expect(invoice.currency).toBe('USD')
    expect(invoice.exchangeRateMillionths).toBe(RATE_ONE)
    expect(invoice.functionalTotalCents).toBe(250_000)
    expect(invoice.functionalBalanceCents).toBe(250_000)
  })

  it('refuses to raise one with no rate on file', async () => {
    const fixture = await usd()
    await expect(aEuroInvoice(fixture)).rejects.toBeInstanceOf(RateError)
  })

  it('posts a euro bill the same way, on the other side', async () => {
    const fixture = await withRates(await usd())
    const vendor = await aVendor(fixture)
    const expense = await accountByNumber(fixture.companyId, '6000')

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-04-01',
      currency: 'EUR',
      lines: [
        {
          description: 'Materials',
          quantityMilli: 1_000,
          unitPriceCents: 100_000,
          chartAccountId: expense!.id,
        },
      ],
    })

    expect(bill.currency).toBe('EUR')
    expect(bill.totalCents).toBe(100_000)
    expect(bill.functionalTotalCents).toBe(108_350)

    const payable = await accountByNumber(fixture.companyId, '2000')
    expect(await balanceForAccount(fixture.ctx, payable!.id)).toBe(108_350)
  })

  it('keeps the balance sheet and the aging report agreeing', async () => {
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture)

    // Phase 31's check compares the ledger against the documents. Summing a
    // euro invoice's face value against a dollar control account would report
    // every foreign customer as a discrepancy the moment they were invoiced.
    const check = await controlAccounts(fixture.ctx)
    expect(check.receivables.ledgerCents).toBe(433_400)
    expect(check.receivables.subledgerCents).toBe(433_400)
    expect(check.receivables.agrees).toBe(true)
  })
})

describe('realising the gain when it is paid (Phase 35)', () => {
  it('books the difference between the two rates, not as revenue', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    const revenueBefore = await balanceForAccount(
      fixture.ctx,
      (await accountByNumber(fixture.companyId, '4000'))!.id,
    )

    // Paid on 1 May, when €1 buys $1.10 rather than $1.0835.
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: invoice.customerId,
      paymentDate: '2026-05-01',
      amountCents: 400_000,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    // $4,400 arrived against $4,334 carried. The business is $66 better off,
    // and nothing more was sold. 7100 is credit-normal, so `balanceForAccount`
    // reports a gain as positive — the same convention that caught Phase 28.
    expect(await fxBalance(fixture)).toBe(6_600)

    const revenueAfter = await balanceForAccount(
      fixture.ctx,
      (await accountByNumber(fixture.companyId, '4000'))!.id,
    )
    expect(revenueAfter).toBe(revenueBefore)

    // And the receivable is emptied to the cent.
    const receivable = await accountByNumber(fixture.companyId, '1100')
    expect(await balanceForAccount(fixture.ctx, receivable!.id)).toBe(0)
  })

  it('leaves the control accounts agreeing afterwards', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: invoice.customerId,
      paymentDate: '2026-05-01',
      amountCents: 400_000,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    const check = await controlAccounts(fixture.ctx)
    expect(check.agrees).toBe(true)
    expect(check.receivables.ledgerCents).toBe(0)
  })

  it('books a loss on a payable moving the same way', async () => {
    const fixture = await withRates(await usd())
    const vendor = await aVendor(fixture)
    const expense = await accountByNumber(fixture.companyId, '6000')

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-04-01',
      currency: 'EUR',
      lines: [
        {
          description: 'Materials',
          quantityMilli: 1_000,
          unitPriceCents: 100_000,
          chartAccountId: expense!.id,
        },
      ],
    })

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-05-01',
      amountCents: 100_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 100_000 }],
    })

    // €1,000 cost $1,083.50 when the bill arrived and $1,100 to settle. Owing
    // more of the books' own money is a loss — a debit, and so negative on a
    // credit-normal account.
    expect(await fxBalance(fixture)).toBe(-1_650)
  })

  it('posts nothing to exchange when the rate has not moved', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: invoice.customerId,
      paymentDate: '2026-04-15',
      amountCents: 400_000,
      applications: [{ invoiceId: invoice.id, amountCents: 400_000 }],
    })

    expect(await fxBalance(fixture)).toBe(0)
  })

  it('posts nothing to exchange on a domestic invoice', async () => {
    const fixture = await usd()
    const customer = await aCustomer(fixture, 'Acme Domestic')
    const revenue = await accountByNumber(fixture.companyId, '4000')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      lines: [
        { description: 'Work', quantityMilli: 1_000, unitPriceCents: 100_000, chartAccountId: revenue!.id },
      ],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-05-01',
      amountCents: 100_000,
      applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
    })

    // The FX account is not even created for a company that never needs it.
    expect(await accountByNumber(fixture.companyId, FX_ACCOUNTS.gainOrLoss)).toBeNull()
  })

  it('relieves a part payment at the document rate, not today rate', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: invoice.customerId,
      paymentDate: '2026-05-01',
      amountCents: 200_000,
      applications: [{ invoiceId: invoice.id, amountCents: 200_000 }],
    })

    // Half of €4,000 relieves half of what it was carried at — $2,167 — not
    // half of what it is worth today. Otherwise the remaining balance would be
    // carried at a rate no part of it was ever booked at.
    const receivable = await accountByNumber(fixture.companyId, '1100')
    expect(await balanceForAccount(fixture.ctx, receivable!.id)).toBe(216_700)

    const check = await controlAccounts(fixture.ctx)
    expect(check.receivables.agrees).toBe(true)
  })

  it('refuses one payment across two currencies', async () => {
    const fixture = await withRates(await usd())
    const euro = await aEuroInvoice(fixture)

    const revenue = await accountByNumber(fixture.companyId, '4000')
    const domestic = await createInvoice(fixture.ctx, {
      customerId: euro.customerId,
      issueDate: '2026-04-01',
      lines: [
        { description: 'Work', quantityMilli: 1_000, unitPriceCents: 50_000, chartAccountId: revenue!.id },
      ],
    })

    // There is no single amount of money that arrived.
    await expect(
      recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: euro.customerId,
        paymentDate: '2026-05-01',
        amountCents: 450_000,
        applications: [
          { invoiceId: euro.id, amountCents: 400_000 },
          { invoiceId: domestic.id, amountCents: 50_000 },
        ],
      }),
    ).rejects.toThrow(/one payment per currency/i)
  })
})

describe('what is still owed, restated (Phase 35)', () => {
  it('says nothing when nothing foreign is open', async () => {
    const fixture = await usd()
    const exposure = await foreignExposure(fixture.ctx, { asOf: '2026-05-01' })

    expect(exposure.noExposure).toBe(true)
    expect(exposure.netUnrealisedCents).toBe(0)
  })

  it('names the exposure per currency and per document', async () => {
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture)

    const exposure = await foreignExposure(fixture.ctx, { asOf: '2026-05-01' })

    expect(exposure.noExposure).toBe(false)
    expect(exposure.receivables).toHaveLength(1)
    expect(exposure.receivables[0].carriedCents).toBe(433_400)
    expect(exposure.receivables[0].restatedCents).toBe(440_000)
    expect(exposure.receivables[0].unrealisedCents).toBe(6_600)
    expect(exposure.byCurrency[0].currency).toBe('EUR')
    expect(exposure.netUnrealisedCents).toBe(6_600)
  })

  it('nets a receivable against a payable in the same currency', async () => {
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture, 400_000)

    const vendor = await aVendor(fixture)
    const expense = await accountByNumber(fixture.companyId, '6000')
    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-04-01',
      currency: 'EUR',
      lines: [
        { description: 'Materials', quantityMilli: 1_000, unitPriceCents: 400_000, chartAccountId: expense!.id },
      ],
    })

    // Owing and being owed the same amount in the same currency is no
    // exposure at all, which is the useful thing a net figure says.
    const exposure = await foreignExposure(fixture.ctx, { asOf: '2026-05-01' })
    expect(exposure.netUnrealisedCents).toBe(0)
  })

  it('posts none of it', async () => {
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture)
    await foreignExposure(fixture.ctx, { asOf: '2026-05-01' })

    // Reported, never posted. The rate can be back before anybody pays.
    expect(await fxBalance(fixture)).toBe(0)
    const receivable = await accountByNumber(fixture.companyId, '1100')
    expect(await balanceForAccount(fixture.ctx, receivable!.id)).toBe(433_400)
  })

  it('refuses to report a currency it has no closing rate for', async () => {
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture)

    // Reporting it at its original rate would show zero exposure, which is the
    // one answer guaranteed to be wrong.
    await expect(
      foreignExposure(fixture.ctx, { asOf: '2026-03-01' }),
    ).rejects.toBeInstanceOf(RateError)
  })
})

describe('the twelfth check, retired (Phase 35, retired Phase 116)', () => {
  /**
   * `fx.conversions` compared each open foreign document's stored home amount
   * against a fresh conversion of its remaining balance, and called more than a
   * cent apart a fault.
   *
   * The premise was that a functional figure is a conversion of its face
   * amount. It never has been: a document's functional total is its **lines**
   * converted and added, and its functional balance comes down by
   * `relieveFunctional`, which takes the whole remainder on the last
   * settlement. Both round per movement, and rounding accumulates past a cent
   * on ordinary bookkeeping.
   */
  it('is gone from the register', async () => {
    expect(INTEGRITY_CHECKS.find((row) => row.key === 'fx.conversions')).toBeUndefined()
  })

  it('leaves the control-account check, which needs no tolerance', async () => {
    // What replaced it. A control account either equals the documents behind it
    // or does not, and a home amount edited by hand moves that sum — so the
    // edit `fx.conversions` was reaching for is still caught, exactly.
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture)

    const report = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })
    expect(report.agrees).toBe(true)
    expect(report.receivables.differenceCents).toBe(0)
  })

  it('no longer calls three ordinary instalments a fault', async () => {
    // The measurement. A €4,000 invoice at 1.0835 part-paid three times leaves
    // a carried figure a recomputation cannot reproduce, and the books are
    // correct — which is the whole reason the check is gone.
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    for (const on of ['2026-05-01', '2026-05-02', '2026-05-03']) {
      await recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: invoice.customerId,
        paymentDate: on,
        amountCents: 100_000,
        applications: [{ invoiceId: invoice.id, amountCents: 100_000 }],
      })
    }

    const report = await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })
    expect(report.agrees).toBe(true)
  })
})

describe('reading a rate somebody typed (Phase 35)', () => {
  it('reads the two halves of the decimal separately', () => {
    expect(parseRate('1.0835')).toBe(1_083_500)
    expect(parseRate('1')).toBe(RATE_ONE)
    expect(parseRate('  0.75 ')).toBe(750_000)
    // Seven places is rounded rather than refused: somebody pasting more
    // precision than we store has not made a mistake.
    expect(parseRate('1.0834995')).toBe(1_083_500)
  })

  it('refuses a comma rather than reading it as a thousands separator', () => {
    // "1,0835" read as an English number is 10,835, which would turn a €4,000
    // invoice into a $43,340,000 one.
    expect(() => parseRate('1,0835')).toThrow(RateError)
    expect(() => parseRate('1,0835')).toThrow(/comma/)
  })

  it('refuses anything that is not a positive number', () => {
    expect(() => parseRate('')).toThrow(RateError)
    expect(() => parseRate('abc')).toThrow(RateError)
    expect(() => parseRate('-1.2')).toThrow(RateError)
    expect(() => parseRate('0')).toThrow(RateError)
    expect(() => parseRate('1.2e3')).toThrow(RateError)
  })
})

describe('relieving the home balance (Phase 35)', () => {
  it('takes a part payment off at the document’s own rate', () => {
    const relief = relieveFunctional(
      { balanceCents: 400_000, exchangeRateMillionths: 1_083_500, functionalBalanceCents: 433_400 },
      100_000,
    )

    expect(relief.functionalCents).toBe(108_350)
    expect(relief.functionalBalanceCents).toBe(325_050)
  })

  it('takes the whole remainder on the last payment, whatever the rounding', () => {
    // Three thirds of €4,000 at 1.0835 do not sum back to $4,334 by
    // re-converting each. The settlement takes what is left rather than what
    // the arithmetic gives, so nothing is stranded.
    const start = {
      balanceCents: 3,
      exchangeRateMillionths: 1_083_500,
      functionalBalanceCents: 4,
    }
    const relief = relieveFunctional(start, 3)

    expect(relief.functionalBalanceCents).toBe(0)
    expect(relief.functionalCents).toBe(4)
  })

  it('is a no-op at parity, so a domestic document behaves exactly as before', () => {
    const relief = relieveFunctional(
      { balanceCents: 65_00, exchangeRateMillionths: RATE_ONE, functionalBalanceCents: 65_00 },
      50_00,
    )

    expect(relief.functionalCents).toBe(50_00)
    expect(relief.functionalBalanceCents).toBe(15_00)
  })
})

describe('every way a balance goes down (Phase 35)', () => {
  /**
   * The defect this describe block exists for.
   *
   * A document balance falls in more places than "somebody paid it", and the
   * first draft of this phase maintained the home-currency balance in only one
   * of them. A gift card settled an invoice, the face balance went to zero, and
   * the amount Phase 31's control check measures against did not move — so the
   * books reported a difference that was really a missing line of code.
   *
   * The check caught it. These tests are so it stays caught.
   */
  it('a write-off moves the home balance too, on a foreign invoice', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)

    // €1,000 of a €4,000 invoice, raised at 1.0835 — $1,083.50 of $4,334.
    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-05-01',
      reason: 'Client went into administration',
      amountCents: 100_000,
    })

    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(300_000)
    expect(after.functionalBalanceCents).toBe(325_050)

    // Written off at the document's rate, not today's — the loss is a bad debt
    // of what the books carried, and re-converting it here would fold a
    // currency movement into it that nobody chose to recognise.
    //
    // Asserted against the control account since Phase 116: it compares the
    // documents against the ledger with no tolerance, where the retired
    // `fx.conversions` compared a document against a recomputation of itself.
    expect((await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })).agrees).toBe(true)
  })

  /**
   * Phase 35 refused this outright, and this test pinned the refusal:
   *
   * > A credit note's home amount is the sum of its *converted lines*, not the
   * > conversion of its total, and the two differ by a cent often enough to
   * > matter. Picking either without deciding which is right is how a set of
   * > books acquires a drift nobody can explain.
   *
   * Phase 63 lifted it, because nobody had to decide: `createInvoice` decided
   * it when it raised the document — each line converts on its own and the
   * total is their sum — and a credit note that reverses a document by
   * different arithmetic than raised it *is* the drift. The rule now lives in
   * `fx/denomination.ts`, where the invoice and the credit note share one.
   */
  it('credits a foreign invoice at the sum of its converted lines', async () => {
    const fixture = await withRates(await usd())
    const invoice = await aEuroInvoice(fixture)
    const revenue = await accountByNumber(fixture.companyId, '4000')

    const note = await createCreditNote(fixture.ctx, {
      customerId: invoice.customerId,
      issueDate: '2026-04-15',
      invoiceId: invoice.id,
      lines: [
        {
          description: 'One day not delivered',
          unitPriceCents: 100_000,
          chartAccountId: revenue!.id,
        },
      ],
    })

    const [row] = await db.select().from(creditNotes).where(eq(creditNotes.id, note.id))
    expect(row.currency).toBe('EUR')
    expect(row.totalCents).toBe(100_000)

    // The invoice itself is untouched until the credit is applied: raising a
    // credit note and spending it are two acts, as they always were.
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id))
    expect(after.balanceCents).toBe(400_000)
    expect(after.functionalBalanceCents).toBe(433_400)

    // And the books still reconcile, which is what the refusal was protecting.
    expect((await controlAccounts(fixture.ctx, { asOf: '2026-09-03' })).agrees).toBe(true)
  })

  it('still credits a domestic invoice, in a company that has foreign ones', async () => {
    // The refusal is per document, not per company. A US business with one
    // German client must not lose the ability to credit its US invoices.
    const fixture = await withRates(await usd())
    await aEuroInvoice(fixture)

    const customer = await aCustomer(fixture)
    const revenue = await accountByNumber(fixture.companyId, '4000')

    const domestic = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-01',
      dueDate: '2026-04-30',
      lines: [
        {
          description: 'Consultancy',
          quantityMilli: 1_000,
          unitPriceCents: 200_000,
          chartAccountId: revenue!.id,
        },
      ],
    })

    await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-04-15',
      invoiceId: domestic.id,
      lines: [
        { description: 'One day not delivered', unitPriceCents: 50_000, chartAccountId: revenue!.id },
      ],
      applyImmediately: true,
    })

    const [after] = await db.select().from(invoices).where(eq(invoices.id, domestic.id))
    expect(after.balanceCents).toBe(150_000)
    expect(after.functionalBalanceCents).toBe(150_000)

    const report = await controlAccounts(fixture.ctx)
    expect(report.receivables.agrees).toBe(true)
  })
})
