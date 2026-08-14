import { describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  cashBasisBalances,
  cashBasisCaveats,
  prorate,
  scaleSigned,
  type ReportingBasis,
} from '@/modules/ledger/cash-basis'
import { balanceSheet, profitAndLoss } from '@/modules/ledger/reports'
import { trialBalance } from '@/modules/ledger/balances'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import { postManualEntry } from '@/modules/ledger/journal'

/**
 * Cash-basis reporting (spec §13, ADR 0002's deferred "Phase 2b", ADR 0011).
 *
 * The claim under test: **the same books, read two ways, and both of them
 * balance.** Everything else here is that sentence checked from an angle where
 * a plausible-looking shortcut would give a different answer.
 */

async function booksFixture() {
  const fixture = await createCompanyFixture()
  const revenue = await fixture.account('4100')
  const otherRevenue = await fixture.account('4000')
  const rent = await fixture.account('6100')
  const cash = await fixture.account('1000')

  const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })
  const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

  return { fixture, revenue, otherRevenue, rent, cash, customer, vendor }
}

function totalRevenue(pl: Awaited<ReturnType<typeof profitAndLoss>>): number {
  return pl.revenue.totalCents
}

describe('splitting an amount without losing cents', () => {
  it('gives each weight its share', () => {
    expect(prorate(1000, [700, 300])).toEqual([700, 300])
    expect(prorate(500, [700, 300])).toEqual([350, 150])
  })

  it('always sums to the amount, whatever the weights', () => {
    // Integer division does not distribute. Rounding each share independently
    // loses cents, and a cash-basis P&L that does not foot to the cash
    // received is one somebody reconciles by hand.
    const cases: Array<[number, number[]]> = [
      [100, [1, 1, 1]],
      [1, [1, 1, 1]],
      [9999, [333, 333, 334]],
      [12_345, [1, 2, 3, 5, 8, 13]],
      [7, [1000000, 1]],
      [1_000_000, [3, 3, 3, 1]],
    ]

    for (const [amount, weights] of cases) {
      const shares = prorate(amount, weights)
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(amount)
      expect(shares).toHaveLength(weights.length)
    }
  })

  it('handles the degenerate cases without dividing by zero', () => {
    expect(prorate(500, [])).toEqual([])
    expect(prorate(500, [0, 0])).toEqual([0, 0])
    expect(prorate(0, [700, 300])).toEqual([0, 0])
  })
})

describe('an invoice nobody has paid', () => {
  it('is revenue on accrual and nothing on cash', async () => {
    const { fixture, revenue, customer } = await booksFixture()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 500_000 }],
    })

    const range = { startDate: '2026-01-01', endDate: '2026-12-31' }

    expect(totalRevenue(await profitAndLoss(fixture.ctx, { ...range, basis: 'accrual' }))).toBe(
      500_000,
    )
    // The whole point of the distinction: earned, not received.
    expect(totalRevenue(await profitAndLoss(fixture.ctx, { ...range, basis: 'cash' }))).toBe(0)
  })

  it('leaves no receivable on a cash-basis balance sheet', async () => {
    const { fixture, revenue, customer } = await booksFixture()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 500_000 }],
    })

    const accrual = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'accrual' })
    const cash = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'cash' })

    expect(accrual.assets.rows.some((row) => row.number === '1100')).toBe(true)
    // Cash basis is the claim that receivables do not exist. Leaving one on
    // the statement would be an unpaid balance presented as an asset.
    expect(cash.assets.rows.some((row) => row.number === '1100')).toBe(false)

    expect(accrual.isBalanced).toBe(true)
    expect(cash.isBalanced).toBe(true)
  })
})

