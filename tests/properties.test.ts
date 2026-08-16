import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  depositMovements,
  invoices,
  journalEntries,
  journalLines,
  leases,
  rentCharges,
} from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import { createCustomer } from '@/modules/receivables/service'
import {
  ModuleDisabledError,
  companyTerminology,
  setModuleEnabled,
} from '@/modules/industry/modules'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { accountByNumber } from '@/modules/coa/service'
import { profitAndLoss } from '@/modules/ledger/reports'
import {
  PropertyError,
  createLease,
  createProperty,
  createUnit,
  endLease,
  getLease,
  listProperties,
  propertyDimension,
  retireProperty,
} from '@/modules/properties/service'
import { rentFor, rentPeriodFor, rentPeriodsBetween, rentDueDate } from '@/modules/properties/rent'
import { listRentCharges, previewRentRun, runRent } from '@/modules/properties/billing'
import {
  applyDeposit,
  depositPosition,
  depositsHeld,
  receiveDeposit,
  refundDeposit,
} from '@/modules/properties/deposits'
import { occupancy, propertyProfitAndLoss, rentRoll } from '@/modules/properties/reporting'

/**
 * Property management (spec §5 Real Estate / Property, Phase 23).
 *
 * Three claims under test:
 *
 *  1. **A security deposit is somebody else's money.** It never reaches the
 *     profit and loss on the way in or the way out, and the only moment it
 *     becomes income is when it is kept for something nothing has billed.
 *  2. **Rent is billed once per lease per period**, however many times the run
 *     fires and however many run at once.
 *  3. **Property-level reporting is Phase 16's dimensional profit and loss**,
 *     which means it sees costs this module never posted.
 */

/** A landlord with one building, ready to let. */
async function landlord(name = 'Ridge Property Co') {
  const fixture = await createCompanyFixture({ name, industry: 'real_estate' })

  const property = await createProperty(fixture.ctx, {
    code: 'ELM',
    name: 'Elm Street Apartments',
    city: 'Portland',
  })

  return { fixture, property }
}

async function unitWithTenant(
  fixture: Fixture,
  propertyId: string,
  opts: {
    code?: string
    tenant?: string
    rentCents?: number
    startsOn?: string
    endsOn?: string | null
    depositRequiredCents?: number
    marketRentCents?: number
  } = {},
) {
  const unit = await createUnit(fixture.ctx, {
    propertyId,
    code: opts.code ?? '1A',
    marketRentCents: opts.marketRentCents ?? 150_000,
  })

  const tenant = await createCustomer(fixture.ctx, { name: opts.tenant ?? 'Sam Reyes' })

  const lease = await createLease(fixture.ctx, {
    unitId: unit.id,
    customerId: tenant.id,
    startsOn: opts.startsOn ?? '2026-01-01',
    endsOn: opts.endsOn ?? null,
    rentCents: opts.rentCents ?? 150_000,
    depositRequiredCents: opts.depositRequiredCents ?? 150_000,
    activate: true,
  })

  return { unitId: unit.id, customerId: tenant.id, leaseId: lease.id }
}

/** Net income for one property's column of the dimensional report. */
function netFor(
  report: Awaited<ReturnType<typeof propertyProfitAndLoss>>,
  code: string,
): number {
  const index = report.columns.findIndex((column) => column.code === code)
  if (index === -1) throw new Error(`No column for ${code}`)
  return report.netIncomeCents[index]
}

