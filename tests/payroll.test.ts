import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { chartAccounts, journalEntries, journalLines, payrollRuns } from '@/db/schema'
import { addUserWithRole, createCompanyFixture } from './helpers'
import {
  createEmployee,
  createPayrollRun,
  NegativeNetPayError,
  payrollSummary,
  resolvePayrollAccounts,
  totalsFor,
  voidPayrollRun,
} from '@/modules/payroll/service'
import {
  getPayrollProvider,
  IllustrativePayrollProvider,
  ManualPayrollProvider,
  payrollProviderStatus,
} from '@/modules/payroll/provider'
import {
  liabilityPositions,
  listRemittances,
  recordRemittance,
} from '@/modules/payroll/remittance'
import {
  createTaxCode,
  recordDocumentTax,
  salesTaxReturn,
  taxOn,
} from '@/modules/payroll/sales-tax'
import {
  contractorPayments,
  DEFAULT_REPORTING_THRESHOLD_CENTS,
  setVendorReporting,
} from '@/modules/payroll/vendor-reporting'
import {
  FilingBlockedError,
  markFiledExternally,
  prepareFiling,
  workpaperPack,
} from '@/modules/payroll/workpapers'
import {
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import { trialBalance } from '@/modules/ledger/balances'
import { profitAndLoss } from '@/modules/ledger/reports'
import { PermissionError } from '@/modules/permissions'
import { PAYROLL_ACCOUNTS } from '@/modules/payroll/accounts'

/**
 * Phase 9: payroll and tax (spec §13, §19).
 *
 * Two claims to earn, and they pull in opposite directions.
 *
 * The first is that the *entry* is right — payroll bookkeeping is ordinary
 * double-entry and this system should be authoritative about it. See "the
 * payroll entry" below.
 *
 * The second is that the system is **not** authoritative about the tax, and
 * never quietly presents a figure it invented as one it was given. See "what
 * this system refuses to claim" at the bottom.
 */

/** A company with payroll accounts resolved and one salaried employee. */
async function payrollFixture() {
  const fixture = await createCompanyFixture()
  const accounts = await resolvePayrollAccounts(fixture.ctx)

  const employee = await createEmployee(fixture.ctx, {
    name: 'Sam Carter',
    reference: 'E-001',
    payBasis: 'salary',
    baseRateCents: 6_000_000,
    taxIdLast4: '4471',
  })

  return { ...fixture, accounts, employee }
}

/** A month of pay: 5,000.00 gross, with withholding and employer cost. */
function standardPayslip(employeeId: string) {
  return {
    employeeId,
    lines: [
      { kind: 'earning' as const, label: 'Salary', amountCents: 500_000 },
      {
        kind: 'employee_tax' as const,
        label: 'Income tax withheld',
        amountCents: 75_000,
        agency: 'Revenue authority',
      },
      {
        kind: 'employee_deduction' as const,
        label: 'Pension',
        amountCents: 25_000,
        agency: 'Pension trustee',
      },
      {
        kind: 'employer_tax' as const,
        label: 'Employer social contribution',
        amountCents: 31_000,
        agency: 'Revenue authority',
      },
    ],
  }
}

describe('payroll arithmetic', () => {
  it('separates what is withheld from what the employer pays', () => {
    const totals = totalsFor([standardPayslip('x')])

    expect(totals.grossPayCents).toBe(500_000)
    expect(totals.employeeWithholdingCents).toBe(75_000)
    expect(totals.employeeDeductionCents).toBe(25_000)
    expect(totals.employerCostCents).toBe(31_000)
    // Net is gross less what was withheld — the employer's own tax never
    // touches it.
    expect(totals.netPayCents).toBe(400_000)
  })

  it('refuses a negative amount rather than inferring a direction from it', () => {
    expect(() =>
      totalsFor([
        {
          employeeId: 'x',
          lines: [{ kind: 'employee_tax', label: 'Refund', amountCents: -1_000 }],
        },
      ]),
    ).toThrow(/negative/i)
  })

  it('refuses fractional cents', () => {
    expect(() =>
      totalsFor([
        { employeeId: 'x', lines: [{ kind: 'earning', label: 'Salary', amountCents: 1.5 }] },
      ]),
    ).toThrow(/whole numbers/i)
  })
})

describe('the payroll entry', () => {
  it('posts gross as expense, withholding as liability, and balances', async () => {
    const fixture = await payrollFixture()

    const run = await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const balances = await trialBalance(fixture.ctx, {})
    const balanceFor = (id: string) =>
      balances.rows.find((row) => row.chartAccountId === id)?.balanceCents ?? 0

    // Wages are GROSS. This is the assertion that catches the commonest
    // payroll error — booking net pay as wage cost.
    expect(balanceFor(fixture.accounts.wages)).toBe(500_000)

    // Only the employer's own tax is in payroll tax expense.
    expect(balanceFor(fixture.accounts.payrollTaxes)).toBe(31_000)

    // Withheld tax + pension + employer tax, all owed to somebody else.
    expect(balanceFor(fixture.accounts.payrollLiabilities)).toBe(75_000 + 25_000 + 31_000)

    // What the people actually receive.
    expect(balanceFor(fixture.accounts.netPayPayable)).toBe(400_000)

    expect(balances.isBalanced).toBe(true)
    expect(run.totals.netPayCents).toBe(400_000)
  })

  it('charges the employer exactly gross plus its own taxes', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The whole cost of employing somebody, and not a cent of the employee's
    // own money.
    expect(pl.operatingExpenses.totalCents).toBe(500_000 + 31_000)
  })

  it('refuses to pay somebody a negative amount', async () => {
    const fixture = await payrollFixture()

    await expect(
      createPayrollRun(fixture.ctx, {
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        payDate: '2026-03-31',
        payslips: [
          {
            employeeId: fixture.employee.id,
            lines: [
              { kind: 'earning', label: 'Salary', amountCents: 100_000 },
              { kind: 'employee_tax', label: 'Income tax', amountCents: 150_000 },
            ],
          },
        ],
      }),
    ).rejects.toThrow(NegativeNetPayError)

    // Nothing posted. An entry that balances is not the same as an entry that
    // is right.
    const entries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.companyId, fixture.companyId))

    expect(entries).toHaveLength(0)
  })

  it('never puts an expense account on a withholding line', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const { payslipLines } = await import('@/db/schema')
    const lines = await db
      .select()
      .from(payslipLines)
      .where(eq(payslipLines.companyId, fixture.companyId))

    for (const line of lines) {
      if (line.kind === 'employee_tax' || line.kind === 'employee_deduction') {
        // The structural guarantee, not just the arithmetic one.
        expect(line.expenseAccountId).toBeNull()
        expect(line.liabilityAccountId).not.toBeNull()
      }
    }
  })

  it('carries job costing dimensions onto wage cost but not onto liabilities', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })
    const accounts = await resolvePayrollAccounts(fixture.ctx)

    const { projects } = await import('@/db/schema')
    const [job] = await db
      .insert(projects)
      .values({
        companyId: fixture.companyId,
        code: 'JOB-1001',
        name: 'Harborview',
        contractValueCents: 1_000_000,
      })
      .returning()

    const employee = await createEmployee(fixture.ctx, {
      name: 'Alex Rivera',
      payBasis: 'hourly',
      baseRateCents: 4_500,
      defaultProjectId: job.id,
    })

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-07',
      payDate: '2026-03-07',
      payslips: [
        {
          employeeId: employee.id,
          hoursMilli: 40_000,
          lines: [
            { kind: 'earning', label: 'Hourly pay', amountCents: 180_000 },
            { kind: 'employee_tax', label: 'Income tax', amountCents: 27_000 },
          ],
        },
      ],
    })

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.companyId, fixture.companyId))

    const wageLine = lines.find((line) => line.chartAccountId === accounts.wages)
    const liabilityLine = lines.find(
      (line) => line.chartAccountId === accounts.payrollLiabilities,
    )

    // Labour is a job cost...
    expect(wageLine?.projectId).toBe(job.id)
    // ...but tax owed to an agency does not belong to a job.
    expect(liabilityLine?.projectId).toBeNull()
  })

  it('voids by reversing, leaving the books balanced', async () => {
    const fixture = await payrollFixture()

    const run = await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    await voidPayrollRun(fixture.ctx, run.id, 'Wrong period')

    const balances = await trialBalance(fixture.ctx, {})
    expect(balances.isBalanced).toBe(true)
    expect(
      balances.rows.find((row) => row.chartAccountId === fixture.accounts.wages)?.balanceCents ??
        0,
    ).toBe(0)
  })

  it('is refused to a role without payroll permission', async () => {
    const fixture = await payrollFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    // A bookkeeper keeps the books but does not by default see what everybody
    // is paid.
    await expect(
      createPayrollRun(bookkeeper, {
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        payDate: '2026-03-31',
        payslips: [standardPayslip(fixture.employee.id)],
      }),
    ).rejects.toThrow(PermissionError)
  })

  it('refuses to store a full tax identifier for a worker', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      createEmployee(fixture.ctx, { name: 'Sam Carter', taxIdLast4: '123456789' }),
    ).rejects.toThrow(/last four digits/i)
  })
})

