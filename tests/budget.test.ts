import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { budgetLines, journalEntries } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { postManualEntry } from '@/modules/ledger/journal'
import { profitAndLoss } from '@/modules/ledger/reports'
import {
  BudgetError,
  approveBudget,
  budgetForYear,
  budgetGrid,
  clearAccountBudget,
  copyFromActuals,
  createBudget,
  listBudgets,
  monthRange,
  setAccountBudget,
  spreadFor,
  varianceFor,
} from '@/modules/budget/service'
import { budgetVsActual, monthsCovered } from '@/modules/budget/reporting'
import { INTEGRITY_CHECKS } from '@/modules/integrity/register'

/**
 * A plan, and whether missing it is good news (Phase 36).
 *
 * Five claims under test:
 *
 *  1. **A budget is a plan, not a second ledger.** Nothing here ever posts.
 *  2. **Spreading has a remainder and the remainder is placed**, so the months
 *     always sum back to the year.
 *  3. **A variance is signed by what the account is for.** Under on revenue is
 *     bad; under on expenses is good; a report showing both as "-$500" says
 *     nothing.
 *  4. **An unbudgeted account is not an account budgeted at zero**, and is
 *     reported as the different thing it is.
 *  5. **The actuals come from the Profit & Loss itself**, so the two cannot
 *     disagree.
 */

async function co(name = 'Larkfield Joinery'): Promise<Fixture> {
  return createCompanyFixture({ name, industry: 'general' })
}

/** Posts revenue and an expense into a month, so there are actuals to compare. */
async function trade(
  fixture: Fixture,
  input: { on: string; revenueCents?: number; expenseCents?: number },
) {
  const bank = await fixture.account('1000')
  const revenue = await fixture.account('4000')
  const rent = await fixture.account('6400')

  if (input.revenueCents) {
    await postManualEntry(fixture.ctx, {
      entryDate: input.on,
      memo: 'Sales',
      lines: [
        { chartAccountId: bank.id, debitCents: input.revenueCents },
        { chartAccountId: revenue.id, creditCents: input.revenueCents },
      ],
    })
  }

  if (input.expenseCents) {
    await postManualEntry(fixture.ctx, {
      entryDate: input.on,
      memo: 'Rent',
      lines: [
        { chartAccountId: rent.id, debitCents: input.expenseCents },
        { chartAccountId: bank.id, creditCents: input.expenseCents },
      ],
    })
  }
}

