import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  customers,
  leases,
  properties,
  propertyUnits,
  rentCharges,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { createInvoice } from '@/modules/receivables/service'
import { PropertyError, propertyDimension } from './service'
import { rentDueDate, rentFor, rentPeriodFor, type RentPeriod } from './rent'

/**
 * The rent run (spec §5 "rents").
 *
 * ## Billed once, arbitrated by the database
 *
 * `unique(lease_id, period_start)` on `rent_charges` is the whole guarantee.
 * The run does not read the table, decide what is missing, and then insert —
 * that is a race, and it is the race a scheduled job and an impatient person
 * clicking the button will find. It inserts, and a duplicate loses on the
 * index.
 *
 * The same shape as Phase 15's `WHERE ... invoice_id IS NULL ... RETURNING`,
 * Phase 16's one-charge-per-asset-per-month index, and Phase 19's token
 * redemption. Where two people can act at once, the database decides.
 */

export type RentRunLine = {
  leaseId: string
  propertyName: string
  unitCode: string
  tenantName: string
  amountCents: number
  prorated: boolean
  chargedDays: number
  periodDays: number
}

export type RentRunPreview = {
  period: RentPeriod
  lines: RentRunLine[]
  totalCents: number
  /** Leases already billed for this period. Shown, not silently dropped. */
  alreadyBilled: number
}

type Billable = {
  leaseId: string
  customerId: string
  dueDay: number
  propertyId: string
  propertyName: string
  dimensionValueId: string
  unitCode: string
  tenantName: string
  charge: NonNullable<ReturnType<typeof rentFor>>
}

/**
 * Works out what a period would bill, without billing it.
 *
 * A landlord looks at this before pressing the button, so the same function
 * feeds the preview and the run — a preview computed by different code from
 * the run is a preview that can disagree with it.
 */
async function billable(
  ctx: ActorContext,
  period: RentPeriod,
  opts: { propertyId?: string } = {},
): Promise<{ billable: Billable[]; alreadyBilled: number }> {
  const rows = await db
    .select({
      leaseId: leases.id,
      customerId: leases.customerId,
      dueDay: leases.dueDay,
      startsOn: leases.startsOn,
      endsOn: leases.endsOn,
      rentCents: leases.rentCents,
      propertyId: properties.id,
      propertyName: properties.name,
      dimensionValueId: properties.dimensionValueId,
      unitCode: propertyUnits.code,
      tenantName: customers.name,
    })
    .from(leases)
    .innerJoin(propertyUnits, eq(propertyUnits.id, leases.unitId))
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .innerJoin(customers, eq(customers.id, leases.customerId))
    .where(
      scoped(
        ctx,
        leases,
        // `pending` is excluded on purpose: a tenancy that has been agreed and
        // not started does not owe rent, and billing it is how a landlord
        // chases somebody who has not moved in.
        eq(leases.status, 'active'),
        opts.propertyId ? eq(properties.id, opts.propertyId) : undefined,
      ),
    )
    .orderBy(asc(properties.code), asc(propertyUnits.code))

  const candidates = rows.flatMap((row) => {
    const charge = rentFor(
      { startsOn: row.startsOn, endsOn: row.endsOn, rentCents: row.rentCents },
      period,
    )
    return charge ? [{ ...row, charge }] : []
  })

  if (candidates.length === 0) return { billable: [], alreadyBilled: 0 }

  const existing = await db
    .select({ leaseId: rentCharges.leaseId })
    .from(rentCharges)
    .where(
      scoped(
        ctx,
        rentCharges,
        eq(rentCharges.periodStart, period.periodStart),
        inArray(
          rentCharges.leaseId,
          candidates.map((row) => row.leaseId),
        ),
      ),
    )

  const billed = new Set(existing.map((row) => row.leaseId))

  return {
    billable: candidates
      .filter((row) => !billed.has(row.leaseId))
      .map((row) => ({
        leaseId: row.leaseId,
        customerId: row.customerId,
        dueDay: row.dueDay,
        propertyId: row.propertyId,
        propertyName: row.propertyName,
        dimensionValueId: row.dimensionValueId,
        unitCode: row.unitCode,
        tenantName: row.tenantName,
        charge: row.charge,
      })),
    alreadyBilled: billed.size,
  }
}

export async function previewRentRun(
  ctx: ActorContext,
  opts: { month: string; propertyId?: string },
): Promise<RentRunPreview> {
  requirePermission(ctx, 'accounting:view')

  const period = rentPeriodFor(opts.month)
  const { billable: rows, alreadyBilled } = await billable(ctx, period, opts)

  return {
    period,
    lines: rows.map((row) => ({
      leaseId: row.leaseId,
      propertyName: row.propertyName,
      unitCode: row.unitCode,
      tenantName: row.tenantName,
      amountCents: row.charge.amountCents,
      prorated: row.charge.prorated,
      chargedDays: row.charge.chargedDays,
      periodDays: row.charge.periodDays,
    })),
    totalCents: rows.reduce((sum, row) => sum + row.charge.amountCents, 0),
    alreadyBilled,
  }
}

export type RentRunResult = {
  period: RentPeriod
  invoicesRaised: number
  totalCents: number
  /** Leases another run had already billed by the time this one got there. */
  skipped: number
}

/**
 * Raises one invoice per lease for a period.
 *
 * Each lease is its own transaction rather than one transaction for the run.
 * A block of forty flats where the thirty-ninth tenant's account has a problem
 * should bill thirty-nine, not none — and the idempotency key means the
 * fortieth can be fixed and the run repeated without double-billing anybody.
 *
 * `month` is a parameter rather than a clock read, the same rule Phase 16
 * applied to depreciation and Phase 21 to the PDF timestamp: a run that reads
 * the clock cannot be re-run for March and cannot be asserted on.
 */
