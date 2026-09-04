import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { costCodes, invoices, journalLines, projects } from '@/db/schema'
import { addUserWithRole, createCompanyFixture, insertTransaction } from './helpers'
import {
  enabledModules,
  moduleEnabled,
  ModuleDisabledError,
  moduleStates,
  setModuleEnabled,
  terminologyFor,
} from '@/modules/industry/modules'
import { INDUSTRY_MODULES } from '@/modules/coa/industry'
import { createCostCode, installDefaultCostCodes, listCostCodes } from '@/modules/jobs/cost-codes'
import {
  approveChangeOrder,
  createChangeOrder,
  jobBudget,
  rejectChangeOrder,
  setJobBudget,
} from '@/modules/jobs/budgets'
import {
  createProgressBilling,
  priceApplication,
  releaseRetainage,
  retainageHeld,
  scheduleFor,
  setScheduleOfValues,
} from '@/modules/jobs/billing'
import { jobCostByCode, totalJobCost, wipSummary, workInProgress } from '@/modules/jobs/reports'
import {
  createSubcontractor,
  documentStatus,
  paymentCheck,
  recordComplianceDocument,
  subcontractorSummaries,
} from '@/modules/jobs/compliance'
import { createCustomer, createInvoice, createVendor, createBill } from '@/modules/receivables/service'
import { categorize } from '@/modules/bookkeeping/transactions'
import { profitAndLoss } from '@/modules/ledger/reports'
import { trialBalance } from '@/modules/ledger/balances'
import { postManualEntry } from '@/modules/ledger/journal'
import { PermissionError } from '@/modules/permissions'

/**
 * Phase 7: industry modules and construction (spec §5, §20, §23).
 *
 * The claim this phase has to earn is spec §20's: specialized workflows
 * "without forking the core ledger". The suite is arranged so that claim is
 * tested directly rather than asserted in a comment — see "the ledger did not
 * fork" at the bottom.
 */

/** A construction company with cost codes and one job, ready to cost. */
async function constructionFixture() {
  const fixture = await createCompanyFixture({ industry: 'construction' })
  await installDefaultCostCodes(fixture.ctx)

  const [job] = await db
    .insert(projects)
    .values({
      companyId: fixture.companyId,
      code: 'JOB-1001',
      name: 'Harborview Renovation',
      contractValueCents: 20_000_000,
      startDate: '2026-01-05',
    })
    .returning()

  const code = async (value: string) => {
    const [row] = await db
      .select()
      .from(costCodes)
      .where(and(eq(costCodes.companyId, fixture.companyId), eq(costCodes.code, value)))
      .limit(1)
    if (!row) throw new Error(`No cost code ${value}`)
    return row
  }

  return { ...fixture, job, code }
}

describe('the industry module registry', () => {
  it('enables what the industry pack asks for, with no configuration', async () => {
    const contractor = await createCompanyFixture({ industry: 'construction' })
    const shop = await createCompanyFixture({ industry: 'retail' })

    expect(await moduleEnabled(contractor.companyId, 'job_costing')).toBe(true)
    expect(await moduleEnabled(shop.companyId, 'job_costing')).toBe(false)
    expect(await moduleEnabled(shop.companyId, 'inventory')).toBe(true)
  })

  it('lets a company depart from its pack in either direction', async () => {
    const landscaper = await createCompanyFixture({ industry: 'general' })
    expect(await moduleEnabled(landscaper.companyId, 'job_costing')).toBe(false)

    await setModuleEnabled(landscaper.ctx, 'job_costing', true)
    expect(await moduleEnabled(landscaper.companyId, 'job_costing')).toBe(true)

    const contractor = await createCompanyFixture({ industry: 'construction' })
    await setModuleEnabled(contractor.ctx, 'job_costing', false)
    expect(await moduleEnabled(contractor.companyId, 'job_costing')).toBe(false)
  })

  it('drops the override when a module returns to its pack default', async () => {
    const contractor = await createCompanyFixture({ industry: 'construction' })

    await setModuleEnabled(contractor.ctx, 'job_costing', false)
    let states = await moduleStates(contractor.companyId)
    expect(states.find((s) => s.key === 'job_costing')?.overridden).toBe(true)

    await setModuleEnabled(contractor.ctx, 'job_costing', true)
    states = await moduleStates(contractor.companyId)
    expect(states.find((s) => s.key === 'job_costing')?.overridden).toBe(false)
    expect(states.find((s) => s.key === 'job_costing')?.enabled).toBe(true)
  })

  it('refuses job workflows when the module is off', async () => {
    const shop = await createCompanyFixture({ industry: 'retail' })

    await expect(
      createCostCode(shop.ctx, { code: '01-100', name: 'Supervision' }),
    ).rejects.toThrow(ModuleDisabledError)
  })

  it('requires company:manage to switch a module', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(setModuleEnabled(bookkeeper, 'inventory', true)).rejects.toThrow(PermissionError)
  })

  it('gives each industry its own vocabulary without changing any record', async () => {
    expect(terminologyFor('construction').job).toBe('Job')
    expect(terminologyFor('real_estate').customer).toBe('Tenant')
    expect(terminologyFor('healthcare').customer).toBe('Patient')
    expect(terminologyFor('creative').job).toBe('Production')
    // Unspecified terms fall back rather than coming back undefined.
    expect(terminologyFor('retail').customer).toBe('Customer')
  })

  it('reports every declared module, enabled or not', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })
    const states = await moduleStates(fixture.companyId)
    const enabled = await enabledModules(fixture.companyId)

    // Eleven since Phase 34 added cash drawers. Asserted against the registry
    // rather than a literal, so declaring a module without listing it here is
    // not something this test can quietly miss.
    expect(states).toHaveLength(INDUSTRY_MODULES.length)
    expect(states.map((state) => state.key).sort()).toEqual([...INDUSTRY_MODULES].sort())
    expect(enabled.has('job_costing')).toBe(true)
    expect(enabled.has('inventory')).toBe(false)
  })
})