describe('spreading a year across its months (Phase 36)', () => {
  it('places the remainder rather than dropping it', () => {
    // $10,000 across twelve is $833.33 twelve times, which is $9,999.96. The
    // four cents have to go somewhere.
    const months = spreadFor({ annualCents: 1_000_000, periods: 12, method: 'even' })

    expect(months).toHaveLength(12)
    expect(months.reduce((sum, cents) => sum + cents, 0)).toBe(1_000_000)
    expect(months.slice(0, 4)).toEqual([83_334, 83_334, 83_334, 83_334])
    expect(months.slice(4)).toEqual(Array(8).fill(83_333))
  })

  it('divides exactly when it divides exactly', () => {
    const months = spreadFor({ annualCents: 1_200_000, periods: 12, method: 'even' })
    expect(new Set(months)).toEqual(new Set([100_000]))
  })

  it('carries the sign through, because a contra account is genuinely negative', () => {
    const months = spreadFor({ annualCents: -1_000_000, periods: 12, method: 'even' })
    expect(months.reduce((sum, cents) => sum + cents, 0)).toBe(-1_000_000)
    expect(months.every((cents) => cents < 0)).toBe(true)
  })

  it('weights the months, and still sums to the year', () => {
    // A business that does half its trade in December.
    const weights = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12]
    const months = spreadFor({ annualCents: 1_000_000, periods: 12, method: 'weighted', weights })

    expect(months.reduce((sum, cents) => sum + cents, 0)).toBe(1_000_000)
    expect(months[11]).toBeGreaterThan(months[0] * 10)
  })

  it('gives the leftover cents to the periods that lost the most to rounding', () => {
    // Earliest-first would systematically favour January in a seasonal
    // business, which is the one thing a weighted spread exists to avoid.
    const months = spreadFor({
      annualCents: 100,
      periods: 3,
      method: 'weighted',
      weights: [1, 1, 4],
    })

    expect(months.reduce((sum, cents) => sum + cents, 0)).toBe(100)
    expect(months).toEqual([17, 17, 66])
  })

  it('lets a period get nothing, because some businesses shut in January', () => {
    const months = spreadFor({
      annualCents: 1_200_00,
      periods: 3,
      method: 'weighted',
      weights: [0, 1, 1],
    })

    expect(months[0]).toBe(0)
    expect(months.reduce((sum, cents) => sum + cents, 0)).toBe(1_200_00)
  })

  it('refuses weights that are fractions, negative, or the wrong number of them', () => {
    const base = { annualCents: 1_000, periods: 3, method: 'weighted' as const }
    expect(() => spreadFor({ ...base, weights: [1, 1] })).toThrow(BudgetError)
    expect(() => spreadFor({ ...base, weights: [1, 1, -1] })).toThrow(BudgetError)
    expect(() => spreadFor({ ...base, weights: [1, 1, 1.5] })).toThrow(/whole numbers/)
    expect(() => spreadFor({ ...base, weights: [0, 0, 0] })).toThrow(/every weight is zero/i)
  })

  it('refuses a figure finer than the ledger can record', () => {
    expect(() =>
      spreadFor({ annualCents: 1_000.5, periods: 12, method: 'even' }),
    ).toThrow(BudgetError)
  })

  it('knows the length of a month without a table', () => {
    expect(monthRange(2026, 2)).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' })
    // A leap year, which is where a hand-rolled table goes wrong.
    expect(monthRange(2028, 2).endDate).toBe('2028-02-29')
    expect(monthRange(2026, 12)).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' })
  })
})

describe('whether missing the plan is good news (Phase 36)', () => {
  it('reads under on revenue as bad and under on expenses as good', () => {
    // The claim the whole function exists to make. Both are "-$500"; only one
    // is a problem, and a report that shows them identically says nothing.
    const revenue = varianceFor({ budgetCents: 10_000_00, actualCents: 9_500_00, type: 'revenue' })
    const expense = varianceFor({ budgetCents: 10_000_00, actualCents: 9_500_00, type: 'expense' })

    expect(revenue.varianceCents).toBe(-500_00)
    expect(expense.varianceCents).toBe(-500_00)
    expect(revenue.favourable).toBe(false)
    expect(expense.favourable).toBe(true)
  })

  it('reads over the same way round', () => {
    expect(
      varianceFor({ budgetCents: 100, actualCents: 150, type: 'revenue' }).favourable,
    ).toBe(true)
    expect(varianceFor({ budgetCents: 100, actualCents: 150, type: 'cogs' }).favourable).toBe(false)
    expect(
      varianceFor({ budgetCents: 100, actualCents: 150, type: 'other_income' }).favourable,
    ).toBe(true)
    expect(
      varianceFor({ budgetCents: 100, actualCents: 150, type: 'other_expense' }).favourable,
    ).toBe(false)
  })

  it('calls exactly on plan favourable rather than adverse', () => {
    // Not news, and a screen that paints a met budget red is one nobody trusts.
    expect(varianceFor({ budgetCents: 500, actualCents: 500, type: 'revenue' }).favourable).toBe(
      true,
    )
    expect(varianceFor({ budgetCents: 500, actualCents: 500, type: 'expense' }).favourable).toBe(
      true,
    )
  })

  it('refuses to express a percentage of nothing', () => {
    // Spending $400 against a plan of nothing is infinitely over, which is not
    // a number anybody can use.
    expect(varianceFor({ budgetCents: 0, actualCents: 400_00, type: 'expense' }).basisPoints).toBe(
      null,
    )
    expect(
      varianceFor({ budgetCents: 10_000, actualCents: 11_000, type: 'expense' }).basisPoints,
    ).toBe(1_000)
  })
})