describe('remitting what was withheld', () => {
  it('refuses a remittance whose kind and account disagree', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const salesTax = await fixture.account('2200')

    // This would balance perfectly and leave both accounts wrong: payroll
    // understated, sales tax overstated. Nobody notices until one of the two
    // returns is being prepared and neither foots.
    await expect(
      recordRemittance(fixture.ctx, {
        kind: 'payroll',
        agency: 'Revenue authority',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        paidOn: '2026-04-05',
        amountCents: 1_000,
        liabilityAccountId: salesTax.id,
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/payroll remittance clears 2300 or 2350/i)
  })

  it('says how much is owed in money, not in cents', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const liability = await fixture.account('2300')

    // A refusal an accountant has to divide by a hundred to read is a refusal
    // they misread under time pressure.
    await expect(
      recordRemittance(fixture.ctx, {
        kind: 'payroll',
        agency: 'Revenue authority',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        paidOn: '2026-04-05',
        amountCents: 99_999_900,
        liabilityAccountId: liability.id,
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/this remittance is \$999,999\.00/i)
  })

  it('clears the liability and touches no expense account', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const before = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    await recordRemittance(fixture.ctx, {
      kind: 'payroll',
      agency: 'Revenue authority',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      paidOn: '2026-04-15',
      amountCents: 106_000,
      liabilityAccountId: fixture.accounts.payrollLiabilities,
      financialAccountId: fixture.financialAccountId,
    })

    const after = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The cost was recognized when payroll ran. Remitting is settling a debt,
    // and booking it to expense would double-count.
    expect(after.operatingExpenses.totalCents).toBe(before.operatingExpenses.totalCents)

    const positions = await liabilityPositions(fixture.ctx, { asOfDate: '2026-04-30' })
    const payrollLiability = positions.find((entry) => entry.accountNumber === '2300')
    expect(payrollLiability?.balanceCents).toBe(131_000 - 106_000)
  })

  it('refuses to remit more than the ledger says is owed', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    // Over-remitting drives the liability negative, which reads on a balance
    // sheet as the agency owing you money.
    await expect(
      recordRemittance(fixture.ctx, {
        kind: 'payroll',
        agency: 'Revenue authority',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        paidOn: '2026-04-15',
        amountCents: 500_000,
        liabilityAccountId: fixture.accounts.payrollLiabilities,
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/owed/i)
  })

  it('refuses an account that is not a liability', async () => {
    const fixture = await payrollFixture()

    await expect(
      recordRemittance(fixture.ctx, {
        kind: 'payroll',
        agency: 'Revenue authority',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        paidOn: '2026-04-15',
        amountCents: 100,
        liabilityAccountId: fixture.accounts.wages,
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/not a liability/i)
  })

  it('clears a liability to exactly zero when fully remitted', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    await recordRemittance(fixture.ctx, {
      kind: 'payroll',
      agency: 'Revenue authority',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      paidOn: '2026-04-15',
      amountCents: 131_000,
      liabilityAccountId: fixture.accounts.payrollLiabilities,
      financialAccountId: fixture.financialAccountId,
    })

    const positions = await liabilityPositions(fixture.ctx, { asOfDate: '2026-04-30' })
    expect(positions.find((entry) => entry.accountNumber === '2300')?.balanceCents).toBe(0)

    const balances = await trialBalance(fixture.ctx, {})
    expect(balances.isBalanced).toBe(true)

    expect(await listRemittances(fixture.ctx)).toHaveLength(1)
  })
})

describe('sales tax', () => {
  it('rounds once on the total rather than per line', () => {
    // 3 × 333.33 at 8.25%: per-line rounding drifts, one rounding does not.
    expect(taxOn(99_999, 825)).toBe(8_250)
    expect(taxOn(0, 825)).toBe(0)
    expect(taxOn(10_000, 0)).toBe(0)
  })

  it('reports taxable and exempt sales per jurisdiction', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const cityTax = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'Springfield City',
      rateBp: 825,
    })
    const stateTax = await createTaxCode(fixture.ctx, {
      code: 'STATE',
      name: 'State sales tax',
      jurisdiction: 'State',
      rateBp: 400,
    })

    const first = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      taxCents: taxOn(200_000, 825),
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 200_000 }],
    })
    await recordDocumentTax(fixture.ctx, {
      documentType: 'invoice',
      documentId: first.id,
      documentDate: '2026-03-10',
      lines: [{ taxCodeId: cityTax.id, taxableCents: 200_000, exemptCents: 50_000 }],
    })

    const second = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-20',
      taxCents: taxOn(100_000, 400),
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
    })
    await recordDocumentTax(fixture.ctx, {
      documentType: 'invoice',
      documentId: second.id,
      documentDate: '2026-03-20',
      lines: [{ taxCodeId: stateTax.id, taxableCents: 100_000 }],
    })

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })

    expect(report.lines).toHaveLength(2)

    const city = report.lines.find((line) => line.jurisdiction === 'Springfield City')!
    expect(city.taxableCents).toBe(200_000)
    // Exempt sales belong on a return too — most of them ask.
    expect(city.exemptCents).toBe(50_000)
    expect(city.taxCollectedCents).toBe(16_500)

    expect(report.totalTaxCollectedCents).toBe(16_500 + 4_000)
    // The ledger holds the same tax the invoices charged.
    expect(report.ledgerBalanceCents).toBe(16_500 + 4_000)
    expect(report.varianceCents).toBe(0)
  })

  it("prices an invoice's tax from its codes and records the breakdown with it", async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const cityTax = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'Springfield City',
      rateBp: 825,
    })
    const stateTax = await createTaxCode(fixture.ctx, {
      code: 'STATE',
      name: 'State sales tax',
      jurisdiction: 'State',
      rateBp: 400,
    })

    // No taxCents passed. The invoice prices its own tax from the codes.
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 300_000 }],
      taxLines: [
        { taxCodeId: cityTax.id, taxableCents: 200_000, exemptCents: 50_000 },
        { taxCodeId: stateTax.id, taxableCents: 100_000 },
      ],
    })

    expect(invoice.taxCents).toBe(16_500 + 4_000)
    expect(invoice.totalCents).toBe(300_000 + 16_500 + 4_000)

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })

    // The header and the breakdown foot to each other, because one read of the
    // codes produced both inside one transaction.
    expect(report.totalTaxCollectedCents).toBe(invoice.taxCents)
    expect(report.ledgerBalanceCents).toBe(invoice.taxCents)
    expect(report.varianceCents).toBe(0)
    expect(report.hasUncodedSales).toBe(false)

    const city = report.lines.find((line) => line.jurisdiction === 'Springfield City')!
    expect(city.exemptCents).toBe(50_000)
  })

  it('leaves an invoice untouched when a tax code is not this company’s', async () => {
    const fixture = await createCompanyFixture()
    const other = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const foreign = await createTaxCode(other.ctx, {
      code: 'ELSEWHERE',
      name: 'Somebody else’s tax',
      jurisdiction: 'Elsewhere',
      rateBp: 500,
    })

    await expect(
      createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-03-10',
        lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 100_000 }],
        taxLines: [{ taxCodeId: foreign.id, taxableCents: 100_000 }],
      }),
    ).rejects.toThrow(/not on this company/i)

    // Refused before anything was written, so there is no half-issued invoice.
    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })
    expect(report.uncodedSalesCents).toBe(0)
    expect(report.ledgerBalanceCents).toBe(0)
  })

  it('flags sales that carry no tax code at all', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 300_000 }],
    })

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })

    // Sales on no jurisdiction's return is exactly what an accountant needs
    // told, rather than a silently short figure.
    expect(report.hasUncodedSales).toBe(true)
    expect(report.uncodedSalesCents).toBe(300_000)
  })

  it('freezes the rate onto the document so a later change cannot restate it', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const code = await createTaxCode(fixture.ctx, {
      code: 'CITY',
      name: 'City sales tax',
      jurisdiction: 'Springfield City',
      rateBp: 800,
    })

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-10',
      taxCents: 16_000,
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 200_000 }],
    })
    await recordDocumentTax(fixture.ctx, {
      documentType: 'invoice',
      documentId: invoice.id,
      documentDate: '2026-03-10',
      lines: [{ taxCodeId: code.id, taxableCents: 200_000 }],
    })

    const { taxCodes } = await import('@/db/schema')
    await db.update(taxCodes).set({ rateBp: 900 }).where(eq(taxCodes.id, code.id))

    const report = await salesTaxReturn(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    })

    // Last quarter's return does not move because this quarter's rate did.
    expect(report.lines[0].rateBp).toBe(800)
    expect(report.lines[0].taxCollectedCents).toBe(16_000)
  })

  it('refuses a rate outside 0–100%', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      createTaxCode(fixture.ctx, {
        code: 'BAD',
        name: 'Impossible',
        jurisdiction: 'Nowhere',
        rateBp: 12_000,
      }),
    ).rejects.toThrow(/between 0% and 100%/i)
  })
})