describe('cost codes', () => {
  it('installs a starter library wired to the construction accounts', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })
    const created = await installDefaultCostCodes(fixture.ctx)

    expect(created).toBeGreaterThan(10)

    const codes = await listCostCodes(fixture.ctx)
    const carpentry = codes.find((code) => code.code === '06-100')
    const materials = await fixture.account('5110')

    expect(carpentry?.costType).toBe('labor')
    expect(codes.find((code) => code.code === '06-900')?.defaultChartAccountId).toBe(materials.id)
  })

  it('is idempotent', async () => {
    const fixture = await createCompanyFixture({ industry: 'construction' })
    await installDefaultCostCodes(fixture.ctx)
    expect(await installDefaultCostCodes(fixture.ctx)).toBe(0)
  })
})

describe('the cost code dimension', () => {
  it('carries a job and cost code from a categorized bank transaction to the ledger', async () => {
    const fixture = await constructionFixture()
    const lumber = await fixture.code('06-900')
    const materials = await fixture.account('5110')

    const transaction = await insertTransaction(fixture, {
      amountCents: -84_500,
      description: 'BUILDERS SUPPLY CO',
      merchantName: 'Builders Supply',
    })

    await categorize(fixture.ctx, transaction.id, materials.id, {
      projectId: fixture.job.id,
      costCodeId: lumber.id,
    })

    const lines = await db
      .select()
      .from(journalLines)
      .where(
        and(
          eq(journalLines.companyId, fixture.companyId),
          eq(journalLines.chartAccountId, materials.id),
        ),
      )

    expect(lines).toHaveLength(1)
    expect(lines[0].projectId).toBe(fixture.job.id)
    expect(lines[0].costCodeId).toBe(lumber.id)
    expect(lines[0].debitCents).toBe(84_500)
  })

  it('never puts a dimension on the bank side of the entry', async () => {
    const fixture = await constructionFixture()
    const lumber = await fixture.code('06-900')
    const materials = await fixture.account('5110')
    const checking = await fixture.account('1000')

    const transaction = await insertTransaction(fixture, {
      amountCents: -50_000,
      description: 'BUILDERS SUPPLY CO',
    })
    await categorize(fixture.ctx, transaction.id, materials.id, {
      projectId: fixture.job.id,
      costCodeId: lumber.id,
    })

    const [bankLine] = await db
      .select()
      .from(journalLines)
      .where(
        and(
          eq(journalLines.companyId, fixture.companyId),
          eq(journalLines.chartAccountId, checking.id),
        ),
      )

    // A checking account does not belong to a job.
    expect(bankLine.projectId).toBeNull()
  })

  it('refuses a cost code without a job', async () => {
    const fixture = await constructionFixture()
    const lumber = await fixture.code('06-900')
    const materials = await fixture.account('5110')

    const transaction = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'BUILDERS SUPPLY CO',
    })

    await expect(
      categorize(fixture.ctx, transaction.id, materials.id, { costCodeId: lumber.id }),
    ).rejects.toThrow(/cost code needs the job/i)
  })

  it('refuses a cost code belonging to another company', async () => {
    const ours = await constructionFixture()
    const theirs = await constructionFixture()
    const theirCode = await theirs.code('06-900')
    const materials = await ours.account('5110')

    await expect(
      postManualEntry(ours.ctx, {
        entryDate: '2026-03-01',
        lines: [
          {
            chartAccountId: materials.id,
            debitCents: 10_000,
            projectId: ours.job.id,
            costCodeId: theirCode.id,
          },
          { chartAccountId: (await ours.account('1000')).id, creditCents: 10_000 },
        ],
      }),
    ).rejects.toThrow(/cost codes are not on these books/i)
  })

  it('carries dimensions onto a reversing entry', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const labor = await fixture.account('5120')
    const cash = await fixture.account('1000')

    const entry = await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-01',
      memo: 'Framing crew',
      lines: [
        {
          chartAccountId: labor.id,
          debitCents: 250_000,
          projectId: fixture.job.id,
          costCodeId: framing.id,
        },
        { chartAccountId: cash.id, creditCents: 250_000 },
      ],
    })

    const { reverseEntry } = await import('@/modules/ledger/journal')
    await reverseEntry(fixture.ctx, entry.id, '2026-03-05')

    // The reversal has to land on the same job, or the job keeps the original
    // cost and loses the undo.
    const rows = await jobCostByCode(fixture.ctx, fixture.job.id)
    expect(rows.find((row) => row.code === '06-100')?.actualCents ?? 0).toBe(0)
  })
})

