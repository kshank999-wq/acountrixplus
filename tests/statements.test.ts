import { describe, expect, it } from 'vitest'
import { createCompanyFixture } from './helpers'
import { cashFlowStatement } from '@/modules/ledger/cash-flow'
import {
  cashFlowClass,
  isAccrualOnly,
  isCashAccount,
} from '@/modules/coa/classification'
import {
  comparativeBalanceSheet,
  comparativeProfitAndLoss,
  comparisonWindows,
  varianceBasisPoints,
} from '@/modules/ledger/comparative'
import { postManualEntry } from '@/modules/ledger/journal'
import { profitAndLoss } from '@/modules/ledger/reports'
import { cashBasisBalances, cashBasisCaveats } from '@/modules/ledger/cash-basis'
import {
  createDeposit,
  depositWithItems,
  listDeposits,
  undepositedReceipts,
  voidDeposit,
} from '@/modules/banking/deposits'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import {
  applyVendorCredit,
  createVendorCredit,
  listVendorCredits,
} from '@/modules/receivables/vendor-credits'
import { closeFiscalYear, staleCloses } from '@/modules/ledger/closing'
import { trialBalance } from '@/modules/ledger/balances'

/**
 * Phase 12 — the statements an accountant asks for (spec §13).
 *
 * Each block here tests one falsifiable claim rather than a function's surface:
 *
 *  - the cash flow statement's three sections sum to the movement the cash
 *    accounts actually recorded;
 *  - a comparative statement shows an account that appears in only one column;
 *  - three cheques banked together are one line the bank can match;
 *  - a vendor credit is the mirror of a customer one and reverses the expense;
 *  - an accrual is not an expense on a cash basis, and its settlement is.
 */

describe('classifying an account', () => {
  it('puts cash where the statement can find it', () => {
    expect(isCashAccount('asset', 'bank')).toBe(true)
    expect(isCashAccount('asset', 'cash')).toBe(true)
    // Money in the drawer is money the business has. If it were not cash,
    // every deposit would show as an operating inflow.
    expect(isCashAccount('asset', 'undeposited_funds')).toBe(true)
    expect(isCashAccount('asset', 'accounts_receivable')).toBe(false)
  })

  it('puts accumulated depreciation in operating, not investing', () => {
    // The one classification that looks wrong and is right: its movement is
    // the depreciation charge, and the indirect method's first adjustment is
    // to add that back. Beside the asset it offsets, it would read as a
    // disposal.
    expect(cashFlowClass('asset', 'accumulated_depreciation')).toBe('operating')
    expect(cashFlowClass('asset', 'fixed_asset')).toBe('investing')
    expect(cashFlowClass('liability', 'long_term_liability')).toBe('financing')
    expect(cashFlowClass('equity', null)).toBe('financing')
    expect(cashFlowClass('expense', null)).toBe('income')
  })

  it('does not treat depreciation as a timing difference', () => {
    // A depreciation entry has the same shape as an accrual — an expense
    // against a balance-sheet account, no cash — but a cash-basis taxpayer
    // still deducts it. Any rule phrased as "entries that touch no cash" gets
    // this one wrong, which is why the list is by account.
    expect(isAccrualOnly('asset', 'accumulated_depreciation')).toBe(false)
    expect(isAccrualOnly('liability', 'accrued_liability')).toBe(true)
    expect(isAccrualOnly('asset', 'prepaid_expense')).toBe(true)
    expect(isAccrualOnly('liability', 'deferred_revenue')).toBe(true)
  })
})