describe('rent arithmetic', () => {
  it('charges a whole month exactly what the lease says', () => {
    const period = rentPeriodFor('2026-03-17')
    expect(period).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-03-31', days: 31 })

    const charge = rentFor({ startsOn: '2026-01-01', endsOn: null, rentCents: 149_999 }, period)

    // Not 149999 * 31 / 31 rounded — the whole-period case never divides, so
    // no rounding can drift it.
    expect(charge).toMatchObject({ amountCents: 149_999, prorated: false, chargedDays: 31 })
  })

  it('prorates a tenancy that starts mid-period, counting the day they move in', () => {
    const period = rentPeriodFor('2026-03-01')
    const charge = rentFor({ startsOn: '2026-03-15', endsOn: null, rentCents: 155_000 }, period)

    // 15th to 31st inclusive is 17 days, not 16.
    expect(charge?.chargedDays).toBe(17)
    expect(charge?.amountCents).toBe(Math.round((155_000 * 17) / 31))
    expect(charge?.prorated).toBe(true)
  })

  it('prorates the month a tenancy ends, counting the last day', () => {
    const period = rentPeriodFor('2026-06-01')
    const charge = rentFor({ startsOn: '2025-01-01', endsOn: '2026-06-10', rentCents: 90_000 }, period)

    expect(charge?.chargedDays).toBe(10)
    expect(charge?.periodDays).toBe(30)
    expect(charge?.amountCents).toBe(30_000)
  })

  it('charges nothing for a period the tenancy does not touch', () => {
    const before = rentFor(
      { startsOn: '2026-05-01', endsOn: null, rentCents: 100_000 },
      rentPeriodFor('2026-04-01'),
    )
    const after = rentFor(
      { startsOn: '2025-01-01', endsOn: '2026-02-28', rentCents: 100_000 },
      rentPeriodFor('2026-03-01'),
    )

    expect(before).toBeNull()
    expect(after).toBeNull()
  })

  it('handles February in a leap year and out of one', () => {
    expect(rentPeriodFor('2028-02-05').days).toBe(29)
    expect(rentPeriodFor('2026-02-05').days).toBe(28)

    // One day of a 29-day February.
    const leap = rentFor(
      { startsOn: '2028-02-29', endsOn: null, rentCents: 87_000 },
      rentPeriodFor('2028-02-01'),
    )
    expect(leap?.chargedDays).toBe(1)
    expect(leap?.amountCents).toBe(Math.round(87_000 / 29))
  })

  it('does not raise a charge that rounds away to nothing', () => {
    // One day of a month at 20 cents' rent rounds to nothing, and an invoice
    // for $0.00 is a row nobody can explain.
    const charge = rentFor(
      { startsOn: '2026-03-31', endsOn: null, rentCents: 10 },
      rentPeriodFor('2026-03-01'),
    )
    expect(charge).toBeNull()
  })

  it('walks periods inclusively, across a year boundary', () => {
    const periods = rentPeriodsBetween('2025-11-14', '2026-02-02')
    expect(periods.map((period) => period.periodStart)).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ])
  })

  it('puts the due date inside its own period', () => {
    expect(rentDueDate('2026-02-01', 5)).toBe('2026-02-05')
    // Capped at 28 by the schema, so February never shifts a due date.
    expect(rentDueDate('2026-02-01', 28)).toBe('2026-02-28')
  })
})