describe('job budgets and change orders', () => {
  it('reports budget against actual per cost code', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const labor = await fixture.account('5120')
    const cash = await fixture.account('1000')

    await setJobBudget(fixture.ctx, fixture.job.id, [
      { costCodeId: framing.id, originalAmountCents: 1_000_000 },
    ])

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      lines: [
        {
          chartAccountId: labor.id,
          debitCents: 400_000,
          projectId: fixture.job.id,
          costCodeId: framing.id,
        },
        { chartAccountId: cash.id, creditCents: 400_000 },
      ],
    })

    const rows = await jobCostByCode(fixture.ctx, fixture.job.id)
    const row = rows.find((entry) => entry.code === '06-100')!

    expect(row.originalBudgetCents).toBe(1_000_000)
    expect(row.actualCents).toBe(400_000)
    expect(row.varianceCents).toBe(600_000)
    expect(row.spentBp).toBe(4000)
  })

  it('shows cost posted without a code rather than dropping it', async () => {
    const fixture = await constructionFixture()
    const labor = await fixture.account('5120')
    const cash = await fixture.account('1000')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      lines: [
        { chartAccountId: labor.id, debitCents: 75_000, projectId: fixture.job.id },
        { chartAccountId: cash.id, creditCents: 75_000 },
      ],
    })

    const rows = await jobCostByCode(fixture.ctx, fixture.job.id)
    const unassigned = rows.find((row) => row.costCodeId === null)

    // A report that adds up to less than the ledger is the one thing this
    // must never be.
    expect(unassigned?.actualCents).toBe(75_000)
  })

  it('revises the contract and the budget on approval, and posts nothing', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')

    await setJobBudget(fixture.ctx, fixture.job.id, [
      { costCodeId: framing.id, originalAmountCents: 1_000_000 },
    ])

    const before = await trialBalance(fixture.ctx, {})

    const order = await createChangeOrder(fixture.ctx, {
      projectId: fixture.job.id,
      title: 'Additional structural work',
      contractAmountCents: 3_500_000,
      lines: [{ costCodeId: framing.id, amountCents: 2_400_000 }],
    })

    await approveChangeOrder(fixture.ctx, order.id)

    const [job] = await db.select().from(projects).where(eq(projects.id, fixture.job.id))
    expect(job.contractValueCents).toBe(23_500_000)

    const budget = await jobBudget(fixture.ctx, fixture.job.id)
    expect(budget[0].originalAmountCents).toBe(1_000_000)
    expect(budget[0].changeAmountCents).toBe(2_400_000)
    expect(budget[0].revisedAmountCents).toBe(3_400_000)

    // The ledger is untouched: no revenue is earned by agreeing to do work.
    const after = await trialBalance(fixture.ctx, {})
    expect(after.rows).toEqual(before.rows)
  })

  it('adds an approved change order to the schedule of values so it can be billed', async () => {
    const fixture = await constructionFixture()
    const revenue = await fixture.account('4200')

    await setScheduleOfValues(fixture.ctx, fixture.job.id, [
      {
        itemNumber: '1',
        description: 'Base contract',
        scheduledValueCents: 20_000_000,
        chartAccountId: revenue.id,
      },
    ])

    const order = await createChangeOrder(fixture.ctx, {
      projectId: fixture.job.id,
      title: 'Extra bathroom',
      contractAmountCents: 1_200_000,
    })
    await approveChangeOrder(fixture.ctx, order.id)

    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)
    const added = schedule.find((item) => item.changeOrderId === order.id)

    expect(added?.scheduledValueCents).toBe(1_200_000)
    expect(added?.itemNumber).toBe(`CO-${order.number}`)
  })

  it('refuses to approve the same change order twice', async () => {
    const fixture = await constructionFixture()
    const order = await createChangeOrder(fixture.ctx, {
      projectId: fixture.job.id,
      title: 'Extra work',
      contractAmountCents: 100_000,
    })

    await approveChangeOrder(fixture.ctx, order.id)
    await expect(approveChangeOrder(fixture.ctx, order.id)).rejects.toThrow(/already been approved/i)
  })

  it('leaves the contract alone when a change order is rejected', async () => {
    const fixture = await constructionFixture()
    const order = await createChangeOrder(fixture.ctx, {
      projectId: fixture.job.id,
      title: 'Declined scope',
      contractAmountCents: 900_000,
    })

    await rejectChangeOrder(fixture.ctx, order.id, { notes: 'Client withdrew' })

    const [job] = await db.select().from(projects).where(eq(projects.id, fixture.job.id))
    expect(job.contractValueCents).toBe(20_000_000)
  })

  it('keeps a budget line an approved change order touched when the estimate is re-imported', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const roofing = await fixture.code('07-100')

    await setJobBudget(fixture.ctx, fixture.job.id, [
      { costCodeId: framing.id, originalAmountCents: 500_000 },
      { costCodeId: roofing.id, originalAmountCents: 300_000 },
    ])

    const order = await createChangeOrder(fixture.ctx, {
      projectId: fixture.job.id,
      title: 'Extra roofing',
      contractAmountCents: 0,
      lines: [{ costCodeId: roofing.id, amountCents: 120_000 }],
    })
    await approveChangeOrder(fixture.ctx, order.id)

    // A corrected estimate that no longer mentions roofing.
    await setJobBudget(fixture.ctx, fixture.job.id, [
      { costCodeId: framing.id, originalAmountCents: 550_000 },
    ])

    const budget = await jobBudget(fixture.ctx, fixture.job.id)
    const roofingLine = budget.find((line) => line.costCodeId === roofing.id)

    expect(roofingLine?.changeAmountCents).toBe(120_000)
  })
})