describe('the statement of cash flows', () => {
  it('reconciles to what the cash accounts actually moved', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const equipment = await fixture.account('1500')
    const depreciation = await fixture.account('1510')
    const depreciationExpense = await fixture.account('9100')
    const loan = await fixture.account('2400')
    const revenue = await fixture.account('4100')
    const rent = await fixture.account('6400')

    // Financing: borrow.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-05',
      memo: 'Equipment loan drawn',
      lines: [
        { chartAccountId: cash.id, debitCents: 5_000_000 },
        { chartAccountId: loan.id, creditCents: 5_000_000 },
      ],
    })

    // Investing: spend it on a machine.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-06',
      memo: 'Machine purchased',
      lines: [
        { chartAccountId: equipment.id, debitCents: 4_000_000 },
        { chartAccountId: cash.id, creditCents: 4_000_000 },
      ],
    })

    // Operating: earn some cash, pay some rent.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      memo: 'Cash sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 900_000 },
        { chartAccountId: revenue.id, creditCents: 900_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-10',
      memo: 'Rent paid',
      lines: [
        { chartAccountId: rent.id, debitCents: 300_000 },
        { chartAccountId: cash.id, creditCents: 300_000 },
      ],
    })

    // The non-cash charge the whole indirect method exists to explain.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-12-31',
      memo: 'Depreciation for the year',
      lines: [
        { chartAccountId: depreciationExpense.id, debitCents: 800_000 },
        { chartAccountId: depreciation.id, creditCents: 800_000 },
      ],
    })

    const statement = await cashFlowStatement(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The claim. Everything below is detail; this is the statement being right.
    expect(statement.reconciles).toBe(true)
    expect(statement.netChangeInCashCents).toBe(5_000_000 - 4_000_000 + 900_000 - 300_000)

    // Net income is down by the depreciation, and the operating section adds
    // it straight back because no cash left.
    expect(statement.netIncomeCents).toBe(900_000 - 300_000 - 800_000)
    expect(statement.operating.totalCents).toBe(600_000)

    expect(statement.investing.totalCents).toBe(-4_000_000)
    expect(statement.financing.totalCents).toBe(5_000_000)

    expect(statement.openingCashCents).toBe(0)
    expect(statement.closingCashCents).toBe(1_600_000)
  })

  it('shows an unpaid invoice as profit that is not yet cash', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Consulting',
          quantityMilli: 1000,
          unitPriceCents: 400_000,
        },
      ],
    })

    const statement = await cashFlowStatement(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(statement.netIncomeCents).toBe(400_000)
    // The receivable grew by exactly the profit, so operating nets to nothing
    // and the cash accounts never moved.
    expect(statement.operating.totalCents).toBe(0)
    expect(statement.netChangeInCashCents).toBe(0)
    expect(statement.reconciles).toBe(true)
  })
})