describe('properties, units and tenancies', () => {
  it('makes a property reportable the moment it exists', async () => {
    const { fixture, property } = await landlord()

    const dimension = await propertyDimension(fixture.ctx)
    expect(property.dimensionValueId).toBeTruthy()

    // The dimension is created on first use and reused after — a second
    // property does not make a second Property dimension.
    const second = await createProperty(fixture.ctx, { code: 'OAK', name: 'Oak Court' })
    expect(second.dimensionValueId).not.toBe(property.dimensionValueId)
    expect((await propertyDimension(fixture.ctx)).id).toBe(dimension.id)

    expect((await listProperties(fixture.ctx)).map((row) => row.code)).toEqual(['ELM', 'OAK'])
  })

  it('refuses two live tenancies on one unit, and allows them back to back', async () => {
    const { fixture, property } = await landlord()
    const unit = await createUnit(fixture.ctx, { propertyId: property.id, code: '2B' })
    const one = await createCustomer(fixture.ctx, { name: 'First Tenant' })
    const two = await createCustomer(fixture.ctx, { name: 'Second Tenant' })

    await createLease(fixture.ctx, {
      unitId: unit.id,
      customerId: one.id,
      startsOn: '2026-01-01',
      endsOn: '2026-06-30',
      rentCents: 100_000,
      activate: true,
    })

    await expect(
      createLease(fixture.ctx, {
        unitId: unit.id,
        customerId: two.id,
        startsOn: '2026-06-01',
        rentCents: 110_000,
      }),
    ).rejects.toBeInstanceOf(PropertyError)

    // The day after the first ends is fine — that is an ordinary changeover.
    const next = await createLease(fixture.ctx, {
      unitId: unit.id,
      customerId: two.id,
      startsOn: '2026-07-01',
      rentCents: 110_000,
    })
    expect(next.id).toBeTruthy()
  })

  it('marks a unit occupied while it is let, and available again after', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    expect((await rentRoll(fixture.ctx))[0].status).toBe('occupied')

    expect(await endLease(fixture.ctx, leaseId, { endedOn: '2026-04-30', reason: 'Moved out' })).toBe(
      true,
    )

    const roll = await rentRoll(fixture.ctx, { asOf: '2026-05-01' })
    expect(roll[0].status).toBe('available')
    expect(roll[0].tenantName).toBeNull()

    // Ending it twice ends it once.
    expect(await endLease(fixture.ctx, leaseId, { endedOn: '2026-05-31' })).toBe(false)

    const lease = await getLease(fixture.ctx, leaseId)
    expect(lease.status).toBe('ended')
    expect(lease.endedReason).toBe('Moved out')
  })

  it('will not retire a property somebody is living in', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    await expect(retireProperty(fixture.ctx, property.id)).rejects.toThrow(/active lease/i)

    await endLease(fixture.ctx, leaseId, { endedOn: '2026-04-30' })
    await retireProperty(fixture.ctx, property.id)

    expect(await listProperties(fixture.ctx)).toHaveLength(0)
    // Kept, not deleted — last year's rent roll is a fact about the books.
    expect(await listProperties(fixture.ctx, { includeInactive: true })).toHaveLength(1)
  })

  it('refuses a tenancy that ends before it starts, and a rent of nothing', async () => {
    const { fixture, property } = await landlord()
    const unit = await createUnit(fixture.ctx, { propertyId: property.id, code: '3C' })
    const tenant = await createCustomer(fixture.ctx, { name: 'Anyone' })

    await expect(
      createLease(fixture.ctx, {
        unitId: unit.id,
        customerId: tenant.id,
        startsOn: '2026-05-01',
        endsOn: '2026-04-01',
        rentCents: 100_000,
      }),
    ).rejects.toBeInstanceOf(PropertyError)

    await expect(
      createLease(fixture.ctx, {
        unitId: unit.id,
        customerId: tenant.id,
        startsOn: '2026-05-01',
        rentCents: 0,
      }),
    ).rejects.toBeInstanceOf(PropertyError)
  })

  it('is switched off for a company that does not let property', async () => {
    const fixture = await createCompanyFixture({ name: 'Plain Co', industry: 'general' })

    await expect(
      createProperty(fixture.ctx, { code: 'X', name: 'Nowhere' }),
    ).rejects.toBeInstanceOf(ModuleDisabledError)

    // And on again for a landscaper who does happen to own a building.
    await setModuleEnabled(fixture.ctx, 'properties', true)
    expect((await createProperty(fixture.ctx, { code: 'X', name: 'Somewhere' })).code).toBe('X')
  })

  it('installs the accounts it needs for a company whose pack never had them', async () => {
    const fixture = await createCompanyFixture({ name: 'Contractor Co', industry: 'construction' })

    // The construction pack has no 2580 or 4300 — they belong to real estate.
    expect(await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.rentalIncome)).toBeFalsy()

    await setModuleEnabled(fixture.ctx, 'properties', true)
    const property = await createProperty(fixture.ctx, { code: 'YARD', name: 'The old yard' })

    // Without this, everything works until the first rent run fails with a
    // message about a chart of accounts the application could have fixed.
    expect(await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.rentalIncome)).toBeTruthy()
    expect(
      await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.tenantSecurityDeposits),
    ).toBeTruthy()

    const unit = await createUnit(fixture.ctx, { propertyId: property.id, code: 'Store 1' })
    const tenant = await createCustomer(fixture.ctx, { name: 'Neighbouring Trade' })
    const lease = await createLease(fixture.ctx, {
      unitId: unit.id,
      customerId: tenant.id,
      startsOn: '2026-01-01',
      rentCents: 80_000,
      activate: true,
    })

    expect((await runRent(fixture.ctx, { month: '2026-03-01' })).invoicesRaised).toBe(1)

    await receiveDeposit(fixture.ctx, {
      leaseId: lease.id,
      amountCents: 80_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })
    expect((await depositPosition(fixture.ctx, lease.id)).heldCents).toBe(80_000)
  })

  it('calls a customer a tenant on the real-estate pack, and the record never changes', async () => {
    const { fixture, property } = await landlord()
    const { customerId } = await unitWithTenant(fixture, property.id)

    // Spec §5's terminology override. The word on the screen moves; the row is
    // the same `customers` row it always was, which is what lets rent use the
    // receivables ledger at all.
    expect((await companyTerminology(fixture.companyId)).customer).toBe('Tenant')

    const contractor = await createCompanyFixture({ name: 'Trade Co', industry: 'construction' })
    expect((await companyTerminology(contractor.companyId)).customer).toBe('Customer')

    const [row] = await db.select().from(leases).where(eq(leases.customerId, customerId))
    expect(row.customerId).toBe(customerId)
  })

  it('keeps one landlord’s properties off another’s books', async () => {
    const { fixture: ours } = await landlord('Ours Property Co')
    const { fixture: theirs, property } = await landlord('Theirs Property Co')

    expect((await listProperties(ours.ctx)).map((row) => row.name)).toEqual([
      'Elm Street Apartments',
    ])
    await expect(createUnit(ours.ctx, { propertyId: property.id, code: '1A' })).rejects.toThrow(
      /does not exist/i,
    )
    expect(await rentRoll(theirs.ctx)).toHaveLength(0)
  })
})

