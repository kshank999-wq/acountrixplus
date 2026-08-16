import { asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  customers,
  invoices,
  leases,
  properties,
  propertyUnits,
  rentCharges,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { dimensionalProfitAndLoss } from '@/modules/dimensions/reporting'
import { propertyDimension } from './service'

/**
 * What a landlord opens the module to see (spec §5 "property-level
 * reporting").
 *
 * ## There is no per-property profit and loss in this file
 *
 * `propertyProfitAndLoss` below is four lines long, and all it does is call
 * Phase 16's dimensional report with the Property dimension. That is
 * deliberate, and it is ADR 0007's rule made concrete: a report written here
 * would sum the rent and repairs this module knows about and miss the
 * insurance premium a bookkeeper coded to the property from the transaction
 * inbox. Two answers to "how is Elm Street doing" is worse than none, because
 * only one of them is wrong and nobody knows which.
 *
 * What *is* written here is the rent roll and occupancy — questions about
 * units and tenancies rather than about money, which the ledger cannot answer
 * because it has never heard of a flat.
 */

export type RentRollRow = {
  unitId: string
  propertyId: string
  propertyCode: string
  propertyName: string
  unitCode: string
  unitName: string | null
  status: 'available' | 'occupied' | 'unavailable'
  marketRentCents: number
  /** Null when nobody is in it. */
  leaseId: string | null
  tenantName: string | null
  contractedRentCents: number | null
  startsOn: string | null
  endsOn: string | null
  /** Billed to date on the current tenancy. */
  billedCents: number
  /** Still outstanding on the invoices this module raised. */
  outstandingCents: number
}

/**
 * Every unit, let or not.
 *
 * Driven from units rather than from leases, which is the whole point: an
 * empty flat is the most important row on a rent roll and a lease-driven query
 * cannot produce it.
 */
export async function rentRoll(
  ctx: ActorContext,
  opts: { propertyId?: string; asOf?: string } = {},
): Promise<RentRollRow[]> {
  requirePermission(ctx, 'accounting:view')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const units = await db
    .select({
      unitId: propertyUnits.id,
      propertyId: properties.id,
      propertyCode: properties.code,
      propertyName: properties.name,
      unitCode: propertyUnits.code,
      unitName: propertyUnits.name,
      status: propertyUnits.status,
      marketRentCents: propertyUnits.marketRentCents,
    })
    .from(propertyUnits)
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .where(
      scoped(
        ctx,
        propertyUnits,
        eq(properties.isActive, true),
        opts.propertyId ? eq(properties.id, opts.propertyId) : undefined,
      ),
    )
    .orderBy(asc(properties.code), asc(propertyUnits.code))

  if (units.length === 0) return []

  // The tenancy live on `asOf`, per unit. A unit between tenants has none, and
  // a unit whose next tenancy starts in a fortnight still shows as empty
  // today — a rent roll answers "what is happening now", not "what is agreed".
  const live = await db
    .select({
      leaseId: leases.id,
      unitId: leases.unitId,
      tenantName: customers.name,
      rentCents: leases.rentCents,
      startsOn: leases.startsOn,
      endsOn: leases.endsOn,
    })
    .from(leases)
    .innerJoin(customers, eq(customers.id, leases.customerId))
    .where(
      scoped(
        ctx,
        leases,
        eq(leases.status, 'active'),
        inArray(
          leases.unitId,
          units.map((unit) => unit.unitId),
        ),
        sql`${leases.startsOn} <= ${asOf}`,
        sql`coalesce(${leases.endsOn}, '9999-12-31') >= ${asOf}`,
      ),
    )

  const byUnit = new Map(live.map((row) => [row.unitId, row]))

  const billing = live.length
    ? await db
        .select({
          leaseId: rentCharges.leaseId,
          billedCents: sql<string>`coalesce(sum(${rentCharges.amountCents}), 0)`,
          outstandingCents: sql<string>`coalesce(sum(${invoices.balanceCents}), 0)`,
        })
        .from(rentCharges)
        .leftJoin(invoices, eq(invoices.id, rentCharges.invoiceId))
        .where(
          scoped(
            ctx,
            rentCharges,
            inArray(
              rentCharges.leaseId,
              live.map((row) => row.leaseId),
            ),
          ),
        )
        .groupBy(rentCharges.leaseId)
    : []

  const byLease = new Map(billing.map((row) => [row.leaseId, row]))

  return units.map((unit) => {
    const lease = byUnit.get(unit.unitId)
    const money = lease ? byLease.get(lease.leaseId) : undefined

    return {
      ...unit,
      leaseId: lease?.leaseId ?? null,
      tenantName: lease?.tenantName ?? null,
      contractedRentCents: lease?.rentCents ?? null,
      startsOn: lease?.startsOn ?? null,
      endsOn: lease?.endsOn ?? null,
      billedCents: Number(money?.billedCents ?? 0),
      outstandingCents: Number(money?.outstandingCents ?? 0),
    }
  })
}

export type Occupancy = {
  asOf: string
  units: number
  occupied: number
  available: number
  unavailable: number
  /** Basis points, so 87.5% is 8750 — the codebase's ratio convention. */
  occupancyBp: number
  contractedRentCents: number
  marketRentCents: number
  /** Market rent on units nobody is paying for. The cost of the voids. */
  voidRentCents: number
}

/**
 * Occupancy, measured against units.
 *
 * A property with four flats and one tenant is 25% occupied. Measuring against
 * leases instead would report 100% — every lease is occupied, by definition —
 * which is why the units table exists separately at all.
 *
 * Units marked `unavailable` stay in the denominator. A flat held back for
 * refurbishment is still a flat earning nothing, and excluding it lets a
 * portfolio report full occupancy while half of it is empty.
 */
export async function occupancy(
  ctx: ActorContext,
  opts: { propertyId?: string; asOf?: string } = {},
): Promise<Occupancy> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const roll = await rentRoll(ctx, { ...opts, asOf })

  const occupied = roll.filter((row) => row.leaseId !== null)
  const unavailable = roll.filter((row) => row.leaseId === null && row.status === 'unavailable')

  return {
    asOf,
    units: roll.length,
    occupied: occupied.length,
    available: roll.length - occupied.length - unavailable.length,
    unavailable: unavailable.length,
    occupancyBp: roll.length === 0 ? 0 : Math.round((occupied.length / roll.length) * 10_000),
    contractedRentCents: occupied.reduce((sum, row) => sum + (row.contractedRentCents ?? 0), 0),
    marketRentCents: roll.reduce((sum, row) => sum + row.marketRentCents, 0),
    voidRentCents: roll
      .filter((row) => row.leaseId === null)
      .reduce((sum, row) => sum + row.marketRentCents, 0),
  }
}

/**
 * Profit and loss by property.
 *
 * Four lines, and that is the design. Phase 16 already sums every posted
 * journal line by dimension value, whatever wrote it — this module's rent, a
 * repair somebody categorized on the transaction inbox, a manual accrual an
 * accountant posted at year end. Writing a second report here would see only
 * the first of those three.
 */
export async function propertyProfitAndLoss(
  ctx: ActorContext,
  input: { startDate: string; endDate: string },
) {
  const dimension = await propertyDimension(ctx)
  return dimensionalProfitAndLoss(ctx, { ...input, dimensionId: dimension.id })
}