describe('an invoice that gets paid', () => {
  it('recognizes revenue on the day the money arrives', async () => {
    const { fixture, revenue, customer } = await booksFixture()

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 500_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-05-20',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 500_000 }],
    })

    const march = { startDate: '2026-03-01', endDate: '2026-03-31' }
    const may = { startDate: '2026-05-01', endDate: '2026-05-31' }

    expect(totalRevenue(await profitAndLoss(fixture.ctx, { ...march, basis: 'accrual' }))).toBe(
      500_000,
    )
    expect(totalRevenue(await profitAndLoss(fixture.ctx, { ...march, basis: 'cash' }))).toBe(0)

    expect(totalRevenue(await profitAndLoss(fixture.ctx, { ...may, basis: 'accrual' }))).toBe(0)
    expect(totalRevenue(await profitAndLoss(fixture.ctx, { ...may, basis: 'cash' }))).toBe(500_000)
  })

  it('splits a part payment across the accounts the invoice was raised against', async () => {
    const { fixture, revenue, otherRevenue, customer } = await booksFixture()

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [
        { chartAccountId: revenue.id, description: 'Consulting', unitPriceCents: 700_000 },
        { chartAccountId: otherRevenue.id, description: 'Materials', unitPriceCents: 300_000 },
      ],
    })

    // Half of a 10,000 invoice.
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-05-20',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 500_000 }],
    })

    const rows = await cashBasisBalances(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    const consulting = rows.find((row) => row.number === '4100')!
    const materials = rows.find((row) => row.number === '4000')!

    // Not one lump against a "customer receipts" line — the shortcut that
    // looks right and cannot be filed from.
    expect(consulting.balanceCents).toBe(350_000)
    expect(materials.balanceCents).toBe(150_000)
    expect(consulting.balanceCents + materials.balanceCents).toBe(500_000)
  })

  it('recognizes the whole invoice once it is fully paid, in instalments', async () => {
    const { fixture, revenue, otherRevenue, customer } = await booksFixture()

    // Amounts chosen so an even split does not divide cleanly.
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [
        { chartAccountId: revenue.id, description: 'A', unitPriceCents: 33_333 },
        { chartAccountId: otherRevenue.id, description: 'B', unitPriceCents: 66_667 },
      ],
    })

    for (const [date, amount] of [
      ['2026-04-01', 33_333],
      ['2026-05-01', 33_333],
      ['2026-06-01', 33_334],
    ] as const) {
      await recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: customer.id,
        paymentDate: date,
        amountCents: amount,
        financialAccountId: fixture.financialAccountId,
        applications: [{ invoiceId: invoice.id, amountCents: amount }],
      })
    }

    const cash = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      basis: 'cash',
    })
    const accrual = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      basis: 'accrual',
    })

    // Fully paid means the two bases agree over a long enough window. Cents
    // lost to rounding would show up exactly here.
    expect(cash.revenue.totalCents).toBe(100_000)
    expect(cash.revenue.totalCents).toBe(accrual.revenue.totalCents)
  })
})

describe('a bill', () => {
  it('is expense on accrual when raised and on cash when paid', async () => {
    const { fixture, rent, vendor } = await booksFixture()

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: rent.id, description: 'March rent', unitPriceCents: 120_000 }],
    })

    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-04-10',
      amountCents: 120_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 120_000 }],
    })

    const march = await profitAndLoss(fixture.ctx, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      basis: 'cash',
    })
    const april = await profitAndLoss(fixture.ctx, {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      basis: 'cash',
    })

    expect(march.operatingExpenses.totalCents).toBe(0)
    expect(april.operatingExpenses.totalCents).toBe(120_000)
  })

  it('leaves no payable on a cash-basis balance sheet', async () => {
    const { fixture, rent, vendor } = await booksFixture()

    await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: rent.id, description: 'March rent', unitPriceCents: 120_000 }],
    })

    const cash = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'cash' })

    expect(cash.liabilities.rows.some((row) => row.number === '2000')).toBe(false)
    expect(cash.isBalanced).toBe(true)
  })
})

describe('what cash basis leaves alone', () => {
  it('does not touch a transaction that was already cash', async () => {
    const { fixture, rent, cash } = await booksFixture()

    // A categorized bank transaction hits the expense and the bank in one
    // entry — it is cash basis already, and adjusting it would double-count.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-15',
      memo: 'Card payment for rent',
      lines: [
        { chartAccountId: rent.id, debitCents: 90_000 },
        { chartAccountId: cash.id, creditCents: 90_000 },
      ],
    })

    const range = { startDate: '2026-01-01', endDate: '2026-12-31' }

    const accrual = await profitAndLoss(fixture.ctx, { ...range, basis: 'accrual' })
    const cashBasis = await profitAndLoss(fixture.ctx, { ...range, basis: 'cash' })

    expect(accrual.operatingExpenses.totalCents).toBe(90_000)
    expect(cashBasis.operatingExpenses.totalCents).toBe(90_000)
  })

  it('keeps the bank balance identical on both bases', async () => {
    const { fixture, revenue, rent, customer, vendor } = await booksFixture()

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 500_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 500_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 500_000 }],
    })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-05',
      lines: [{ chartAccountId: rent.id, description: 'Rent', unitPriceCents: 120_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-04-05',
      amountCents: 120_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 120_000 }],
    })

    const accrual = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'accrual' })
    const cash = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'cash' })

    const bankOf = (sheet: typeof accrual) =>
      sheet.assets.rows.find((row) => row.number === '1000')?.balanceCents ?? 0

    // Cash in the bank is a fact, not an accounting policy. If a basis change
    // moved it, the transformation would be wrong.
    expect(bankOf(cash)).toBe(bankOf(accrual))
    expect(bankOf(cash)).toBe(500_000 - 120_000)
  })
})