describe('the rent run', () => {
  it('raises one invoice per tenancy, against Rental Income', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { code: '1A', rentCents: 150_000 })
    await unitWithTenant(fixture, property.id, {
      code: '1B',
      tenant: 'Jo Blake',
      rentCents: 120_000,
    })

    const preview = await previewRentRun(fixture.ctx, { month: '2026-03-01' })
    expect(preview.lines).toHaveLength(2)
    expect(preview.totalCents).toBe(270_000)

    const result = await runRent(fixture.ctx, { month: '2026-03-01' })
    expect(result).toMatchObject({ invoicesRaised: 2, totalCents: 270_000, skipped: 0 })

    const rentAccount = await accountByNumber(fixture.companyId, INDUSTRY_ACCOUNTS.rentalIncome)
    const posted = await db
      .select({ credit: journalLines.creditCents })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.companyId, fixture.companyId),
          eq(journalLines.chartAccountId, rentAccount!.id),
        ),
      )

    expect(posted.reduce((sum, row) => sum + row.credit, 0)).toBe(270_000)
  })

  it('bills a period once, however many times the run fires', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 150_000 })

    const first = await runRent(fixture.ctx, { month: '2026-03-01' })
    const second = await runRent(fixture.ctx, { month: '2026-03-01' })

    expect(first.invoicesRaised).toBe(1)
    // Not "skipped" — the second run does not even see it as billable, because
    // the charge row is already there.
    expect(second.invoicesRaised).toBe(0)

    expect(await db.select().from(rentCharges).where(eq(rentCharges.companyId, fixture.companyId))).toHaveLength(1)
    expect(await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))).toHaveLength(1)
  })

  it('bills once between two runs fired at the same moment', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 150_000 })

    // The race a scheduled job and an impatient landlord actually produce.
    // Both runs see nothing billed and both try; the unique index decides.
    const [a, b] = await Promise.all([
      runRent(fixture.ctx, { month: '2026-03-01' }),
      runRent(fixture.ctx, { month: '2026-03-01' }),
    ])

    expect(a.invoicesRaised + b.invoicesRaised).toBe(1)
    expect(await db.select().from(invoices).where(eq(invoices.companyId, fixture.companyId))).toHaveLength(1)
  })

  it('prorates the first month and charges the rest whole', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { startsOn: '2026-03-20', rentCents: 155_000 })

    await runRent(fixture.ctx, { month: '2026-03-01' })
    await runRent(fixture.ctx, { month: '2026-04-01' })

    const charges = await listRentCharges(fixture.ctx)
    const march = charges.find((row) => row.periodStart === '2026-03-01')
    const april = charges.find((row) => row.periodStart === '2026-04-01')

    // 20th to 31st inclusive is 12 days.
    expect(march).toMatchObject({ amountCents: Math.round((155_000 * 12) / 31), prorated: true })
    expect(april).toMatchObject({ amountCents: 155_000, prorated: false })
  })

  it('bills nothing for a tenancy that has not started or has ended', async () => {
    const { fixture, property } = await landlord()
    const unit = await createUnit(fixture.ctx, { propertyId: property.id, code: '4D' })
    const tenant = await createCustomer(fixture.ctx, { name: 'Future Tenant' })

    // Agreed, not started: `pending` bills nothing at all.
    await createLease(fixture.ctx, {
      unitId: unit.id,
      customerId: tenant.id,
      startsOn: '2026-05-01',
      rentCents: 100_000,
    })

    expect((await runRent(fixture.ctx, { month: '2026-05-01' })).invoicesRaised).toBe(0)
  })

  it('takes the month as a parameter rather than reading the clock', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 100_000 })

    // A run for a month two years ago, asserted exactly — which a run that
    // read the clock could neither do nor be tested on.
    const result = await runRent(fixture.ctx, { month: '2026-02-14' })
    expect(result.period.periodStart).toBe('2026-02-01')

    const [charge] = await listRentCharges(fixture.ctx)
    expect(charge.periodStart).toBe('2026-02-01')
    expect(charge.periodEnd).toBe('2026-02-28')
  })

  it('needs the journal permission to run, and view to preview', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id)

    const readOnly = { ...fixture.ctx, role: 'readonly' as const }
    await expect(runRent(readOnly, { month: '2026-03-01' })).rejects.toBeInstanceOf(PermissionError)
    expect((await previewRentRun(readOnly, { month: '2026-03-01' })).lines).toHaveLength(1)
  })
})