describe('progress billing and retainage', () => {
  async function billableJob() {
    const fixture = await constructionFixture()
    const revenue = await fixture.account('4200')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await setScheduleOfValues(fixture.ctx, fixture.job.id, [
      {
        itemNumber: '1',
        description: 'Sitework',
        scheduledValueCents: 5_000_000,
        chartAccountId: revenue.id,
      },
      {
        itemNumber: '2',
        description: 'Structure',
        scheduledValueCents: 15_000_000,
        chartAccountId: revenue.id,
      },
    ])

    return { ...fixture, customer, revenue }
  }

  it('prices an application from percent complete', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    const draft = await priceApplication(fixture.ctx, {
      projectId: fixture.job.id,
      retainagePercentBp: 1000,
      lines: [
        { scheduleOfValuesId: schedule[0].id, percentCompleteBp: 10_000 },
        { scheduleOfValuesId: schedule[1].id, percentCompleteBp: 2000 },
      ],
    })

    expect(draft.thisPeriodCents).toBe(5_000_000 + 3_000_000)
    expect(draft.retainedCents).toBe(800_000)
    expect(draft.netDueCents).toBe(7_200_000)
  })

  it('splits the invoice between AR and Retainage Receivable', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    const { invoice } = await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 1000,
      lines: [{ scheduleOfValuesId: schedule[0].id, percentCompleteBp: 10_000 }],
    })

    const ar = await fixture.account('1100')
    const retainage = await fixture.account('1170')
    const balances = await trialBalance(fixture.ctx, {})
    const balanceFor = (id: string) =>
      balances.rows.find((row) => row.chartAccountId === id)?.balanceCents ?? 0

    expect(invoice.totalCents).toBe(5_000_000)
    expect(invoice.retainageCents).toBe(500_000)
    // What the customer owes now — retainage is billed but not yet due.
    expect(invoice.balanceCents).toBe(4_500_000)

    expect(balanceFor(ar.id)).toBe(4_500_000)
    expect(balanceFor(retainage.id)).toBe(500_000)
  })

  it('keeps the AR control account equal to the sum of open invoice balances', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 1000,
      lines: [
        { scheduleOfValuesId: schedule[0].id, percentCompleteBp: 10_000 },
        { scheduleOfValuesId: schedule[1].id, percentCompleteBp: 3000 },
      ],
    })

    const ar = await fixture.account('1100')
    const balances = await trialBalance(fixture.ctx, {})
    const arBalance = balances.rows.find((row) => row.chartAccountId === ar.id)?.balanceCents ?? 0

    const open = await db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, fixture.companyId))
    const subledger = open.reduce((sum, invoice) => sum + invoice.balanceCents, 0)

    // The reason retainage is handled inside createInvoice rather than by a
    // reclassifying entry afterwards: a reclass moves the ledger and leaves
    // this identity broken.
    expect(arBalance).toBe(subledger)
  })

  it('bills only the increment on the second application', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 1000,
      lines: [{ scheduleOfValuesId: schedule[1].id, percentCompleteBp: 2000 }],
    })

    const second = await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-03-31',
      billingDate: '2026-03-31',
      retainagePercentBp: 1000,
      lines: [{ scheduleOfValuesId: schedule[1].id, percentCompleteBp: 5000 }],
    })

    // 50% of 15,000,000 is 7,500,000; 3,000,000 was already billed.
    expect(second.billing.thisPeriodCents).toBe(4_500_000)
    expect(second.billing.applicationNumber).toBe(2)
  })

  it('refuses to bill past a contract item and past completion going backwards', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 0,
      lines: [{ scheduleOfValuesId: schedule[0].id, percentCompleteBp: 6000 }],
    })

    await expect(
      priceApplication(fixture.ctx, {
        projectId: fixture.job.id,
        retainagePercentBp: 0,
        lines: [{ scheduleOfValuesId: schedule[0].id, percentCompleteBp: 4000 }],
      }),
    ).rejects.toThrow(/negative amount/i)
  })

  it('refuses to remove a contract item that has been billed', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 0,
      lines: [{ scheduleOfValuesId: schedule[0].id, percentCompleteBp: 5000 }],
    })

    await expect(
      setScheduleOfValues(fixture.ctx, fixture.job.id, [
        {
          itemNumber: '2',
          description: 'Structure',
          scheduledValueCents: 15_000_000,
          chartAccountId: fixture.revenue.id,
        },
      ]),
    ).rejects.toThrow(/already been billed/i)
  })

  it('releases retainage without recognizing revenue twice', async () => {
    const fixture = await billableJob()
    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)

    await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 1000,
      lines: [{ scheduleOfValuesId: schedule[0].id, percentCompleteBp: 10_000 }],
    })

    const revenueBefore = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    expect(await retainageHeld(fixture.ctx, fixture.job.id)).toBe(500_000)

    await releaseRetainage(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: fixture.customer.id,
      billingDate: '2026-06-30',
    })

    const revenueAfter = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })

    // Revenue was recognized when the work was billed. Releasing the holdback
    // moves money from held to owed and nothing else.
    expect(revenueAfter.revenue.totalCents).toBe(revenueBefore.revenue.totalCents)
    expect(await retainageHeld(fixture.ctx, fixture.job.id)).toBe(0)

    const retainageAccount = await fixture.account('1170')
    const balances = await trialBalance(fixture.ctx, {})
    expect(
      balances.rows.find((row) => row.chartAccountId === retainageAccount.id)?.balanceCents ?? 0,
    ).toBe(0)
  })

  it('refuses to release more than is held', async () => {
    const fixture = await billableJob()

    await expect(
      releaseRetainage(fixture.ctx, {
        projectId: fixture.job.id,
        customerId: fixture.customer.id,
        billingDate: '2026-06-30',
        amountCents: 100,
      }),
    ).rejects.toThrow(/no retainage held/i)
  })

  it('withholds retainage from a subcontractor bill too', async () => {
    const fixture = await constructionFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })
    const subcontract = await fixture.account('5130')

    const bill = await createBill(fixture.ctx, {
      vendorId: vendor.id,
      issueDate: '2026-03-15',
      projectId: fixture.job.id,
      retainageCents: 120_000,
      lines: [
        { chartAccountId: subcontract.id, description: 'Rough electrical', unitPriceCents: 1_200_000 },
      ],
    })

    const ap = await fixture.account('2000')
    const retainagePayable = await fixture.account('2570')
    const balances = await trialBalance(fixture.ctx, {})
    const balanceFor = (id: string) =>
      balances.rows.find((row) => row.chartAccountId === id)?.balanceCents ?? 0

    expect(bill.balanceCents).toBe(1_080_000)
    expect(balanceFor(ap.id)).toBe(1_080_000)
    expect(balanceFor(retainagePayable.id)).toBe(120_000)
  })

  it('refuses retainage when the chart has no retainage account', async () => {
    const shop = await createCompanyFixture({ industry: 'retail' })
    const customer = await createCustomer(shop.ctx, { name: 'Walk-in' })
    const revenue = await shop.account('4000')

    await expect(
      createInvoice(shop.ctx, {
        customerId: customer.id,
        issueDate: '2026-03-01',
        retainageCents: 10_000,
        lines: [{ chartAccountId: revenue.id, description: 'Goods', unitPriceCents: 100_000 }],
      }),
    ).rejects.toThrow(/Retainage Receivable account/i)
  })

  it('refuses retainage equal to or greater than the total', async () => {
    const fixture = await billableJob()

    await expect(
      createInvoice(fixture.ctx, {
        customerId: fixture.customer.id,
        issueDate: '2026-03-01',
        retainageCents: 100_000,
        lines: [
          { chartAccountId: fixture.revenue.id, description: 'Work', unitPriceCents: 100_000 },
        ],
      }),
    ).rejects.toThrow(/less than the invoice total/i)
  })
})

