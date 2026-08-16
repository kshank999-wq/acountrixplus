import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { journalLineDimensions } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  clearDimensionDefault,
  createDimension,
  createDimensionValue,
  DimensionError,
  dimensionsForLines,
  listDimensions,
  listDimensionValues,
  reclassifyLines,
  resolveDefaults,
  setDimensionDefault,
  unassignedLines,
  updateDimension,
} from '@/modules/dimensions/service'
import {
  balanceActivityByValue,
  coverageReport,
  dimensionalProfitAndLoss,
} from '@/modules/dimensions/reporting'
import { postManualEntry } from '@/modules/ledger/journal'
import { accountByNumber } from '@/modules/coa/service'
import { profitAndLoss } from '@/modules/ledger/reports'
import { trialBalance } from '@/modules/ledger/balances'

/**
 * User-defined accounting dimensions (spec §13, Phase 16).
 *
 * The claim under test: **the parts sum to the whole.** A dimensional report's
 * columns add up to the same figures the ordinary profit and loss shows, and
 * what carries no value is a column called Unassigned rather than a silent
 * omission.
 */

const YEAR = { startDate: '2026-01-01', endDate: '2026-12-31' }

type Sites = Fixture & {
  dimensionId: string
  downtown: string
  airport: string
  revenue: string
  rent: string
  bank: string
}

async function siteFixture(): Promise<Sites> {
  const fixture = await createCompanyFixture()

  const dimension = await createDimension(fixture.ctx, {
    name: 'Location',
    code: 'loc',
    requirement: 'expected',
  })

  const downtown = await createDimensionValue(fixture.ctx, {
    dimensionId: dimension.id,
    code: 'DT',
    name: 'Downtown',
  })
  const airport = await createDimensionValue(fixture.ctx, {
    dimensionId: dimension.id,
    code: 'AP',
    name: 'Airport',
  })

  const [revenue, rent, bank] = await Promise.all([
    accountByNumber(fixture.companyId, '4000'),
    accountByNumber(fixture.companyId, '6400'),
    accountByNumber(fixture.companyId, '1000'),
  ])

  return {
    ...fixture,
    dimensionId: dimension.id,
    downtown: downtown.id,
    airport: airport.id,
    revenue: revenue!.id,
    rent: rent!.id,
    bank: bank!.id,
  }
}

/** Posts revenue at a site, or nowhere when `value` is null. */
async function postSale(sites: Sites, cents: number, value: string | null, date = '2026-03-15') {
  return postManualEntry(sites.ctx, {
    entryDate: date,
    memo: 'Sale',
    lines: [
      {
        chartAccountId: sites.bank,
        debitCents: cents,
        dimensions: value ? { [sites.dimensionId]: value } : undefined,
      },
      {
        chartAccountId: sites.revenue,
        creditCents: cents,
        dimensions: value ? { [sites.dimensionId]: value } : undefined,
      },
    ],
  })
}

describe('defining dimensions', () => {
  it('normalizes codes so they are stable in exports', async () => {
    const fixture = await createCompanyFixture()

    const dimension = await createDimension(fixture.ctx, { name: 'Cost Centre', code: ' cost c ' })
    expect(dimension.code).toBe('COST_C')
  })

  it('refuses a parent from another dimension', async () => {
    const fixture = await createCompanyFixture()

    const location = await createDimension(fixture.ctx, { name: 'Location', code: 'LOC' })
    const department = await createDimension(fixture.ctx, { name: 'Department', code: 'DEPT' })

    const marketing = await createDimensionValue(fixture.ctx, {
      dimensionId: department.id,
      code: 'MKT',
      name: 'Marketing',
    })

    // Rolling Portland up to Marketing would produce a subtotal that means
    // nothing at all.
    await expect(
      createDimensionValue(fixture.ctx, {
        dimensionId: location.id,
        code: 'PDX',
        name: 'Portland',
        parentId: marketing.id,
      }),
    ).rejects.toThrow(DimensionError)
  })

  it('retires a dimension without losing its history', async () => {
    const sites = await siteFixture()
    await postSale(sites, 100_000, sites.downtown)

    await updateDimension(sites.ctx, sites.dimensionId, { isActive: false })

    expect(await listDimensions(sites.ctx)).toHaveLength(0)
    expect(await listDimensions(sites.ctx, { includeInactive: true })).toHaveLength(1)

    // The assignments are still there — a report printed last year must still
    // be explicable.
    const report = await dimensionalProfitAndLoss(sites.ctx, { ...YEAR, dimensionId: sites.dimensionId })
    expect(report.revenue[0].totalCents).toBe(100_000)
  })
})