describe('comparative periods', () => {
  it('computes the windows an accountant asks for by name', () => {
    expect(comparisonWindows({ startDate: '2026-04-01', endDate: '2026-06-30' }, 'prior_period')[1])
      .toMatchObject({ startDate: '2026-01-01', endDate: '2026-03-31' })

    expect(comparisonWindows({ startDate: '2026-06-01', endDate: '2026-06-30' }, 'prior_year')[1])
      .toMatchObject({ startDate: '2025-06-01', endDate: '2025-06-30' })

    // 29 February has no counterpart in the prior year. `setUTCFullYear` would
    // roll it to 1 March and move the window into the wrong month.
    expect(comparisonWindows({ startDate: '2024-02-01', endDate: '2024-02-29' }, 'prior_year')[1])
      .toMatchObject({ startDate: '2023-02-01', endDate: '2023-02-28' })
  })

  it('has no percentage when there is nothing to compare against', () => {
    expect(varianceBasisPoints(500, 400)).toBe(2_500)
    expect(varianceBasisPoints(500, 0)).toBeNull()
    // Against a loss, the share is of the magnitude — otherwise an improvement
    // and a deterioration both come out positive.
    expect(varianceBasisPoints(-300, -600)).toBe(5_000)
  })

  it('keeps an account that appears in only one column', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')
    const advertising = await fixture.account('6000')
    const travel = await fixture.account('6700')

    await postManualEntry(fixture.ctx, {
      entryDate: '2025-06-15',
      memo: 'Trade show, last year',
      lines: [
        { chartAccountId: advertising.id, debitCents: 250_000 },
        { chartAccountId: cash.id, creditCents: 250_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-15',
      memo: 'Site visits, this year',
      lines: [
        { chartAccountId: travel.id, debitCents: 100_000 },
        { chartAccountId: cash.id, creditCents: 100_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-20',
      memo: 'Cash sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 900_000 },
        { chartAccountId: revenue.id, creditCents: 900_000 },
      ],
    })

    const report = await comparativeProfitAndLoss(fixture.ctx, {
      periods: comparisonWindows(
        { startDate: '2026-01-01', endDate: '2026-12-31' },
        'prior_year',
      ),
    })

    const rows = report.operatingExpenses.rows
    const byNumber = new Map(rows.map((row) => [row.number, row]))

    // "We stopped spending on this" is exactly what a comparative is read to
    // find out, so the account has to survive with a zero rather than vanish.
    expect(byNumber.get('6000')?.amountsCents).toEqual([0, 250_000])
    expect(byNumber.get('6000')?.varianceCents).toBe(-250_000)
    expect(byNumber.get('6700')?.amountsCents).toEqual([100_000, 0])
    // No prior figure, so no percentage rather than an infinite one.
    expect(byNumber.get('6700')?.varianceBasisPoints).toBeNull()

    expect(report.netIncomeCents).toEqual([800_000, -250_000])
  })

  it('balances in every column', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')

    await postManualEntry(fixture.ctx, {
      entryDate: '2025-11-01',
      memo: 'Prior year sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 100_000 },
        { chartAccountId: revenue.id, creditCents: 100_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-11-01',
      memo: 'This year sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 300_000 },
        { chartAccountId: revenue.id, creditCents: 300_000 },
      ],
    })

    const sheet = await comparativeBalanceSheet(fixture.ctx, {
      columns: [
        { label: 'This year', asOfDate: '2026-12-31' },
        { label: 'Last year', asOfDate: '2025-12-31' },
      ],
    })

    expect(sheet.isBalanced).toEqual([true, true])
    expect(sheet.totalAssetsCents).toEqual([400_000, 100_000])
  })
})

describe('undeposited funds and deposits', () => {
  async function threeCheques() {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const undeposited = await fixture.account('1200')

    const names = ['Harborview LLC', 'Delta Mills', 'Kestrel Group']
    const amounts = [180_000, 245_000, 72_500]

    for (let index = 0; index < names.length; index++) {
      const customer = await createCustomer(fixture.ctx, { name: names[index] })
      const invoice = await createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-05-01',
        dueDate: '2026-05-31',
        lines: [
          {
            chartAccountId: revenue.id,
            description: 'Work done',
            quantityMilli: 1000,
            unitPriceCents: amounts[index],
          },
        ],
      })

      // No financial account: the cheque arrived and has not been banked.
      await recordPayment(fixture.ctx, {
        kind: 'receipt',
        customerId: customer.id,
        paymentDate: '2026-05-04',
        amountCents: amounts[index],
        applications: [{ invoiceId: invoice.id, amountCents: amounts[index] }],
      })
    }

    return { fixture, undeposited, grossCents: amounts.reduce((a, b) => a + b, 0) }
  }

  it('banks three cheques as one line the bank can match', async () => {
    const { fixture, undeposited, grossCents } = await threeCheques()

    const waiting = await undepositedReceipts(fixture.ctx)
    expect(waiting).toHaveLength(3)

    const beforeDeposit = await trialBalance(fixture.ctx, { endDate: '2026-05-31' })
    expect(
      beforeDeposit.rows.find((row) => row.number === '1200')?.balanceCents,
    ).toBe(grossCents)

    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      depositDate: '2026-05-07',
      items: waiting.map((receipt) => ({ paymentId: receipt.id })),
    })

    expect(deposit.totalCents).toBe(grossCents)

    const after = await trialBalance(fixture.ctx, { endDate: '2026-05-31' })
    expect(after.isBalanced).toBe(true)
    // Undeposited Funds cleared, and the bank shows one figure — the one the
    // statement will carry.
    expect(after.rows.find((row) => row.number === '1200')?.balanceCents ?? 0).toBe(0)
    expect(after.rows.find((row) => row.number === '1000')?.balanceCents).toBe(grossCents)

    // The customer detail is still on the payments, where the receivable, the
    // statement, and the aging report all need it.
    const { items } = await depositWithItems(fixture.ctx, deposit.id)
    expect(items.map((item) => item.customerName).sort()).toEqual([
      'Delta Mills',
      'Harborview LLC',
      'Kestrel Group',
    ])

    expect(await undepositedReceipts(fixture.ctx)).toHaveLength(0)
    void undeposited
  })

  it('records the net when a processor takes its cut', async () => {
    const { fixture, grossCents } = await threeCheques()
    const fees = await fixture.account('6850')
    const waiting = await undepositedReceipts(fixture.ctx)

    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      depositDate: '2026-05-07',
      items: [
        ...waiting.map((receipt) => ({ paymentId: receipt.id })),
        { chartAccountId: fees.id, amountCents: -14_281, memo: 'Processing fee' },
      ],
    })

    expect(deposit.receiptsCents).toBe(grossCents)
    expect(deposit.totalCents).toBe(grossCents - 14_281)

    const after = await trialBalance(fixture.ctx, { endDate: '2026-05-31' })
    expect(after.isBalanced).toBe(true)
    // The bank shows what the bank processed, not the gross customers paid.
    expect(after.rows.find((row) => row.number === '1000')?.balanceCents).toBe(
      grossCents - 14_281,
    )
    expect(after.rows.find((row) => row.number === '6850')?.balanceCents).toBe(14_281)
  })

  it('refuses to bank the same cheque twice', async () => {
    const { fixture } = await threeCheques()
    const waiting = await undepositedReceipts(fixture.ctx)

    await createDeposit(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      depositDate: '2026-05-07',
      items: [{ paymentId: waiting[0].id }],
    })

    // The unique index is the thing that actually prevents it — two concurrent
    // deposits would both pass any read-then-check.
    await expect(
      createDeposit(fixture.ctx, {
        financialAccountId: fixture.financialAccountId,
        depositDate: '2026-05-08',
        items: [{ paymentId: waiting[0].id }],
      }),
    ).rejects.toThrow()
  })

  it('refuses a deposit that a fee has eaten', async () => {
    const { fixture } = await threeCheques()
    const fees = await fixture.account('6850')
    const waiting = await undepositedReceipts(fixture.ctx)

    await expect(
      createDeposit(fixture.ctx, {
        financialAccountId: fixture.financialAccountId,
        depositDate: '2026-05-07',
        items: [
          { paymentId: waiting[0].id },
          { chartAccountId: fees.id, amountCents: -900_000 },
        ],
      }),
    ).rejects.toThrow(/more than nothing/)
  })

  it('makes the receipts depositable again when reversed', async () => {
    const { fixture, grossCents } = await threeCheques()
    const waiting = await undepositedReceipts(fixture.ctx)

    const deposit = await createDeposit(fixture.ctx, {
      financialAccountId: fixture.financialAccountId,
      depositDate: '2026-05-07',
      items: waiting.map((receipt) => ({ paymentId: receipt.id })),
    })

    await voidDeposit(fixture.ctx, deposit.id, '2026-05-09')

    const after = await trialBalance(fixture.ctx, { endDate: '2026-05-31' })
    expect(after.isBalanced).toBe(true)
    expect(after.rows.find((row) => row.number === '1000')?.balanceCents ?? 0).toBe(0)
    expect(after.rows.find((row) => row.number === '1200')?.balanceCents).toBe(grossCents)

    expect(await undepositedReceipts(fixture.ctx)).toHaveLength(3)

    // Reversed, not deleted: the trip to the bank happened and was undone.
    const listed = await listDeposits(fixture.ctx)
    expect(listed).toHaveLength(1)
    expect(listed[0].voidedAt).not.toBeNull()
  })
})