describe('a budget that posts nothing (Phase 36)', () => {
  it('writes no journal entry, ever', async () => {
    // The claim the schema note is about: this is the first table holding
    // money that the trial balance has never heard of.
    const fixture = await co()
    const revenue = await fixture.account('4000')

    const before = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, fixture.companyId))

    const budget = await createBudget(fixture.ctx, { name: '2026 Approved', fiscalYear: 2026 })
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      annualCents: 1_200_000,
    })
    await approveBudget(fixture.ctx, budget.id)

    const after = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, fixture.companyId))

    expect(after).toHaveLength(before.length)

    // And the profit and loss is untouched by a plan.
    const report = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(report.netIncomeCents).toBe(0)
  })

  it('writes all twelve months, including the zeros', async () => {
    // A missing row and a row of zero mean different things to the variance
    // report, so an account deliberately planned to nothing in August has to
    // read as planned.
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })

    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      annualCents: 1_100_000,
      method: 'weighted',
      weights: [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1],
    })

    const rows = await db
      .select()
      .from(budgetLines)
      .where(and(eq(budgetLines.budgetId, budget.id), eq(budgetLines.chartAccountId, revenue.id)))

    expect(rows).toHaveLength(12)
    expect(rows.find((row) => row.month === 7)!.amountCents).toBe(0)
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(1_100_000)
  })

  it('refuses a second budget with the same name in the same year', async () => {
    const fixture = await co()
    await createBudget(fixture.ctx, { name: '2026 Approved', fiscalYear: 2026 })

    await expect(
      createBudget(fixture.ctx, { name: '2026 Approved', fiscalYear: 2026 }),
    ).rejects.toThrow(/already has a budget/)

    // A differently named revision is fine — that is the point of the name.
    await expect(
      createBudget(fixture.ctx, { name: '2026 Revised', fiscalYear: 2026 }),
    ).resolves.toBeTruthy()
  })

  it('refuses both a yearly figure and the months at once', async () => {
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })

    await expect(
      setAccountBudget(fixture.ctx, {
        budgetId: budget.id,
        chartAccountId: revenue.id,
        annualCents: 100,
        monthlyCents: Array(12).fill(10),
      }),
    ).rejects.toThrow(/not both and not neither/)

    await expect(
      setAccountBudget(fixture.ctx, { budgetId: budget.id, chartAccountId: revenue.id }),
    ).rejects.toThrow(/not both and not neither/)
  })

  it('takes the twelve months as typed', async () => {
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })

    const monthlyCents = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => n * 1_000_00)
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      monthlyCents,
    })

    const grid = await budgetGrid(fixture.ctx, budget.id)
    expect(grid.rows[0].monthlyCents).toEqual(monthlyCents)
    // Revenue, so it lands on the income side and never gets added to a cost.
    expect(grid.incomeCents).toBe(78_000_00)
    expect(grid.costCents).toBe(0)
    expect(grid.netCents).toBe(78_000_00)
  })

  it('archives the previously approved budget so the plan is never ambiguous', async () => {
    const fixture = await co()
    const first = await createBudget(fixture.ctx, { name: '2026 Approved', fiscalYear: 2026 })
    const second = await createBudget(fixture.ctx, { name: '2026 Revised', fiscalYear: 2026 })

    await approveBudget(fixture.ctx, first.id)
    await approveBudget(fixture.ctx, second.id)

    const rows = await listBudgets(fixture.ctx)
    expect(rows.find((row) => row.id === first.id)!.status).toBe('archived')
    expect(rows.find((row) => row.id === second.id)!.status).toBe('approved')

    const chosen = await budgetForYear(fixture.ctx, 2026)
    expect(chosen!.id).toBe(second.id)
  })

  it('will not change an archived budget', async () => {
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const first = await createBudget(fixture.ctx, { name: '2026 Approved', fiscalYear: 2026 })
    const second = await createBudget(fixture.ctx, { name: '2026 Revised', fiscalYear: 2026 })

    await approveBudget(fixture.ctx, first.id)
    await approveBudget(fixture.ctx, second.id)

    await expect(
      setAccountBudget(fixture.ctx, {
        budgetId: first.id,
        chartAccountId: revenue.id,
        annualCents: 100,
      }),
    ).rejects.toThrow(/archived/)
  })

  it('clears an account rather than budgeting it to zero', async () => {
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })

    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      annualCents: 1_200_000,
    })
    await clearAccountBudget(fixture.ctx, { budgetId: budget.id, chartAccountId: revenue.id })

    const grid = await budgetGrid(fixture.ctx, budget.id)
    expect(grid.rows).toHaveLength(0)
  })

  it('needs the journal permission to write a plan', async () => {
    const fixture = await createCompanyFixture({ name: 'Read Only Co', role: 'readonly' })

    await expect(
      createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 }),
    ).rejects.toThrow(PermissionError)
  })

  it('keeps one company’s plan off another’s books', async () => {
    const mine = await co('Mine')
    const theirs = await co('Theirs')

    await createBudget(mine.ctx, { name: '2026', fiscalYear: 2026 })

    expect(await listBudgets(theirs.ctx)).toHaveLength(0)
    expect(await budgetForYear(theirs.ctx, 2026)).toBeNull()
  })
})