describe('assignment', () => {
  it('attaches values to journal lines at posting time', async () => {
    const sites = await siteFixture()
    const entry = await postSale(sites, 250_000, sites.airport)

    const rows = await db
      .select()
      .from(journalLineDimensions)
      .where(eq(journalLineDimensions.companyId, sites.companyId))

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.dimensionValueId === sites.airport)).toBe(true)
    expect(entry.entryNumber).toBeGreaterThan(0)
  })

  /**
   * The defect this guards against reconciles perfectly and is still wrong:
   * lines matched to the wrong dimension row put the Airport's costs under
   * Downtown, and every total still foots.
   */
  it('keeps each line with its own value when one entry spans two sites', async () => {
    const sites = await siteFixture()

    await postManualEntry(sites.ctx, {
      entryDate: '2026-04-01',
      memo: 'Rent for both sites on one invoice',
      lines: [
        {
          chartAccountId: sites.rent,
          debitCents: 300_000,
          dimensions: { [sites.dimensionId]: sites.downtown },
        },
        {
          chartAccountId: sites.rent,
          debitCents: 700_000,
          dimensions: { [sites.dimensionId]: sites.airport },
        },
        { chartAccountId: sites.bank, creditCents: 1_000_000 },
      ],
    })

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    const rentRow = report.operatingExpenses.find((row) => row.number === '6400')!
    const at = (code: string) => report.columns.findIndex((column) => column.code === code)

    expect(rentRow.amountsCents[at('DT')]).toBe(300_000)
    expect(rentRow.amountsCents[at('AP')]).toBe(700_000)
  })

  it('refuses a value that belongs to a different dimension', async () => {
    const sites = await siteFixture()
    const department = await createDimension(sites.ctx, { name: 'Department', code: 'DEPT' })

    await expect(
      postManualEntry(sites.ctx, {
        entryDate: '2026-03-01',
        lines: [
          {
            chartAccountId: sites.rent,
            debitCents: 1_000,
            dimensions: { [department.id]: sites.downtown },
          },
          { chartAccountId: sites.bank, creditCents: 1_000 },
        ],
      }),
    ).rejects.toThrow(/different dimension/i)
  })

  it('refuses a value from another company', async () => {
    const sites = await siteFixture()
    const other = await siteFixture()

    await expect(
      postManualEntry(sites.ctx, {
        entryDate: '2026-03-01',
        lines: [
          {
            chartAccountId: sites.rent,
            debitCents: 1_000,
            dimensions: { [sites.dimensionId]: other.downtown },
          },
          { chartAccountId: sites.bank, creditCents: 1_000 },
        ],
      }),
    ).rejects.toThrow(/does not exist on these books/i)
  })

  it('reads a line’s dimensions back', async () => {
    const sites = await siteFixture()
    await postSale(sites, 50_000, sites.downtown)

    const [line] = await db
      .select({ id: journalLineDimensions.journalLineId })
      .from(journalLineDimensions)
      .where(eq(journalLineDimensions.companyId, sites.companyId))
      .limit(1)

    const map = await dimensionsForLines(sites.ctx, [line.id])
    expect(map.get(line.id)).toEqual({ [sites.dimensionId]: sites.downtown })
  })
})