export async function runRent(
  ctx: ActorContext,
  opts: { month: string; propertyId?: string },
): Promise<RentRunResult> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  const period = rentPeriodFor(opts.month)
  const rentAccount = await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.rentalIncome)

  if (!rentAccount) {
    throw new PropertyError(
      'Rent needs a Rental Income account (4300), which this chart of accounts does not have.',
    )
  }

  const dimension = await propertyDimension(ctx)
  const { billable: rows } = await billable(ctx, period, opts)

  let invoicesRaised = 0
  let totalCents = 0
  let skipped = 0

  for (const row of rows) {
    const raised = await billOne(ctx, {
      row,
      period,
      rentAccountId: rentAccount.id,
      dimensionId: dimension.id,
    })

    if (raised) {
      invoicesRaised += 1
      totalCents += row.charge.amountCents
    } else {
      skipped += 1
    }
  }

  if (invoicesRaised > 0) {
    await recordAudit(ctx, {
      action: 'rent.run',
      entityType: 'rent_charge',
      entityId: null,
      after: {
        period: period.periodStart,
        invoicesRaised,
        totalCents,
        propertyId: opts.propertyId ?? null,
      },
    })
  }

  return { period, invoicesRaised, totalCents, skipped }
}

/**
 * Bills one lease, or discovers that somebody else already did.
 *
 * The charge row is inserted **first**, with `ON CONFLICT DO NOTHING`. Losing
 * that insert means another run got there, and this one rolls back having
 * raised no invoice. Inserting the invoice first and then the charge would
 * leave the duplicate invoice behind when the charge lost.
 */
async function billOne(
  ctx: ActorContext,
  args: {
    row: Billable
    period: RentPeriod
    rentAccountId: string
    dimensionId: string
  },
): Promise<boolean> {
  const { row, period, rentAccountId, dimensionId } = args

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(rentCharges)
      .values({
        companyId: ctx.companyId,
        leaseId: row.leaseId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        amountCents: row.charge.amountCents,
        proratedDays: row.charge.prorated ? row.charge.chargedDays : null,
        periodDays: row.charge.prorated ? row.charge.periodDays : null,
      })
      .onConflictDoNothing({ target: [rentCharges.leaseId, rentCharges.periodStart] })
      .returning({ id: rentCharges.id })

    if (claimed.length === 0) return false

    const description = row.charge.prorated
      ? `Rent — ${row.propertyName} ${row.unitCode}, ${period.periodStart} to ${period.periodEnd} (${row.charge.chargedDays}/${row.charge.periodDays} days)`
      : `Rent — ${row.propertyName} ${row.unitCode}, ${period.periodStart.slice(0, 7)}`

    const invoice = await createInvoice(
      ctx,
      {
        customerId: row.customerId,
        issueDate: period.periodStart,
        dueDate: rentDueDate(period.periodStart, row.dueDay),
        memo: description,
        lines: [
          {
            chartAccountId: rentAccountId,
            description,
            unitPriceCents: row.charge.amountCents,
            // The property tag. This is what makes Phase 16's dimensional
            // profit and loss answer "how did Elm Street do" without a
            // per-property report existing anywhere.
            dimensions: { [dimensionId]: row.dimensionValueId },
          },
        ],
      },
      tx,
    )

    await tx
      .update(rentCharges)
      .set({ invoiceId: invoice.id })
      .where(eq(rentCharges.id, claimed[0].id))

    return true
  })
}

export type RentChargeRow = {
  id: string
  leaseId: string
  periodStart: string
  periodEnd: string
  amountCents: number
  prorated: boolean
  invoiceId: string | null
  propertyName: string
  unitCode: string
  tenantName: string
}

/** What has been billed, newest period first. */
export async function listRentCharges(
  ctx: ActorContext,
  opts: { leaseId?: string; propertyId?: string; limit?: number } = {},
): Promise<RentChargeRow[]> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: rentCharges.id,
      leaseId: rentCharges.leaseId,
      periodStart: rentCharges.periodStart,
      periodEnd: rentCharges.periodEnd,
      amountCents: rentCharges.amountCents,
      prorated: sql<boolean>`${rentCharges.proratedDays} is not null`,
      invoiceId: rentCharges.invoiceId,
      propertyName: properties.name,
      unitCode: propertyUnits.code,
      tenantName: customers.name,
    })
    .from(rentCharges)
    .innerJoin(leases, eq(leases.id, rentCharges.leaseId))
    .innerJoin(propertyUnits, eq(propertyUnits.id, leases.unitId))
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .innerJoin(customers, eq(customers.id, leases.customerId))
    .where(
      scoped(
        ctx,
        rentCharges,
        opts.leaseId ? eq(rentCharges.leaseId, opts.leaseId) : undefined,
        opts.propertyId ? eq(properties.id, opts.propertyId) : undefined,
      ),
    )
    .orderBy(sql`${rentCharges.periodStart} desc`, asc(properties.code))
    .limit(opts.limit ?? 200)
}

/** Every period a lease has been billed for, as a set of `YYYY-MM-01`. */
export async function billedPeriods(
  ctx: ActorContext,
  leaseId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ periodStart: rentCharges.periodStart })
    .from(rentCharges)
    .where(scoped(ctx, rentCharges, eq(rentCharges.leaseId, leaseId)))

  return new Set(rows.map((row) => row.periodStart))
}