describe('building a plan from what happened (Phase 36)', () => {
  it('copies last year month by month, so the seasonality survives', async () => {
    const fixture = await co()
    await trade(fixture, { on: '2025-03-15', revenueCents: 1_000_00 })
    await trade(fixture, { on: '2025-11-15', revenueCents: 9_000_00 })

    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })
    const result = await copyFromActuals(fixture.ctx, { budgetId: budget.id, sourceYear: 2025 })

    expect(result.accounts).toBe(1)

    const grid = await budgetGrid(fixture.ctx, budget.id)
    // March and November, not a twelfth each — spreading the year evenly is
    // exactly the information last year knows and a copy would throw away.
    expect(grid.rows[0].monthlyCents[2]).toBe(1_000_00)
    expect(grid.rows[0].monthlyCents[10]).toBe(9_000_00)
    expect(grid.rows[0].monthlyCents[0]).toBe(0)
    expect(grid.incomeCents).toBe(10_000_00)
  })

  it('applies a flat uplift in basis points', async () => {
    const fixture = await co()
    await trade(fixture, { on: '2025-03-15', revenueCents: 1_000_00 })

    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })
    await copyFromActuals(fixture.ctx, {
      budgetId: budget.id,
      sourceYear: 2025,
      upliftBasisPoints: 500,
    })

    const grid = await budgetGrid(fixture.ctx, budget.id)
    expect(grid.rows[0].monthlyCents[2]).toBe(1_050_00)
  })

  it('refuses a source year with no trading rather than writing a budget of nothing', async () => {
    const fixture = await co()
    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })

    await expect(
      copyFromActuals(fixture.ctx, { budgetId: budget.id, sourceYear: 2019 }),
    ).rejects.toThrow(/nothing on the profit and loss/)
  })
})