describe('the parts sum to the whole', () => {
  /**
   * The claim. Every row of a dimensional report reads across to the same
   * figure the ordinary profit and loss shows for that account. If it did not,
   * every number on the page would be wrong by an amount nobody could
   * determine — which is worse than having no report, because it looks like an
   * answer.
   */
  it('every row’s columns sum to the ordinary P&L figure', async () => {
    const sites = await siteFixture()

    await postSale(sites, 1_200_000, sites.downtown)
    await postSale(sites, 800_000, sites.airport)
    await postSale(sites, 150_000, null)

    await postManualEntry(sites.ctx, {
      entryDate: '2026-05-01',
      lines: [
        {
          chartAccountId: sites.rent,
          debitCents: 400_000,
          dimensions: { [sites.dimensionId]: sites.downtown },
        },
        { chartAccountId: sites.bank, creditCents: 400_000 },
      ],
    })

    const [dimensional, ordinary] = await Promise.all([
      dimensionalProfitAndLoss(sites.ctx, { ...YEAR, dimensionId: sites.dimensionId }),
      profitAndLoss(sites.ctx, YEAR),
    ])

    expect(dimensional.totalsAgree).toBe(true)

    const allRows = [
      ...dimensional.revenue,
      ...dimensional.costOfSales,
      ...dimensional.operatingExpenses,
      ...dimensional.otherIncome,
      ...dimensional.otherExpenses,
    ]

    for (const row of allRows) {
      const across = row.amountsCents.reduce((sum, amount) => sum + amount, 0)
      expect(across).toBe(row.totalCents)
    }

    // And against a report computed by an entirely different query.
    const ordinaryRows = [
      ...ordinary.revenue.rows,
      ...ordinary.costOfSales.rows,
      ...ordinary.operatingExpenses.rows,
      ...ordinary.otherIncome.rows,
      ...ordinary.otherExpenses.rows,
    ]

    for (const row of ordinaryRows) {
      const match = allRows.find((r) => r.chartAccountId === row.chartAccountId)
      expect(match?.totalCents).toBe(row.balanceCents)
    }

    expect(dimensional.netIncomeTotalCents).toBe(ordinary.netIncomeCents)
  })

  /**
   * The tempting alternative — filter to lines that have a value — produces a
   * page that is internally consistent, adds up to less than the business
   * earned, and gives no hint of by how much.
   */
  it('untagged activity is a column, not an omission', async () => {
    const sites = await siteFixture()

    await postSale(sites, 900_000, sites.downtown)
    await postSale(sites, 100_000, null)

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    const unassigned = report.columns.findIndex((column) => column.valueId === null)
    expect(unassigned).toBeGreaterThan(-1)
    expect(report.columns[unassigned].name).toBe('Unassigned')
    expect(report.revenue[0].amountsCents[unassigned]).toBe(100_000)
    expect(report.revenue[0].totalCents).toBe(1_000_000)
  })

  it('drops the Unassigned column when everything carries a value', async () => {
    const sites = await siteFixture()
    await postSale(sites, 500_000, sites.downtown)

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    expect(report.columns.every((column) => column.valueId !== null)).toBe(true)
  })

  it('gives each site its own bottom line', async () => {
    const sites = await siteFixture()

    await postSale(sites, 1_000_000, sites.downtown)
    await postSale(sites, 400_000, sites.airport)
    await postManualEntry(sites.ctx, {
      entryDate: '2026-06-01',
      lines: [
        {
          chartAccountId: sites.rent,
          debitCents: 600_000,
          dimensions: { [sites.dimensionId]: sites.airport },
        },
        { chartAccountId: sites.bank, creditCents: 600_000 },
      ],
    })

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    const at = (code: string) => report.columns.findIndex((column) => column.code === code)

    // Downtown makes a million; the Airport loses $200,000 — which the
    // company-wide figure of $800,000 profit hides entirely.
    expect(report.netIncomeCents[at('DT')]).toBe(1_000_000)
    expect(report.netIncomeCents[at('AP')]).toBe(-200_000)
    expect(report.netIncomeTotalCents).toBe(800_000)
  })

  it('leaves a value with no activity off the page', async () => {
    const sites = await siteFixture()
    await postSale(sites, 100_000, sites.downtown)

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    expect(report.columns.map((column) => column.code)).toEqual(['DT'])
  })
})