describe('vendor credits', () => {
  async function billed() {
    const fixture = await createCompanyFixture()
    const materials = await fixture.account('5100')
    const vendor = await createVendor(fixture.ctx, { name: 'Supply Depot' })

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-07-01',
      dueDate: '2026-07-31',
      lines: [
        {
          chartAccountId: materials.id,
          description: 'Lumber',
          quantityMilli: 1000,
          unitPriceCents: 600_000,
        },
      ],
    })

    return { fixture, materials, vendor, bill }
  }

  it('reverses the expense the bill recognized, on the same account', async () => {
    const { fixture, vendor, bill } = await billed()

    const credit = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      billId: bill.id,
      issueDate: '2026-07-10',
      // No lines: it defaults to the bill's own, which is what makes the
      // credit land on the account the cost was booked to.
      reason: 'Damaged in transit',
      applyImmediately: true,
    })

    expect(credit.number).toBe('VC-1001')
    expect(credit.remainingCents).toBe(0)

    const balances = await trialBalance(fixture.ctx, { endDate: '2026-07-31' })
    expect(balances.isBalanced).toBe(true)
    // Materials back to nothing, and no "purchase returns" bucket that would
    // have balanced and told nobody which cost went away.
    expect(balances.rows.find((row) => row.number === '5100')?.balanceCents ?? 0).toBe(0)
    expect(balances.rows.find((row) => row.number === '2000')?.balanceCents ?? 0).toBe(0)

    const listed = await listVendorCredits(fixture.ctx)
    expect(listed).toHaveLength(1)
    expect(listed[0].vendorName).toBe('Supply Depot')
  })

  it('settles part of a bill without a payment', async () => {
    const { fixture, materials, vendor, bill } = await billed()

    const credit = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-07-10',
      lines: [
        {
          chartAccountId: materials.id,
          description: 'Short delivery',
          unitPriceCents: 150_000,
        },
      ],
    })

    const result = await applyVendorCredit(fixture.ctx, {
      creditNoteId: credit.id,
      billId: bill.id,
      amountCents: 150_000,
      appliedOn: '2026-07-11',
    })

    expect(result.billBalanceCents).toBe(450_000)
    expect(result.creditRemainingCents).toBe(0)
  })

  it('will not apply a customer credit to a bill', async () => {
    const { fixture, vendor, bill } = await billed()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-07-01',
      dueDate: '2026-07-31',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Work',
          quantityMilli: 1000,
          unitPriceCents: 50_000,
        },
      ],
    })

    const { createCreditNote } = await import('@/modules/receivables/credits')
    const customerCredit = await createCreditNote(fixture.ctx, {
      customerId: customer.id,
      invoiceId: invoice.id,
      issueDate: '2026-07-05',
    })

    await expect(
      applyVendorCredit(fixture.ctx, {
        creditNoteId: customerCredit.id,
        billId: bill.id,
        amountCents: 10_000,
        appliedOn: '2026-07-06',
      }),
    ).rejects.toThrow(/customer credit note/)

    void vendor
  })

  it('numbers the two kinds independently', async () => {
    const { fixture, vendor } = await billed()
    const materials = await fixture.account('5100')

    const first = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-07-10',
      lines: [{ chartAccountId: materials.id, description: 'A', unitPriceCents: 1_000 }],
    })
    const second = await createVendorCredit(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-07-11',
      lines: [{ chartAccountId: materials.id, description: 'B', unitPriceCents: 1_000 }],
    })

    // Counting all credit notes here would skip a CN number every time a
    // vendor credit was raised, and vice versa.
    expect([first.number, second.number]).toEqual(['VC-1001', 'VC-1002'])
  })
})