describe('both bases balance', () => {
  it('over a busy set of books', async () => {
    const { fixture, revenue, otherRevenue, rent, cash, customer, vendor } = await booksFixture()

    const first = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-02-01',
      lines: [
        { chartAccountId: revenue.id, description: 'Phase 1', unitPriceCents: 400_000 },
        { chartAccountId: otherRevenue.id, description: 'Materials', unitPriceCents: 111_111 },
      ],
    })
    const second = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Phase 2', unitPriceCents: 250_000 }],
    })

    // One paid in part, one paid in full, one untouched.
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 200_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: first.id, amountCents: 200_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-15',
      amountCents: 250_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: second.id, amountCents: 250_000 }],
    })
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-05-01',
      lines: [{ chartAccountId: revenue.id, description: 'Phase 3', unitPriceCents: 90_000 }],
    })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-02-10',
      lines: [{ chartAccountId: rent.id, description: 'Rent', unitPriceCents: 130_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-03-10',
      amountCents: 70_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 70_000 }],
    })

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-01',
      memo: 'Direct card spend',
      lines: [
        { chartAccountId: rent.id, debitCents: 45_000 },
        { chartAccountId: cash.id, creditCents: 45_000 },
      ],
    })

    for (const basis of ['accrual', 'cash'] as ReportingBasis[]) {
      const sheet = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis })
      expect(sheet.isBalanced, `${basis} balance sheet`).toBe(true)
    }

    // And the cash-basis ledger itself foots, which is the property the
    // transformation's correctness argument rests on.
    const rows = await cashBasisBalances(fixture.ctx, { endDate: '2026-12-31' })
    const debits = rows.reduce((sum, row) => sum + row.debitCents, 0)
    const credits = rows.reduce((sum, row) => sum + row.creditCents, 0)
    expect(debits).toBe(credits)
  })

  it('agrees with accrual once everything has settled', async () => {
    const { fixture, revenue, customer, rent, vendor } = await booksFixture()

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-02-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 640_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-03-01',
      amountCents: 640_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: invoice.id, amountCents: 640_000 }],
    })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-02-05',
      lines: [{ chartAccountId: rent.id, description: 'Rent', unitPriceCents: 210_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-03-05',
      amountCents: 210_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 210_000 }],
    })

    const range = { startDate: '2026-01-01', endDate: '2026-12-31' }
    const accrual = await profitAndLoss(fixture.ctx, { ...range, basis: 'accrual' })
    const cash = await profitAndLoss(fixture.ctx, { ...range, basis: 'cash' })

    // The bases differ on *timing*, not on totals. Over a window in which
    // everything was raised and settled they must agree, and if they do not
    // the transformation is losing or inventing money somewhere.
    expect(cash.netIncomeCents).toBe(accrual.netIncomeCents)
  })
})