describe('WIP and job profitability', () => {
  it('computes percent complete, earned revenue, and over/under billing', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const labor = await fixture.account('5120')
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4200')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    // Budget 10,000,000 against a 20,000,000 contract.
    await setJobBudget(fixture.ctx, fixture.job.id, [
      { costCodeId: framing.id, originalAmountCents: 10_000_000 },
    ])

    // 2,500,000 of cost: 25% complete.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      lines: [
        {
          chartAccountId: labor.id,
          debitCents: 2_500_000,
          projectId: fixture.job.id,
          costCodeId: framing.id,
        },
        { chartAccountId: cash.id, creditCents: 2_500_000 },
      ],
    })

    // Billed 6,000,000 — ahead of the 5,000,000 earned.
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-02-28',
      projectId: fixture.job.id,
      lines: [{ chartAccountId: revenue.id, description: 'Progress', unitPriceCents: 6_000_000 }],
    })

    const [wip] = await workInProgress(fixture.ctx, { projectId: fixture.job.id })

    expect(wip.percentCompleteBp).toBe(2500)
    expect(wip.earnedRevenueCents).toBe(5_000_000)
    expect(wip.billedToDateCents).toBe(6_000_000)
    expect(wip.overUnderBillingCents).toBe(1_000_000)
    expect(wip.estimatedGrossProfitCents).toBe(10_000_000)
  })

  it('reports unknown rather than zero percent when there is no budget', async () => {
    const fixture = await constructionFixture()
    const [wip] = await workInProgress(fixture.ctx, { projectId: fixture.job.id })

    // A fully cost-loaded job with no budget has not "earned nothing" — the
    // question is unanswerable, and 0% would be a wrong answer rather than no
    // answer.
    expect(wip.percentCompleteBp).toBeNull()
    expect(wip.earnedRevenueCents).toBe(0)
  })

  it('separates over- and under-billings instead of netting them', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const labor = await fixture.account('5120')
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4200')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    const [second] = await db
      .insert(projects)
      .values({
        companyId: fixture.companyId,
        code: 'JOB-1002',
        name: 'Mill Street Build',
        contractValueCents: 10_000_000,
      })
      .returning()

    for (const [job, budget, cost, billed] of [
      [fixture.job.id, 10_000_000, 5_000_000, 2_000_000],
      [second.id, 4_000_000, 1_000_000, 4_000_000],
    ] as const) {
      await setJobBudget(fixture.ctx, job, [
        { costCodeId: framing.id, originalAmountCents: budget },
      ])
      await postManualEntry(fixture.ctx, {
        entryDate: '2026-02-01',
        lines: [
          { chartAccountId: labor.id, debitCents: cost, projectId: job, costCodeId: framing.id },
          { chartAccountId: cash.id, creditCents: cost },
        ],
      })
      await createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-02-28',
        projectId: job,
        lines: [{ chartAccountId: revenue.id, description: 'Progress', unitPriceCents: billed }],
      })
    }

    const summary = await wipSummary(fixture.ctx)

    // Job 1: earned 10,000,000, billed 2,000,000 → underbilled 8,000,000.
    // Job 2: earned 2,500,000, billed 4,000,000 → overbilled 1,500,000.
    expect(summary.costsInExcessCents).toBe(8_000_000)
    expect(summary.billingsInExcessCents).toBe(1_500_000)
  })

  it('is refused to a role without jobs:view', async () => {
    const fixture = await constructionFixture()
    const marketer = await addUserWithRole(fixture, 'marketing')

    await expect(workInProgress(marketer)).rejects.toThrow(PermissionError)
  })
})