describe('security deposits', () => {
  it('is a liability on the way in, and never income', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })

    const position = await depositPosition(fixture.ctx, leaseId)
    expect(position).toMatchObject({ receivedCents: 150_000, heldCents: 150_000, shortfallCents: 0 })

    // The whole claim, asserted where it matters: the profit and loss has not
    // moved. A landlord holding £1,500 of somebody else's money has earned
    // nothing.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.revenue.totalCents).toBe(0)
    expect(pl.netIncomeCents).toBe(0)

    const liability = await accountByNumber(
      fixture.companyId,
      INDUSTRY_ACCOUNTS.tenantSecurityDeposits,
    )
    const lines = await db
      .select({ credit: journalLines.creditCents })
      .from(journalLines)
      .where(
        and(
          eq(journalLines.companyId, fixture.companyId),
          eq(journalLines.chartAccountId, liability!.id),
        ),
      )
    expect(lines.reduce((sum, row) => sum + row.credit, 0)).toBe(150_000)
  })

  it('is not an expense on the way out', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })
    await refundDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-07-01',
      financialAccountId: fixture.financialAccountId,
    })

    expect((await depositPosition(fixture.ctx, leaseId)).heldCents).toBe(0)

    // Giving back money that was never income cannot be a cost. Booking it to
    // an expense is how property books show a loss every time somebody moves
    // out.
    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.operatingExpenses.totalCents).toBe(0)
    expect(pl.otherExpenses.totalCents).toBe(0)
    expect(pl.netIncomeCents).toBe(0)
  })

  it('will not refund or apply more than is held', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 100_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })

    await expect(
      refundDeposit(fixture.ctx, {
        leaseId,
        amountCents: 100_001,
        occurredOn: '2026-02-01',
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/is held/i)

    await expect(
      applyDeposit(fixture.ctx, { leaseId, amountCents: 100_001, occurredOn: '2026-02-01' }),
    ).rejects.toThrow(/is held/i)

    // Refunding it in two halves is fine, and the second half cannot exceed
    // what the first left.
    await refundDeposit(fixture.ctx, {
      leaseId,
      amountCents: 60_000,
      occurredOn: '2026-02-01',
      financialAccountId: fixture.financialAccountId,
    })
    await expect(
      refundDeposit(fixture.ctx, {
        leaseId,
        amountCents: 60_000,
        occurredOn: '2026-03-01',
        financialAccountId: fixture.financialAccountId,
      }),
    ).rejects.toThrow(/is held/i)
  })

  it('settles unpaid rent without recognising the rent twice', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id, { rentCents: 150_000 })

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })
    await runRent(fixture.ctx, { month: '2026-03-01' })

    const [charge] = await listRentCharges(fixture.ctx)
    const before = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(before.revenue.totalCents).toBe(150_000)

    const applied = await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-03-15',
      invoiceId: charge.invoiceId,
    })

    expect(applied.recognisedIncome).toBe(false)

    // The invoice is settled and revenue has NOT moved. The rent was
    // recognised when the invoice was raised; recognising it again here would
    // count March twice and the books would balance while the income
    // statement lied.
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, charge.invoiceId as string))
    expect(invoice.balanceCents).toBe(0)
    expect(invoice.status).toBe('paid')

    const after = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(after.revenue.totalCents).toBe(150_000)
    expect((await depositPosition(fixture.ctx, leaseId)).heldCents).toBe(0)
  })

  it('does not put a settled deposit on the undeposited funds list', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id, { rentCents: 150_000 })

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })
    await runRent(fixture.ctx, { month: '2026-03-01' })
    const [charge] = await listRentCharges(fixture.ctx)

    await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-03-15',
      invoiceId: charge.invoiceId,
    })

    // A receipt with no bank account reads as cash in hand awaiting banking,
    // and this is not cash — it is a liability moving. Recording it as a
    // payment would offer the landlord cash to deposit that does not exist.
    const { undepositedReceipts } = await import('@/modules/banking/deposits')
    expect(await undepositedReceipts(fixture.ctx)).toHaveLength(0)
  })

  it('recognises income only when a deposit is kept for something unbilled', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 150_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })

    const kept = await applyDeposit(fixture.ctx, {
      leaseId,
      amountCents: 40_000,
      occurredOn: '2026-07-01',
      memo: 'Damage to the kitchen floor',
    })

    // Nothing billed the damage, so this is the moment somebody else's money
    // becomes the landlord's — and the only such moment in this module.
    expect(kept.recognisedIncome).toBe(true)

    const pl = await profitAndLoss(fixture.ctx, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    expect(pl.revenue.totalCents).toBe(40_000)
    expect((await depositPosition(fixture.ctx, leaseId)).heldCents).toBe(110_000)
  })

  it('reconciles what is held to the liability account', async () => {
    const { fixture, property } = await landlord()
    const a = await unitWithTenant(fixture, property.id, { code: '1A' })
    const b = await unitWithTenant(fixture, property.id, { code: '1B', tenant: 'Jo Blake' })

    await receiveDeposit(fixture.ctx, {
      leaseId: a.leaseId,
      amountCents: 150_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })
    await receiveDeposit(fixture.ctx, {
      leaseId: b.leaseId,
      amountCents: 120_000,
      occurredOn: '2026-01-05',
      financialAccountId: fixture.financialAccountId,
    })
    await refundDeposit(fixture.ctx, {
      leaseId: a.leaseId,
      amountCents: 50_000,
      occurredOn: '2026-02-01',
      financialAccountId: fixture.financialAccountId,
    })

    const held = await depositsHeld(fixture.ctx, { asOf: '2026-12-31' })

    // The figure a landlord has to be able to show: what the register says
    // they are holding equals what the balance sheet says they owe.
    expect(held.registerCents).toBe(220_000)
    expect(held.ledgerCents).toBe(220_000)
    expect(held.agrees).toBe(true)
    expect(held.leases).toHaveLength(2)
  })

  it('reports a shortfall when a tenant has not paid the full deposit', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id, {
      depositRequiredCents: 150_000,
    })

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 50_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })

    const position = await depositPosition(fixture.ctx, leaseId)
    expect(position.shortfallCents).toBe(100_000)

    const held = await depositsHeld(fixture.ctx, { asOf: '2026-12-31' })
    expect(held.leases[0].shortfallCents).toBe(100_000)
  })

  it('records every movement against the entry that posted it', async () => {
    const { fixture, property } = await landlord()
    const { leaseId } = await unitWithTenant(fixture, property.id)

    await receiveDeposit(fixture.ctx, {
      leaseId,
      amountCents: 90_000,
      occurredOn: '2026-01-01',
      financialAccountId: fixture.financialAccountId,
    })

    const [movement] = await db
      .select()
      .from(depositMovements)
      .where(eq(depositMovements.leaseId, leaseId))

    expect(movement.journalEntryId).toBeTruthy()

    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, movement.journalEntryId as string))
    expect(entry.status).toBe('posted')
    expect(entry.sourceType).toBe('lease_deposit')
  })

  it('keeps one landlord’s deposits off another’s reconciliation', async () => {
    const { fixture: ours } = await landlord('Ours Deposit Co')
    const { fixture: theirs, property } = await landlord('Theirs Deposit Co')
    const { leaseId } = await unitWithTenant(theirs, property.id)

    await receiveDeposit(theirs.ctx, {
      leaseId,
      amountCents: 100_000,
      occurredOn: '2026-01-01',
      financialAccountId: theirs.financialAccountId,
    })

    await expect(
      receiveDeposit(ours.ctx, {
        leaseId,
        amountCents: 100_000,
        occurredOn: '2026-01-01',
        financialAccountId: ours.financialAccountId,
      }),
    ).rejects.toThrow(/does not exist/i)

    expect((await depositsHeld(ours.ctx, { asOf: '2026-12-31' })).registerCents).toBe(0)
    expect((await depositsHeld(theirs.ctx, { asOf: '2026-12-31' })).registerCents).toBe(100_000)
  })
})