describe('the plan against what happened (Phase 36)', () => {
  async function planned(fixture: Fixture) {
    const revenue = await fixture.account('4000')
    const rent = await fixture.account('6400')
    const budget = await createBudget(fixture.ctx, { name: '2026 Approved', fiscalYear: 2026 })

    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      annualCents: 1_200_000,
    })
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: rent.id,
      annualCents: 240_000,
    })
    await approveBudget(fixture.ctx, budget.id)

    return { budget, revenue, rent }
  }

  it('names a revenue shortfall adverse and an expense saving favourable', async () => {
    const fixture = await co()
    await planned(fixture)

    // Planned $1,000/month revenue and $200/month rent for January.
    await trade(fixture, { on: '2026-01-15', revenueCents: 900_00, expenseCents: 150_00 })

    const report = await budgetVsActual(fixture.ctx, {
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })

    expect(report.months).toEqual([1])
    expect(report.revenue.budgetCents).toBe(1_000_00)
    expect(report.revenue.actualCents).toBe(900_00)
    expect(report.revenue.favourable).toBe(false)

    expect(report.operatingExpenses.budgetCents).toBe(200_00)
    expect(report.operatingExpenses.actualCents).toBe(150_00)
    expect(report.operatingExpenses.favourable).toBe(true)

    // Both variances are negative; only one is a problem.
    expect(report.revenue.varianceCents).toBe(-100_00)
    expect(report.operatingExpenses.varianceCents).toBe(-50_00)
  })

  it('agrees with the Profit & Loss it is built on', async () => {
    // Not two queries that filter the same way — the same function.
    const fixture = await co()
    await planned(fixture)
    await trade(fixture, { on: '2026-02-10', revenueCents: 1_450_00, expenseCents: 275_00 })

    const range = { startDate: '2026-01-01', endDate: '2026-12-31' }
    const [report, statement] = await Promise.all([
      budgetVsActual(fixture.ctx, { fiscalYear: 2026, ...range }),
      profitAndLoss(fixture.ctx, range),
    ])

    expect(report.revenue.actualCents).toBe(statement.revenue.totalCents)
    expect(report.operatingExpenses.actualCents).toBe(statement.operatingExpenses.totalCents)
    expect(report.netIncome.actualCents).toBe(statement.netIncomeCents)
  })

  it('reports an unbudgeted account as unbudgeted, not as 100% over', async () => {
    // $400 of legal fees nobody planned for is a fact worth surfacing. Showing
    // it as "budget $0, 100% over" buries it among the rows that merely drifted.
    const fixture = await co()
    await planned(fixture)

    const bank = await fixture.account('1000')
    const legal = await fixture.account('6300')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-20',
      memo: 'Solicitor',
      lines: [
        { chartAccountId: legal.id, debitCents: 400_00 },
        { chartAccountId: bank.id, creditCents: 400_00 },
      ],
    })

    const report = await budgetVsActual(fixture.ctx, {
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })

    expect(report.unbudgeted.map((row) => row.number)).toEqual(['6300'])
    expect(report.unbudgetedCostCents).toBe(400_00)
    expect(report.unbudgetedIncomeCents).toBe(0)
    // Its effect on the result is a *cost*, so the net is negative.
    expect(report.unbudgetedNetCents).toBe(-400_00)

    // And it is *not* among the operating expense variance rows, which are the
    // ones that had a plan to vary from.
    expect(report.operatingExpenses.rows.map((row) => row.number)).toEqual(['6400'])
  })

  it('counts a budgeted account with no activity as fully unspent rather than dropping it', async () => {
    const fixture = await co()
    await planned(fixture)

    const report = await budgetVsActual(fixture.ctx, {
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })

    const rent = report.operatingExpenses.rows.find((row) => row.number === '6400')!
    expect(rent.budgetCents).toBe(200_00)
    expect(rent.actualCents).toBe(0)
    expect(rent.favourable).toBe(true)
  })

  it('judges a section on its totals, not by counting its favourable rows', async () => {
    // Nine rows a dollar under and one row a fortune over is not a favourable
    // section, and a majority vote would say it was.
    const fixture = await co()
    const rent = await fixture.account('6400')
    const legal = await fixture.account('6300')
    const bank = await fixture.account('1000')

    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: rent.id,
      monthlyCents: [100_00, ...Array(11).fill(0)],
    })
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: legal.id,
      monthlyCents: [100_00, ...Array(11).fill(0)],
    })
    await approveBudget(fixture.ctx, budget.id)

    // Rent $1 under plan, legal $500 over.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-10',
      memo: 'January costs',
      lines: [
        { chartAccountId: rent.id, debitCents: 99_00 },
        { chartAccountId: legal.id, debitCents: 600_00 },
        { chartAccountId: bank.id, creditCents: 699_00 },
      ],
    })

    const report = await budgetVsActual(fixture.ctx, {
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })

    expect(report.operatingExpenses.rows.filter((row) => row.favourable)).toHaveLength(1)
    expect(report.operatingExpenses.favourable).toBe(false)
  })

  it('compares only whole months, so half a February is never half a plan', async () => {
    expect(monthsCovered(2026, { startDate: '2026-01-01', endDate: '2026-03-31' })).toEqual([
      1, 2, 3,
    ])
    // A range ending mid-month has no defensible share of that month's plan.
    expect(monthsCovered(2026, { startDate: '2026-01-01', endDate: '2026-02-14' })).toEqual([1])
    expect(monthsCovered(2026, { startDate: '2026-01-15', endDate: '2026-03-31' })).toEqual([2, 3])
  })

  it('refuses to report a year nobody planned', async () => {
    const fixture = await co()

    await expect(budgetVsActual(fixture.ctx, { fiscalYear: 2026 })).rejects.toThrow(
      /no budget for 2026/,
    )
  })

  it('needs the financial reports permission', async () => {
    const fixture = await co()
    await planned(fixture)

    const bookkeeper = await createCompanyFixture({ name: 'Bookkept', role: 'bookkeeper' })

    await expect(
      budgetVsActual(bookkeeper.ctx, { fiscalYear: 2026 }),
    ).rejects.toThrow(PermissionError)
  })
})