describe('coverage', () => {
  it('measures gross movement, so offsetting amounts cannot hide', async () => {
    const sites = await siteFixture()

    // $50,000 of untagged revenue against $50,000 of untagged cost nets to
    // zero. Reporting that as fully covered would be a lie about $100,000
    // nobody can attribute.
    await postSale(sites, 50_000, null)
    await postManualEntry(sites.ctx, {
      entryDate: '2026-07-01',
      lines: [
        { chartAccountId: sites.rent, debitCents: 50_000 },
        { chartAccountId: sites.bank, creditCents: 50_000 },
      ],
    })
    await postSale(sites, 300_000, sites.downtown)

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    expect(report.coverage.unassignedCents).toBe(100_000)
    expect(report.coverage.assignedCents).toBe(300_000)
    expect(report.coverage.basisPointsAssigned).toBe(7_500)
  })

  it('reports coverage only for dimensions marked expected', async () => {
    const sites = await siteFixture()
    await createDimension(sites.ctx, { name: 'Campaign', code: 'CAMP', requirement: 'optional' })
    await postSale(sites, 100_000, sites.downtown)

    const coverage = await coverageReport(sites.ctx, YEAR)
    expect(coverage).toHaveLength(1)
    expect(coverage[0].dimension.code).toBe('LOC')
    expect(coverage[0].basisPointsAssigned).toBe(10_000)
  })

  it('reports null coverage when nothing happened', async () => {
    const sites = await siteFixture()
    const coverage = await coverageReport(sites.ctx, YEAR)
    expect(coverage[0].basisPointsAssigned).toBeNull()
  })
})

describe('reclassifying', () => {
  it('moves money between columns without touching the ledger', async () => {
    const sites = await siteFixture()
    await postSale(sites, 400_000, null)

    const before = await trialBalance(sites.ctx)
    const lines = await unassignedLines(sites.ctx, sites.dimensionId, YEAR)
    expect(lines).toHaveLength(1)

    const moved = await reclassifyLines(sites.ctx, {
      journalLineIds: lines.map((line) => line.journalLineId),
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.downtown,
    })
    expect(moved).toBe(1)

    const after = await trialBalance(sites.ctx)
    // Not one cent moved between accounts. This is why reclassifying is
    // allowed in a closed period: nothing a close protects has changed.
    expect(after.totalDebitCents).toBe(before.totalDebitCents)
    expect(after.totalCreditCents).toBe(before.totalCreditCents)

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })
    expect(report.coverage.unassignedCents).toBe(0)
  })

  it('replaces an existing value rather than adding a second', async () => {
    const sites = await siteFixture()
    await postSale(sites, 200_000, sites.downtown)

    const rows = await db
      .select({ id: journalLineDimensions.journalLineId })
      .from(journalLineDimensions)
      .where(eq(journalLineDimensions.companyId, sites.companyId))

    await reclassifyLines(sites.ctx, {
      journalLineIds: rows.map((row) => row.id),
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.airport,
    })

    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })

    // One value per dimension per line: the money moved, it did not duplicate.
    expect(report.columns.map((column) => column.code)).toEqual(['AP'])
    expect(report.revenue[0].totalCents).toBe(200_000)
    expect(report.totalsAgree).toBe(true)
  })

  it('clears a value back to Unassigned', async () => {
    const sites = await siteFixture()
    await postSale(sites, 200_000, sites.downtown)

    const rows = await db
      .select({ id: journalLineDimensions.journalLineId })
      .from(journalLineDimensions)
      .where(eq(journalLineDimensions.companyId, sites.companyId))

    const cleared = await reclassifyLines(sites.ctx, {
      journalLineIds: rows.map((row) => row.id),
      dimensionId: sites.dimensionId,
      dimensionValueId: null,
    })

    expect(cleared).toBe(2)
    const report = await dimensionalProfitAndLoss(sites.ctx, {
      ...YEAR,
      dimensionId: sites.dimensionId,
    })
    expect(report.coverage.assignedCents).toBe(0)
  })

  it('silently ignores lines from another company', async () => {
    const sites = await siteFixture()
    const other = await siteFixture()

    await postSale(other, 100_000, null)
    const theirs = await unassignedLines(other.ctx, other.dimensionId, YEAR)

    const moved = await reclassifyLines(sites.ctx, {
      journalLineIds: theirs.map((line) => line.journalLineId),
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.downtown,
    })

    expect(moved).toBe(0)
  })

  it('lists only profit-and-loss lines as unassigned work', async () => {
    const sites = await siteFixture()
    await postSale(sites, 100_000, null)

    // The sale posted two lines: one to the bank, one to revenue. Only the
    // revenue line is on the profit and loss, and a Location on a bank account
    // is a question nobody is asking.
    const lines = await unassignedLines(sites.ctx, sites.dimensionId, YEAR)
    expect(lines).toHaveLength(1)
    expect(lines[0].creditCents).toBe(100_000)
  })
})