describe('contractor reporting', () => {
  it('counts what was paid in the year, not what was billed', async () => {
    const fixture = await createCompanyFixture({ industry: 'professional_services' })
    const expense = await fixture.account('5250')
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })

    await setVendorReporting(fixture.ctx, vendor.id, {
      isReportable: true,
      taxId: '12-3456789',
    })

    const { createBill } = await import('@/modules/receivables/service')
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-11-01',
      lines: [{ chartAccountId: expense.id, description: 'Wiring', unitPriceCents: 400_000 }],
    })

    // Billed in 2026, paid in 2026: reportable for 2026.
    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-12-15',
      amountCents: 250_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 250_000 }],
    })

    const report = await contractorPayments(fixture.ctx, { year: 2026 })
    const row = report.rows.find((entry) => entry.vendorId === vendor.id)!

    // The 400,000 was billed; only the 250,000 paid is reportable.
    expect(row.paidCents).toBe(250_000)
    expect(row.meetsThreshold).toBe(true)
    expect(row.blockers).toEqual([])

    // And the following year sees nothing.
    const next = await contractorPayments(fixture.ctx, { year: 2027 })
    expect(next.rows.find((entry) => entry.vendorId === vendor.id)?.paidCents ?? 0).toBe(0)
  })

  it('says what is stopping a filing rather than only the figure', async () => {
    const fixture = await createCompanyFixture({ industry: 'professional_services' })
    const expense = await fixture.account('5250')
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })

    await setVendorReporting(fixture.ctx, vendor.id, { isReportable: true })

    const { createBill } = await import('@/modules/receivables/service')
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-02-01',
      lines: [{ chartAccountId: expense.id, description: 'Wiring', unitPriceCents: 300_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-02-10',
      amountCents: 300_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 300_000 }],
    })

    const report = await contractorPayments(fixture.ctx, { year: 2026 })
    const row = report.rows.find((entry) => entry.vendorId === vendor.id)!

    // The missing identifier is what actually stops a filing in January.
    expect(row.blockers).toContain('No tax identifier on file.')
    expect(report.needsAttentionCount).toBe(1)
  })

  it('flags somebody paid over the threshold who was never marked reportable', async () => {
    const fixture = await createCompanyFixture({ industry: 'professional_services' })
    const expense = await fixture.account('5250')
    const vendor = await createVendor(fixture.ctx, { name: 'Casual Labour Co' })

    const { createBill } = await import('@/modules/receivables/service')
    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-02-01',
      lines: [{ chartAccountId: expense.id, description: 'Help', unitPriceCents: 200_000 }],
    })
    await recordPayment(fixture.ctx, {
      kind: 'disbursement',
      vendorId: vendor.id,
      paymentDate: '2026-02-10',
      amountCents: 200_000,
      financialAccountId: fixture.financialAccountId,
      applications: [{ billId: bill.id, amountCents: 200_000 }],
    })

    const report = await contractorPayments(fixture.ctx, { year: 2026 })
    const row = report.rows.find((entry) => entry.vendorId === vendor.id)!

    expect(row.paidCents).toBeGreaterThan(DEFAULT_REPORTING_THRESHOLD_CENTS)
    expect(row.blockers[0]).toMatch(/not marked reportable/i)
  })

  it('never writes a tax identifier into the audit log', async () => {
    const fixture = await createCompanyFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })

    await setVendorReporting(fixture.ctx, vendor.id, {
      isReportable: true,
      taxId: '99-8887777',
    })

    const { historyFor } = await import('@/modules/audit')
    const history = await historyFor(fixture.ctx, 'vendor', vendor.id)
    const serialized = JSON.stringify(history)

    // An audit log is read by everyone with `audit:view`.
    expect(serialized).not.toContain('99-8887777')
    expect(serialized).toContain('hasTaxId')
  })
})