describe('subcontractor compliance', () => {
  it('derives status from the expiry date', () => {
    expect(documentStatus(null, '2026-08-13')).toBe('no_expiry')
    expect(documentStatus('2026-12-31', '2026-08-13')).toBe('valid')
    expect(documentStatus('2026-09-01', '2026-08-13')).toBe('expiring')
    expect(documentStatus('2026-08-01', '2026-08-13')).toBe('expired')
    // Cover that ends today does not cover an incident tomorrow morning.
    expect(documentStatus('2026-08-13', '2026-08-13')).toBe('expired')
  })

  it('reports what is missing before it reports what is expired', async () => {
    const fixture = await constructionFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })
    const sub = await createSubcontractor(fixture.ctx, { vendorId: vendor.id, trade: 'Electrical' })

    let [summary] = await subcontractorSummaries(fixture.ctx, { asOfDate: '2026-08-13' })
    expect(summary.missingKinds).toEqual(['general_liability', 'workers_comp', 'w9'])
    expect(summary.hasProblem).toBe(true)

    for (const kind of ['general_liability', 'workers_comp'] as const) {
      await recordComplianceDocument(fixture.ctx, {
        subcontractorId: sub.id,
        kind,
        carrier: 'Statewide Mutual',
        expiresOn: '2027-01-31',
      })
    }
    await recordComplianceDocument(fixture.ctx, { subcontractorId: sub.id, kind: 'w9' })

    ;[summary] = await subcontractorSummaries(fixture.ctx, { asOfDate: '2026-08-13' })
    expect(summary.missingKinds).toEqual([])
    expect(summary.hasProblem).toBe(false)
  })

  it('treats a renewed certificate filed beside the old one as current', async () => {
    const fixture = await constructionFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })
    const sub = await createSubcontractor(fixture.ctx, { vendorId: vendor.id })

    await recordComplianceDocument(fixture.ctx, {
      subcontractorId: sub.id,
      kind: 'general_liability',
      expiresOn: '2026-06-30',
    })
    await recordComplianceDocument(fixture.ctx, {
      subcontractorId: sub.id,
      kind: 'general_liability',
      expiresOn: '2027-06-30',
    })
    await recordComplianceDocument(fixture.ctx, {
      subcontractorId: sub.id,
      kind: 'workers_comp',
      expiresOn: '2027-06-30',
    })
    await recordComplianceDocument(fixture.ctx, { subcontractorId: sub.id, kind: 'w9' })

    const [summary] = await subcontractorSummaries(fixture.ctx, { asOfDate: '2026-08-13' })

    // Flagging this would train people to ignore the flag.
    expect(summary.hasProblem).toBe(false)
  })

  it('advises rather than blocks, unless somebody put a hold on', async () => {
    const fixture = await constructionFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Delta Electrical' })
    const sub = await createSubcontractor(fixture.ctx, { vendorId: vendor.id })

    const advice = await paymentCheck(fixture.ctx, vendor.id, { asOfDate: '2026-08-13' })
    expect(advice.clear).toBe(false)
    expect(advice.blocked).toBe(false)
    expect(advice.reasons.length).toBeGreaterThan(0)

    const { updateSubcontractor } = await import('@/modules/jobs/compliance')
    await updateSubcontractor(fixture.ctx, sub.id, { holdPayments: true })

    const held = await paymentCheck(fixture.ctx, vendor.id, { asOfDate: '2026-08-13' })
    expect(held.blocked).toBe(true)
  })

  it('says nothing about a vendor who is not a tracked subcontractor', async () => {
    const fixture = await constructionFixture()
    const vendor = await createVendor(fixture.ctx, { name: 'Office Supplies Inc' })

    const advice = await paymentCheck(fixture.ctx, vendor.id, { asOfDate: '2026-08-13' })
    expect(advice).toEqual({ clear: true, blocked: false, reasons: [] })
  })
})