describe('never adding income to cost (Phase 36)', () => {
  // Browser verification caught this report doing exactly what `varianceFor`
  // exists to prevent: one "Total" figure across revenue and expenses, in two
  // separate places. These are so it stays caught.
  it('keeps the plan grid\u2019s income and cost apart', async () => {
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const rent = await fixture.account('6400')
    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })

    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      annualCents: 1_200_00,
    })
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: rent.id,
      annualCents: 600_00,
    })

    const grid = await budgetGrid(fixture.ctx, budget.id)

    expect(grid.incomeCents).toBe(1_200_00)
    expect(grid.costCents).toBe(600_00)
    // The plan says a $600 profit, not an $1,800 something.
    expect(grid.netCents).toBe(600_00)
    expect(grid.netMonthlyCents[0]).toBe(50_00)
  })

  it('keeps the unbudgeted income and cost apart', async () => {
    const fixture = await co()
    const revenue = await fixture.account('4000')
    const rent = await fixture.account('6400')
    const other = await fixture.account('4100')
    const bank = await fixture.account('1000')

    const budget = await createBudget(fixture.ctx, { name: '2026', fiscalYear: 2026 })
    await setAccountBudget(fixture.ctx, {
      budgetId: budget.id,
      chartAccountId: revenue.id,
      annualCents: 1_200_00,
    })
    await approveBudget(fixture.ctx, budget.id)

    // Neither of these is in the plan: one is income, one is a cost.
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-10',
      memo: 'Unplanned',
      lines: [
        { chartAccountId: bank.id, debitCents: 300_00 },
        { chartAccountId: other.id, creditCents: 300_00 },
      ],
    })
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-11',
      memo: 'Unplanned cost',
      lines: [
        { chartAccountId: rent.id, debitCents: 500_00 },
        { chartAccountId: bank.id, creditCents: 500_00 },
      ],
    })

    const report = await budgetVsActual(fixture.ctx, {
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })

    expect(report.unbudgetedIncomeCents).toBe(300_00)
    expect(report.unbudgetedCostCents).toBe(500_00)
    // $800 is not a number about this business. -$200 is.
    expect(report.unbudgetedNetCents).toBe(-200_00)
  })
})

describe('what this phase deliberately does not add (Phase 36)', () => {
  it('adds no integrity check, because a budget reconciles against nothing', () => {
    // ADR 0033's argument, applied to itself: a check that can only ever agree
    // is noise, and the register is only useful while everything in it can
    // fail. A budget posts nothing, so there is no ledger side to compare.
    expect(INTEGRITY_CHECKS.some((check) => check.key.startsWith('budget.'))).toBe(false)
  })
})