describe('what this system refuses to claim', () => {
  it('has no calculating provider as its default', () => {
    const provider = getPayrollProvider('manual')

    expect(provider).toBeInstanceOf(ManualPayrollProvider)
    // The honest default: it does not work out anybody's tax.
    expect(provider.calculates).toBe(false)
  })

  it('tells you plainly when asked to calculate and cannot', async () => {
    const result = await new ManualPayrollProvider().calculate()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/does not calculate/i)
  })

  it('marks illustrative figures as illustrative, in the database', async () => {
    const fixture = await payrollFixture()
    const provider = new IllustrativePayrollProvider()

    const calculated = await provider.calculate({
      companyId: fixture.companyId,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      employees: [
        {
          id: fixture.employee.id,
          name: 'Sam Carter',
          payBasis: 'salary',
          baseRateCents: 6_000_000,
        },
      ],
    })

    expect(calculated.ok).toBe(true)
    if (!calculated.ok) return

    expect(calculated.illustrative).toBe(true)
    expect(calculated.notice).toMatch(/not the tax rates of any jurisdiction/i)

    const run = await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      sourceProvider: 'illustrative',
      isIllustrative: true,
      payslips: calculated.payslips.map((payslip) => ({
        employeeId: payslip.employeeId,
        lines: payslip.lines,
      })),
    })

    const [stored] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, run.id))

    // Stored on the row, so a report can refuse to present it as real.
    expect(stored.isIllustrative).toBe(true)
    expect(stored.sourceProvider).toBe('illustrative')

    const summary = await payrollSummary(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(summary.illustrativeRuns).toBe(1)
  })

  it('throws rather than silently substituting an unknown payroll provider', () => {
    // Every other registry in this codebase falls back to a mock. Here,
    // quietly swapping the source of payroll figures is the failure.
    expect(() => getPayrollProvider('nonexistent')).toThrow(/Unknown payroll provider/i)

    const status = payrollProviderStatus()
    expect(status.find((entry) => entry.key === 'manual')?.calculates).toBe(false)
    expect(status.find((entry) => entry.key === 'illustrative')?.calculates).toBe(true)
  })

  it('refuses to prepare a filing from illustrative payroll figures', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      sourceProvider: 'illustrative',
      isIllustrative: true,
      payslips: [standardPayslip(fixture.employee.id)],
    })

    await expect(
      prepareFiling(fixture.ctx, {
        kind: 'payroll',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        figures: {},
      }),
    ).rejects.toThrow(FilingBlockedError)
  })

  it('allows an override, and records who overrode what', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      sourceProvider: 'illustrative',
      isIllustrative: true,
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const filing = await prepareFiling(fixture.ctx, {
      kind: 'payroll',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      figures: { grossPayCents: 500_000 },
      overrideReason: 'Demo data — not being filed.',
    })

    const figures = filing.figures as Record<string, unknown>
    expect(figures.overrideReason).toBe('Demo data — not being filed.')
    // The exceptions travel with the figures, so a return questioned later
    // shows what was known to be wrong when it was prepared.
    expect(Array.isArray(figures.exceptions)).toBe(true)
  })

  it('has no status that claims the system filed anything', async () => {
    const fixture = await createCompanyFixture()

    const filing = await prepareFiling(fixture.ctx, {
      kind: 'sales_tax',
      jurisdiction: 'State',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      figures: { totalTaxCollectedCents: 0 },
    })

    expect(filing.status).toBe('prepared')

    await markFiledExternally(fixture.ctx, filing.id, {
      filedOn: '2026-04-20',
      note: 'Filed on the state portal, confirmation 88213.',
    })

    const { taxFilings } = await import('@/db/schema')
    const [updated] = await db.select().from(taxFilings).where(eq(taxFilings.id, filing.id))

    // `filed_externally`, never `filed`. A human filed it; this recorded that.
    expect(updated.status).toBe('filed_externally')
    expect(updated.filedNote).toContain('88213')
  })

  it('insists on a note when marking something filed', async () => {
    const fixture = await createCompanyFixture()

    const filing = await prepareFiling(fixture.ctx, {
      kind: 'sales_tax',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      figures: {},
    })

    await expect(
      markFiledExternally(fixture.ctx, filing.id, { filedOn: '2026-04-20', note: '   ' }),
    ).rejects.toThrow(/where it was filed/i)
  })
})