describe('the cases that broke the first version', () => {
  it('treats a bad debt as a non-event, leaving no stranded receivable', async () => {
    const { fixture, revenue, customer } = await booksFixture()
    const { writeOffInvoice } = await import('@/modules/receivables/credits')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 240_000 }],
    })

    await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-07-31',
      reason: 'Customer entered administration',
    })

    const sheet = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'cash' })

    // The first version kept the write-off's credit to Receivables, which put
    // a negative receivable on a statement that has no receivables at all.
    expect(sheet.assets.rows.some((row) => row.number === '1100')).toBe(false)
    expect(sheet.isBalanced).toBe(true)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      basis: 'cash',
    })

    // No revenue was ever taken into account, so there is nothing to write
    // off — which is also why a cash-basis taxpayer cannot deduct a bad debt.
    expect(pl.revenue.totalCents).toBe(0)
    expect(pl.operatingExpenses.totalCents).toBe(0)
  })

  it('recognizes revenue when a written-off debt is recovered', async () => {
    const { fixture, revenue, customer } = await booksFixture()
    const { writeOffInvoice, recoverWriteOff } = await import('@/modules/receivables/credits')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 240_000 }],
    })

    const writeOff = await writeOffInvoice(fixture.ctx, invoice.id, {
      writtenOffOn: '2026-07-31',
      reason: 'Gone quiet',
    })

    await recoverWriteOff(fixture.ctx, writeOff.id, {
      recoveredOn: '2026-10-01',
      amountCents: 240_000,
      financialAccountId: fixture.financialAccountId,
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      basis: 'cash',
    })

    // Cash arrived against that invoice, so on a cash basis that is when its
    // revenue is recognized — on the account the invoice was raised against,
    // not as a negative expense.
    expect(pl.revenue.totalCents).toBe(240_000)
    expect(pl.operatingExpenses.totalCents).toBe(0)

    const sheet = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'cash' })
    expect(sheet.isBalanced).toBe(true)
  })

  it('balances for a construction company with retainage', async () => {
    // The case the first version got wrong: a retainage-release invoice has
    // *only* control legs, so there was nothing to recognize against and the
    // payment's leg was removed with nothing put back.
    const fixture = await createCompanyFixture({ industry: 'construction' })
    const contractRevenue = await fixture.account('4200')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const progress = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      retainageCents: 56_000,
      lines: [
        { chartAccountId: contractRevenue.id, description: 'Application 1', unitPriceCents: 560_000 },
      ],
    })

    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 504_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ invoiceId: progress.id, amountCents: 504_000 }],
    })

    const rows = await cashBasisBalances(fixture.ctx, { endDate: '2026-12-31' })
    const debits = rows.reduce((sum, row) => sum + row.debitCents, 0)
    const credits = rows.reduce((sum, row) => sum + row.creditCents, 0)

    expect(debits).toBe(credits)

    const sheet = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31', basis: 'cash' })
    expect(sheet.isBalanced).toBe(true)
    expect(sheet.assets.rows.some((row) => row.number === '1100')).toBe(false)
  })

  it('scales legs on both sides of a document without flipping one', () => {
    // A progress billing: debit retainage, credit the full revenue. Adding up
    // magnitudes here gives shares of the right size and the wrong direction.
    const shares = scaleSigned(-504_000, [56_000, -560_000])

    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(-504_000)
    expect(shares[0]).toBeGreaterThan(0)
    expect(shares[1]).toBeLessThan(0)
  })
})

describe('the basis is never assumed', () => {
  it('defaults to accrual and says which it used', async () => {
    const { fixture } = await booksFixture()

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    const sheet = await balanceSheet(fixture.ctx, { asOfDate: '2026-12-31' })

    // Every existing caller keeps meaning what it did, and a report that does
    // not carry its own basis is one somebody reads on the wrong one.
    expect(pl.basis).toBe('accrual')
    expect(sheet.basis).toBe('accrual')
  })

  it('warns about what cash basis cannot represent, from the actual books', async () => {
    const { fixture, revenue, customer } = await booksFixture()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      taxCents: 8_250,
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })

    // A receipt applied to nothing.
    await recordPayment(fixture.ctx, {
      kind: 'receipt',
      customerId: customer.id,
      paymentDate: '2026-04-01',
      amountCents: 50_000,
      financialAccountId: fixture.financialAccountId,
      applications: [],
    }).catch(() => {
      // The service requires applications to match the amount; an unapplied
      // receipt is not reachable through it, so the caveat covers data that
      // arrives another way. Checked below on the tax caveat instead.
    })

    const caveats = await cashBasisCaveats(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    const areas = caveats.map((caveat) => caveat.area)
    expect(areas).toContain('Sales tax')

    // Computed from the data, not boilerplate: a company with no payroll is
    // not warned about payroll.
    expect(areas).not.toContain('Payroll')
  })
})

describe('the trial balance is unaffected', () => {
  it('still reports the accrual ledger', async () => {
    const { fixture, revenue, customer } = await booksFixture()

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 500_000 }],
    })

    // The trial balance is a statement about the journal, and the journal is
    // kept on one basis. Cash basis is a way of reading it, not a second set
    // of books.
    const tb = await trialBalance(fixture.ctx, { endDate: '2026-12-31' })

    expect(tb.isBalanced).toBe(true)
    expect(tb.rows.some((row) => row.number === '1100')).toBe(true)
  })
})