describe('accruals on a cash basis', () => {
  it('does not report an accrued expense as an expense', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const accrued = await fixture.account('2150')
    const cash = await fixture.account('1000')

    // The pattern the textbook prescribes: accrue at period end, reverse on
    // day one, then the real payment lands.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-31',
      memo: 'Accrue March rent',
      lines: [
        { chartAccountId: rent.id, debitCents: 400_000 },
        { chartAccountId: accrued.id, creditCents: 400_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-01',
      memo: 'Reverse March accrual',
      lines: [
        { chartAccountId: accrued.id, debitCents: 400_000 },
        { chartAccountId: rent.id, creditCents: 400_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-15',
      memo: 'March rent paid',
      lines: [
        { chartAccountId: rent.id, debitCents: 400_000 },
        { chartAccountId: cash.id, creditCents: 400_000 },
      ],
    })

    const march = { startDate: '2026-03-01', endDate: '2026-03-31' }
    const april = { startDate: '2026-04-01', endDate: '2026-04-30' }

    // Accrual basis: the cost belongs to March, which is what accruing it says.
    expect((await profitAndLoss(fixture.ctx, { ...march, basis: 'accrual' })).operatingExpenses.totalCents)
      .toBe(400_000)

    // Cash basis: nothing left the bank in March. This is the defect Phase 12
    // fixes — before it, the accrual showed here as an expense.
    expect((await profitAndLoss(fixture.ctx, { ...march, basis: 'cash' })).operatingExpenses.totalCents)
      .toBe(0)
    expect((await profitAndLoss(fixture.ctx, { ...april, basis: 'cash' })).operatingExpenses.totalCents)
      .toBe(400_000)
  })

  it('recognizes an accrual settled straight from the bank', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const accrued = await fixture.account('2150')
    const cash = await fixture.account('1000')

    // No reversing entry — the accrual is paid off directly, which is the case
    // where dropping the accrual and stopping there would lose the expense
    // permanently rather than merely misdate it.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-31',
      memo: 'Accrue March rent',
      lines: [
        { chartAccountId: rent.id, debitCents: 400_000 },
        { chartAccountId: accrued.id, creditCents: 400_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-04-15',
      memo: 'Settle accrual',
      lines: [
        { chartAccountId: accrued.id, debitCents: 400_000 },
        { chartAccountId: cash.id, creditCents: 400_000 },
      ],
    })

    const year = { startDate: '2026-01-01', endDate: '2026-12-31' }
    const cashBasis = await profitAndLoss(fixture.ctx, { ...year, basis: 'cash' })

    // The expense arrives, on the account the accrual said it was for, in the
    // period the money left.
    expect(cashBasis.operatingExpenses.totalCents).toBe(400_000)
    expect(cashBasis.operatingExpenses.rows.find((row) => row.number === '6400')?.balanceCents)
      .toBe(400_000)

    const balances = await cashBasisBalances(fixture.ctx, { endDate: '2026-12-31' })
    // And the accrual account itself is gone, which is the whole claim of cash
    // basis about accounts like it.
    expect(balances.find((row) => row.number === '2150')).toBeUndefined()
  })

  it('deducts a prepayment when it is paid, not when it is used', async () => {
    const fixture = await createCompanyFixture()
    const prepaid = await fixture.account('1300')
    const insurance = await fixture.account('6200')
    const cash = await fixture.account('1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-02',
      memo: 'Annual insurance premium',
      lines: [
        { chartAccountId: prepaid.id, debitCents: 1_200_000 },
        { chartAccountId: cash.id, creditCents: 1_200_000 },
      ],
    })

    for (const month of ['01', '02', '03']) {
      await postManualEntry(fixture.ctx, {
        entryDate: `2026-${month}-28`,
        memo: 'Insurance amortization',
        lines: [
          { chartAccountId: insurance.id, debitCents: 100_000 },
          { chartAccountId: prepaid.id, creditCents: 100_000 },
        ],
      })
    }

    const q1 = { startDate: '2026-01-01', endDate: '2026-03-31' }

    // Accrual: a twelfth a month.
    expect((await profitAndLoss(fixture.ctx, { ...q1, basis: 'accrual' })).operatingExpenses.totalCents)
      .toBe(300_000)

    // Cash: the whole premium, in the month the cheque cleared. Which is what
    // a cash-basis taxpayer deducts.
    expect((await profitAndLoss(fixture.ctx, { ...q1, basis: 'cash' })).operatingExpenses.totalCents)
      .toBe(1_200_000)
  })

  it('treats a deposit taken in advance as revenue when it arrives', async () => {
    const fixture = await createCompanyFixture()
    const unearned = await fixture.account('2500')
    const revenue = await fixture.account('4100')
    const cash = await fixture.account('1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      memo: 'Customer deposit',
      lines: [
        { chartAccountId: cash.id, debitCents: 500_000 },
        { chartAccountId: unearned.id, creditCents: 500_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-30',
      memo: 'Work delivered',
      lines: [
        { chartAccountId: unearned.id, debitCents: 500_000 },
        { chartAccountId: revenue.id, creditCents: 500_000 },
      ],
    })

    const february = { startDate: '2026-02-01', endDate: '2026-02-28' }

    expect((await profitAndLoss(fixture.ctx, { ...february, basis: 'accrual' })).revenue.totalCents)
      .toBe(0)
    // The same machinery upside down, and it needs no special case: the
    // basket carries its own direction.
    expect((await profitAndLoss(fixture.ctx, { ...february, basis: 'cash' })).revenue.totalCents)
      .toBe(500_000)
  })

  it('still balances after the accrual transformation', async () => {
    const fixture = await createCompanyFixture()
    const rent = await fixture.account('6400')
    const accrued = await fixture.account('2150')
    const prepaid = await fixture.account('1300')
    const insurance = await fixture.account('6200')
    const cash = await fixture.account('1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-31',
      memo: 'Accrue rent',
      lines: [
        { chartAccountId: rent.id, debitCents: 400_000 },
        { chartAccountId: accrued.id, creditCents: 400_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-02',
      memo: 'Prepay insurance',
      lines: [
        { chartAccountId: prepaid.id, debitCents: 1_200_000 },
        { chartAccountId: cash.id, creditCents: 1_200_000 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-31',
      memo: 'Amortize a month',
      lines: [
        { chartAccountId: insurance.id, debitCents: 100_000 },
        { chartAccountId: prepaid.id, creditCents: 100_000 },
      ],
    })

    const balances = await cashBasisBalances(fixture.ctx, { endDate: '2026-12-31' })
    const debits = balances.reduce((sum, row) => sum + row.debitCents, 0)
    const credits = balances.reduce((sum, row) => sum + row.creditCents, 0)

    // Removing a whole entry preserves balance trivially; replacing a leg with
    // legs that net to the same amount does too. This is that argument checked
    // rather than asserted.
    expect(debits).toBe(credits)
  })

  it('says so when it could not tell what the money was for', async () => {
    const fixture = await createCompanyFixture()
    const prepaid = await fixture.account('1300')
    const cash = await fixture.account('1000')

    // Paid and never amortized: nothing has said what it was for, so the leg
    // stays on the balance sheet instead of guessing at an expense account.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-02',
      memo: 'Prepay insurance',
      lines: [
        { chartAccountId: prepaid.id, debitCents: 1_200_000 },
        { chartAccountId: cash.id, creditCents: 1_200_000 },
      ],
    })

    const caveats = await cashBasisCaveats(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    const accrualCaveat = caveats.find((caveat) => caveat.area === 'Accruals and prepayments')
    expect(accrualCaveat).toBeDefined()
    expect(accrualCaveat?.message).toContain('$12,000.00')
    // Never a bare figure in cents — an exception nobody can read is an
    // exception nobody acts on.
    expect(accrualCaveat?.message).not.toMatch(/\b\d{4,}\b/)
  })
})

describe('an entry posted into a closed year', () => {
  it('reports the drift rather than blocking the entry', async () => {
    const fixture = await createCompanyFixture()
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4100')
    const rent = await fixture.account('6400')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-06-01',
      memo: 'Sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 900_000 },
        { chartAccountId: revenue.id, creditCents: 900_000 },
      ],
    })

    await closeFiscalYear(fixture.ctx, { closingDate: '2026-12-31' })
    expect(await staleCloses(fixture.ctx)).toHaveLength(0)

    // Closing does not lock the period — that is a separate control on
    // purpose — so this lands.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-11-15',
      memo: 'Rent invoice found late',
      lines: [
        { chartAccountId: rent.id, debitCents: 120_000 },
        { chartAccountId: cash.id, creditCents: 120_000 },
      ],
    })

    const stale = await staleCloses(fixture.ctx)
    expect(stale).toHaveLength(1)
    expect(stale[0].fiscalYear).toBe(2026)
    expect(stale[0].entriesSinceCloseCount).toBe(1)
    // The figure moved into Retained Earnings is now this much wrong.
    expect(stale[0].netIncomeDriftCents).toBe(-120_000)
  })
})