describe('the workpaper pack', () => {
  it('reports the exceptions, not just the figures', async () => {
    const fixture = await payrollFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    // An invoice with no tax code: a real gap a return would miss.
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-15',
      lines: [{ chartAccountId: revenue.id, description: 'Work', unitPriceCents: 400_000 }],
    })

    const pack = await workpaperPack(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(pack.ledger.isBalanced).toBe(true)
    expect(pack.payroll.grossPayCents).toBe(500_000)
    expect(pack.payroll.totalCostCents).toBe(531_000)

    const uncoded = pack.exceptions.find((entry) => entry.area === 'sales_tax')
    expect(uncoded?.message).toMatch(/carry no tax code/i)

    // Net pay was posted but never disbursed, which is worth saying at a
    // year end.
    const netPay = pack.exceptions.find((entry) => entry.message.includes('Net Pay Payable'))
    expect(netPay?.severity).toBe('warning')

    // Every amount in an exception reads as money. An accountant scanning this
    // list should not have to divide by a hundred in their head, and a bare
    // integer beside a sentence about a return is easy to read as a count.
    for (const exception of pack.exceptions) {
      expect(exception.message).not.toMatch(/(?<![$.\d])\d{4,}/)
    }
    expect(uncoded?.message).toContain('$4,000.00')
  })

  it('ties payroll cost back to the ledger', async () => {
    const fixture = await payrollFixture()

    await createPayrollRun(fixture.ctx, {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
      payslips: [standardPayslip(fixture.employee.id)],
    })

    const pack = await workpaperPack(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // The payroll summary is read from the runs and the P&L from the journal.
    // They are different queries over different tables, and if they ever
    // disagree the pack is worthless — so the pack asserts it.
    expect(pack.payroll.totalCostCents).toBe(
      pack.ledger.operatingExpenseCents + pack.ledger.costOfSalesCents,
    )
  })

  it('needs financial reporting permission, not just tax view', async () => {
    const fixture = await payrollFixture()
    const sales = await addUserWithRole(fixture, 'sales')

    await expect(
      workpaperPack(sales, { startDate: '2026-01-01', endDate: '2026-12-31' }),
    ).rejects.toThrow(PermissionError)
  })
})

describe('payroll accounts', () => {
  it('creates Net Pay Payable on first use rather than demanding it upfront', async () => {
    const fixture = await createCompanyFixture()

    const before = await db
      .select()
      .from(chartAccounts)
      .where(
        and(
          eq(chartAccounts.companyId, fixture.companyId),
          eq(chartAccounts.number, PAYROLL_ACCOUNTS.netPayPayable),
        ),
      )
    expect(before).toHaveLength(0)

    const accounts = await resolvePayrollAccounts(fixture.ctx)
    expect(accounts.netPayPayable).toBeTruthy()

    // Idempotent: a second run does not create a second account.
    await resolvePayrollAccounts(fixture.ctx)
    const after = await db
      .select()
      .from(chartAccounts)
      .where(
        and(
          eq(chartAccounts.companyId, fixture.companyId),
          eq(chartAccounts.number, PAYROLL_ACCOUNTS.netPayPayable),
        ),
      )
    expect(after).toHaveLength(1)
  })
})