describe('the rent roll and occupancy', () => {
  it('counts an empty flat, which is the row that matters', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { code: '1A', marketRentCents: 150_000 })
    await createUnit(fixture.ctx, {
      propertyId: property.id,
      code: '1B',
      marketRentCents: 140_000,
    })
    await createUnit(fixture.ctx, {
      propertyId: property.id,
      code: '1C',
      marketRentCents: 130_000,
    })
    await createUnit(fixture.ctx, {
      propertyId: property.id,
      code: '1D',
      marketRentCents: 120_000,
    })

    const stats = await occupancy(fixture.ctx, { asOf: '2026-03-01' })

    // Four flats, one tenant. A lease-driven query would report 100%.
    expect(stats).toMatchObject({ units: 4, occupied: 1, available: 3, occupancyBp: 2500 })
    expect(stats.contractedRentCents).toBe(150_000)
    expect(stats.voidRentCents).toBe(390_000)
  })

  it('shows what has been billed and what is still owed per unit', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 150_000 })

    await runRent(fixture.ctx, { month: '2026-03-01' })
    await runRent(fixture.ctx, { month: '2026-04-01' })

    const [row] = await rentRoll(fixture.ctx, { asOf: '2026-04-15' })
    expect(row.billedCents).toBe(300_000)
    expect(row.outstandingCents).toBe(300_000)
    expect(row.tenantName).toBe('Sam Reyes')
  })

  it('keeps a unit held back for works in the denominator', async () => {
    const { fixture, property } = await landlord()
    const unit = await createUnit(fixture.ctx, { propertyId: property.id, code: '2A' })

    await db
      .update((await import('@/db/schema')).propertyUnits)
      .set({ status: 'unavailable' })
      .where(eq((await import('@/db/schema')).propertyUnits.id, unit.id))

    const stats = await occupancy(fixture.ctx)

    // A flat held back for refurbishment is still a flat earning nothing.
    // Excluding it would let a portfolio report full occupancy while empty.
    expect(stats).toMatchObject({ units: 1, occupied: 0, unavailable: 1, occupancyBp: 0 })
  })
})