describe('the ledger did not fork', () => {
  /**
   * Spec §20 asks for construction workflows "without forking the core
   * ledger", and spec §23 for industry customization that extends the common
   * platform. Those are testable claims, and this is the test.
   */
  it('job cost reconciles to the profit and loss', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const lumber = await fixture.code('06-900')
    const labor = await fixture.account('5120')
    const materials = await fixture.account('5110')
    const overhead = await fixture.account('6800')
    const cash = await fixture.account('1000')

    const [second] = await db
      .insert(projects)
      .values({
        companyId: fixture.companyId,
        code: 'JOB-1002',
        name: 'Mill Street Build',
        contractValueCents: 8_000_000,
      })
      .returning()

    // Cost on two jobs, with and without cost codes...
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      lines: [
        {
          chartAccountId: labor.id,
          debitCents: 900_000,
          projectId: fixture.job.id,
          costCodeId: framing.id,
        },
        {
          chartAccountId: materials.id,
          debitCents: 350_000,
          projectId: second.id,
          costCodeId: lumber.id,
        },
        { chartAccountId: labor.id, debitCents: 125_000, projectId: second.id },
        { chartAccountId: cash.id, creditCents: 1_375_000 },
      ],
    })

    // ...and overhead belonging to no job at all.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-05',
      lines: [
        { chartAccountId: overhead.id, debitCents: 200_000 },
        { chartAccountId: cash.id, creditCents: 200_000 },
      ],
    })

    const range = { startDate: '2026-01-01', endDate: '2026-12-31' }
    const pl = await profitAndLoss(fixture.ctx, range)
    const jobCost = await totalJobCost(fixture.ctx, range)

    const statementCost = pl.costOfSales.totalCents + pl.operatingExpenses.totalCents

    // Job cost is a *subset* of statement cost, and the gap is exactly the
    // unassigned overhead. If these ever disagree by anything else, something
    // has started keeping a second set of books.
    expect(jobCost).toBe(1_375_000)
    expect(statementCost - jobCost).toBe(200_000)

    // And the per-job roll-ups add back up to the same figure.
    const perJob = await workInProgress(fixture.ctx, { includeComplete: true })
    expect(perJob.reduce((sum, job) => sum + job.costToDateCents, 0)).toBe(jobCost)
  })

  it('leaves a company without job costing exactly as it was', async () => {
    const shop = await createCompanyFixture({ industry: 'retail' })
    const revenue = await shop.account('4000')
    const customer = await createCustomer(shop.ctx, { name: 'Walk-in' })

    const invoice = await createInvoice(shop.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      lines: [{ chartAccountId: revenue.id, description: 'Goods', unitPriceCents: 250_000 }],
    })

    // No retainage column in play, no dimensions, same two-line entry the
    // invoice always produced.
    expect(invoice.retainageCents).toBe(0)
    expect(invoice.balanceCents).toBe(invoice.totalCents)

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.companyId, shop.companyId))

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.projectId === null && line.costCodeId === null)).toBe(true)

    const balances = await trialBalance(shop.ctx, {})
    expect(balances.isBalanced).toBe(true)
  })

  it('keeps every entry balanced through a full construction cycle', async () => {
    const fixture = await constructionFixture()
    const framing = await fixture.code('06-100')
    const labor = await fixture.account('5120')
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4200')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview LLC' })

    await setJobBudget(fixture.ctx, fixture.job.id, [
      { costCodeId: framing.id, originalAmountCents: 12_000_000 },
    ])
    await setScheduleOfValues(fixture.ctx, fixture.job.id, [
      {
        itemNumber: '1',
        description: 'Base contract',
        scheduledValueCents: 20_000_000,
        chartAccountId: revenue.id,
        costCodeId: framing.id,
      },
    ])

    const order = await createChangeOrder(fixture.ctx, {
      projectId: fixture.job.id,
      title: 'Additional scope',
      contractAmountCents: 2_000_000,
      lines: [{ costCodeId: framing.id, amountCents: 1_400_000 }],
    })
    await approveChangeOrder(fixture.ctx, order.id)

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-02-01',
      lines: [
        {
          chartAccountId: labor.id,
          debitCents: 6_700_000,
          projectId: fixture.job.id,
          costCodeId: framing.id,
        },
        { chartAccountId: cash.id, creditCents: 6_700_000 },
      ],
    })

    const schedule = await scheduleFor(fixture.ctx, fixture.job.id)
    await createProgressBilling(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: customer.id,
      periodEnd: '2026-02-28',
      billingDate: '2026-02-28',
      retainagePercentBp: 1000,
      lines: [
        { scheduleOfValuesId: schedule[0].id, percentCompleteBp: 5000 },
        { scheduleOfValuesId: schedule[1].id, percentCompleteBp: 10_000 },
      ],
    })

    await releaseRetainage(fixture.ctx, {
      projectId: fixture.job.id,
      customerId: customer.id,
      billingDate: '2026-06-30',
    })

    const balances = await trialBalance(fixture.ctx, {})
    expect(balances.isBalanced).toBe(true)
    expect(balances.totalDebitCents).toBe(balances.totalCreditCents)
  })
})