describe('defaults', () => {
  it('fills in a dimension the caller did not set', async () => {
    const sites = await siteFixture()

    await setDimensionDefault(sites.ctx, {
      ownerType: 'financial_account',
      ownerId: sites.bank,
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.airport,
    })

    const resolved = await resolveDefaults(sites.ctx, {}, [
      { ownerType: 'financial_account', ownerId: sites.bank },
    ])

    expect(resolved).toEqual({ [sites.dimensionId]: sites.airport })
  })

  it('never overrides what somebody actually chose', async () => {
    const sites = await siteFixture()

    await setDimensionDefault(sites.ctx, {
      ownerType: 'financial_account',
      ownerId: sites.bank,
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.airport,
    })

    const resolved = await resolveDefaults(
      sites.ctx,
      { [sites.dimensionId]: sites.downtown },
      [{ ownerType: 'financial_account', ownerId: sites.bank }],
    )

    expect(resolved[sites.dimensionId]).toBe(sites.downtown)
  })

  it('lets the more specific owner win', async () => {
    const sites = await siteFixture()
    const vendorId = sites.rent // any id; the resolver only matches type + id

    await setDimensionDefault(sites.ctx, {
      ownerType: 'vendor',
      ownerId: vendorId,
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.downtown,
    })
    await setDimensionDefault(sites.ctx, {
      ownerType: 'financial_account',
      ownerId: sites.bank,
      dimensionId: sites.dimensionId,
      dimensionValueId: sites.airport,
    })

    const resolved = await resolveDefaults(sites.ctx, {}, [
      { ownerType: 'vendor', ownerId: vendorId },
      { ownerType: 'financial_account', ownerId: sites.bank },
    ])

    expect(resolved[sites.dimensionId]).toBe(sites.downtown)
  })

  it('replaces rather than duplicates, and clears', async () => {
    const sites = await siteFixture()

    for (const value of [sites.downtown, sites.airport]) {
      await setDimensionDefault(sites.ctx, {
        ownerType: 'financial_account',
        ownerId: sites.bank,
        dimensionId: sites.dimensionId,
        dimensionValueId: value,
      })
    }

    expect(
      await resolveDefaults(sites.ctx, {}, [
        { ownerType: 'financial_account', ownerId: sites.bank },
      ]),
    ).toEqual({ [sites.dimensionId]: sites.airport })

    await clearDimensionDefault(sites.ctx, 'financial_account', sites.bank, sites.dimensionId)

    expect(
      await resolveDefaults(sites.ctx, {}, [
        { ownerType: 'financial_account', ownerId: sites.bank },
      ]),
    ).toEqual({})
  })
})

describe('what a dimension deliberately does not do', () => {
  /**
   * A balance sheet per location cannot balance: assets can be tagged, and
   * equity cannot. Every product that ships one balances it with a plug the
   * business never transacted. What is offered instead is the movement, which
   * answers "what did the Airport buy" without claiming to answer "what is the
   * Airport worth". See ADR 0016.
   */
  it('reports balance-sheet movement by value, and calls it movement', async () => {
    const sites = await siteFixture()
    await postSale(sites, 750_000, sites.airport)

    const rows = await balanceActivityByValue(sites.ctx, {
      dimensionValueId: sites.airport,
      ...YEAR,
    })

    const bank = rows.find((row) => row.chartAccountId === sites.bank)
    expect(bank?.balanceCents).toBe(750_000)
    // Assets only — there is no equity row, because there is no such thing as
    // the Airport site's share capital.
    expect(rows.every((row) => row.type !== 'equity')).toBe(true)
  })

  it('lists values for a picker', async () => {
    const sites = await siteFixture()
    const values = await listDimensionValues(sites.ctx, { dimensionId: sites.dimensionId })
    expect(values.map((value) => value.code).sort()).toEqual(['AP', 'DT'])
  })
})