describe('property-level reporting', () => {
  it('reports rent per property through the dimensional profit and loss', async () => {
    const { fixture, property } = await landlord()
    const oak = await createProperty(fixture.ctx, { code: 'OAK', name: 'Oak Court' })

    await unitWithTenant(fixture, property.id, { code: '1A', rentCents: 150_000 })
    await unitWithTenant(fixture, oak.id, {
      code: '1A',
      tenant: 'Oak Tenant',
      rentCents: 90_000,
    })

    await runRent(fixture.ctx, { month: '2026-03-01' })

    const report = await propertyProfitAndLoss(fixture.ctx, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    })

    expect(netFor(report, 'ELM')).toBe(150_000)
    expect(netFor(report, 'OAK')).toBe(90_000)
  })

  it('sees a cost this module never posted', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 150_000 })
    await runRent(fixture.ctx, { month: '2026-03-01' })

    // A roof repair somebody coded to the property by hand — the case a
    // per-property report written inside this module would miss entirely, and
    // the reason there is no such report.
    const dimension = await propertyDimension(fixture.ctx)
    const repairs = await accountByNumber(fixture.companyId, '6480')
    const bank = await db
      .select()
      .from(chartAccounts)
      .where(and(eq(chartAccounts.companyId, fixture.companyId), eq(chartAccounts.number, '1000')))
      .limit(1)

    const { postManualEntry } = await import('@/modules/ledger/journal')
    await postManualEntry(fixture.ctx, {
      entryDate: '2026-03-20',
      memo: 'Roof repair',
      lines: [
        {
          chartAccountId: repairs!.id,
          debitCents: 40_000,
          dimensions: { [dimension.id]: property.dimensionValueId },
        },
        { chartAccountId: bank[0].id, creditCents: 40_000 },
      ],
    })

    const report = await propertyProfitAndLoss(fixture.ctx, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    })

    expect(netFor(report, 'ELM')).toBe(110_000)
  })

  it('foots to the ordinary profit and loss', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 150_000 })
    await runRent(fixture.ctx, { month: '2026-03-01' })

    const dimensional = await propertyProfitAndLoss(fixture.ctx, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    })
    const plain = await profitAndLoss(fixture.ctx, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    })

    // The parts sum to the whole, checked against a report built by a
    // different query — the same invariant Phase 16 asserts.
    expect(dimensional.netIncomeTotalCents).toBe(plain.netIncomeCents)
    expect(dimensional.totalsAgree).toBe(true)
  })

  it('tags the rent invoice itself, not just the journal entry', async () => {
    const { fixture, property } = await landlord()
    await unitWithTenant(fixture, property.id, { rentCents: 150_000 })
    await runRent(fixture.ctx, { month: '2026-03-01' })

    // Phase 16 built dimensions and wired them to manual entries only, so an
    // invoice could not carry one. Property reporting needs the revenue side,
    // so this asserts the threading rather than assuming it.
    const dimension = await propertyDimension(fixture.ctx)
    const { journalLineDimensions } = await import('@/db/schema')

    const tagged = await db
      .select({ valueId: journalLineDimensions.dimensionValueId })
      .from(journalLineDimensions)
      .innerJoin(journalLines, eq(journalLines.id, journalLineDimensions.journalLineId))
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLineDimensions.companyId, fixture.companyId),
          eq(journalLineDimensions.dimensionId, dimension.id),
          eq(journalEntries.source, 'invoice'),
        ),
      )

    expect(tagged).toHaveLength(1)
    expect(tagged[0].valueId).toBe(property.dimensionValueId)
  })
})
