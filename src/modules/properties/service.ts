import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  customers,
  dimensions,
  dimensionValues,
  leases,
  properties,
  propertyUnits,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { DomainError } from '@/modules/errors'

/**
 * Properties, units and leases (spec §5 Real Estate / Property, §20 Phase 7).
 *
 * ## A property is a dimension, not a report
 *
 * Spec §5 asks for "property-level reporting", and the obvious reading is a
 * per-property profit and loss written here. That would be the second
 * reporting stack ADR 0007 forbids: it would see rent and repairs coded
 * through this module and miss the insurance premium somebody categorized on
 * the transaction inbox, and the two answers to "how is Elm Street doing"
 * would disagree.
 *
 * So creating a property creates a **dimension value** in a company-wide
 * "Property" dimension, and every posting this module makes tags its line with
 * it. Property-level reporting is then Phase 16's `dimensionalProfitAndLoss`,
 * which already sums every journal line whatever wrote it — including the ones
 * a bookkeeper coded by hand. There is no per-property report in this file,
 * and that absence is the point.
 */

/** The code of the dimension this module keeps for itself. */
export const PROPERTY_DIMENSION_CODE = 'PROP'

export class PropertyError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'PropertyError'
  }
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '-').slice(0, 24)
}

/**
 * The "Property" dimension, created on first use.
 *
 * Found by code rather than stored on the company, because `dimensions` already
 * has a unique index on `(company_id, code)` — a second place recording which
 * dimension is the property one is a second place for it to be wrong.
 *
 * Marked `expected`, so Phase 16 measures how much of the profit and loss
 * carries a property and lists the lines that do not. Advisory rather than
 * enforced, for the reason ADR 0016 gives: refusing to post a line without a
 * property would stop payroll working to protect a report.
 */
export async function propertyDimension(
  ctx: ActorContext,
  exec: Executor = db,
): Promise<{ id: string }> {
  const [existing] = await exec
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(scoped(ctx, dimensions, eq(dimensions.code, PROPERTY_DIMENSION_CODE)))
    .limit(1)

  if (existing) return existing

  const [created] = await exec
    .insert(dimensions)
    .values({
      companyId: ctx.companyId,
      name: 'Property',
      code: PROPERTY_DIMENSION_CODE,
      description: 'Which property an amount belongs to. Managed by the properties module.',
      requirement: 'expected',
      sortOrder: 10,
    })
    // Two properties created at the same moment would otherwise race to make
    // the dimension and one would lose on the unique index.
    .onConflictDoNothing({ target: [dimensions.companyId, dimensions.code] })
    .returning({ id: dimensions.id })

  if (created) return created

  const [raced] = await exec
    .select({ id: dimensions.id })
    .from(dimensions)
    .where(scoped(ctx, dimensions, eq(dimensions.code, PROPERTY_DIMENSION_CODE)))
    .limit(1)

  if (!raced) throw new PropertyError('Could not resolve the Property dimension.')
  return raced
}

/**
 * The four accounts this module posts to, installed if they are missing.
 *
 * They come from the real-estate pack, so a company on that pack already has
 * them. A contractor who owns the unit next door and switches the module on
 * does not — and without this, everything would work until the first rent run
 * failed with "your chart of accounts is missing 4300", which is a message
 * about a problem the application could have solved itself.
 *
 * Only ever adds. An existing 4300 named something else is that company's
 * decision, and renaming it here would rewrite their chart behind their back.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    { number: '2580', name: 'Tenant Security Deposits', type: 'liability' as const },
    { number: '4300', name: 'Rental Income', type: 'revenue' as const },
    { number: '4310', name: 'CAM Reimbursements', type: 'revenue' as const },
    { number: '4320', name: 'Late Fee Income', type: 'revenue' as const },
  ]

  const existing = await exec
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        inArray(
          chartAccounts.number,
          wanted.map((account) => account.number),
        ),
      ),
    )

  const have = new Set(existing.map((row) => row.number))
  const missing = wanted.filter((account) => !have.has(account.number))
  if (missing.length === 0) return

  await exec
    .insert(chartAccounts)
    .values(missing.map((account) => ({ companyId: ctx.companyId, ...account })))
    .onConflictDoNothing()
}

export type PropertyRow = {
  id: string
  code: string
  name: string
  addressLine1: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  acquiredOn: string | null
  dimensionValueId: string
  isActive: boolean
  notes: string | null
}

/**
 * Registers a property, and the dimension value that makes it reportable.
 *
 * Both in one transaction: a property whose dimension value did not commit
 * would accept postings that land in Unassigned, and nobody would find out
 * until the quarter's report was short.
 */
export async function createProperty(
  ctx: ActorContext,
  input: {
    code: string
    name: string
    addressLine1?: string | null
    addressLine2?: string | null
    city?: string | null
    region?: string | null
    postalCode?: string | null
    acquiredOn?: string | null
    notes?: string | null
  },
): Promise<PropertyRow> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  const code = normalizeCode(input.code)
  if (!code) throw new PropertyError('A property needs a short code, like ELM or 12-HIGH-ST.')

  const name = input.name.trim()
  if (!name) throw new PropertyError('A property needs a name.')

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)
    const dimension = await propertyDimension(ctx, tx)

    const [value] = await tx
      .insert(dimensionValues)
      .values({
        companyId: ctx.companyId,
        dimensionId: dimension.id,
        code,
        name,
      })
      .returning({ id: dimensionValues.id })

    const [row] = await tx
      .insert(properties)
      .values({
        companyId: ctx.companyId,
        code,
        name,
        addressLine1: input.addressLine1?.trim() || null,
        addressLine2: input.addressLine2?.trim() || null,
        city: input.city?.trim() || null,
        region: input.region?.trim() || null,
        postalCode: input.postalCode?.trim() || null,
        acquiredOn: input.acquiredOn ?? null,
        dimensionValueId: value.id,
        notes: input.notes?.trim() || null,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'property.create',
        entityType: 'property',
        entityId: row.id,
        after: { code, name },
      },
      tx,
    )

    return toPropertyRow(row)
  })
}

function toPropertyRow(row: typeof properties.$inferSelect): PropertyRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    addressLine1: row.addressLine1,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    acquiredOn: row.acquiredOn,
    dimensionValueId: row.dimensionValueId,
    isActive: row.isActive,
    notes: row.notes,
  }
}

export async function listProperties(
  ctx: ActorContext,
  opts: { includeInactive?: boolean } = {},
): Promise<PropertyRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select()
    .from(properties)
    .where(
      scoped(
        ctx,
        properties,
        opts.includeInactive ? undefined : eq(properties.isActive, true),
      ),
    )
    .orderBy(asc(properties.code))

  return rows.map(toPropertyRow)
}

export async function getProperty(ctx: ActorContext, propertyId: string): Promise<PropertyRow> {
  requirePermission(ctx, 'accounting:view')

  const [row] = await db
    .select()
    .from(properties)
    .where(scoped(ctx, properties, eq(properties.id, propertyId)))
    .limit(1)

  if (!row) throw new PropertyError('That property does not exist.')
  return toPropertyRow(row)
}

/**
 * Retires a property without deleting it.
 *
 * The dimension value is deactivated alongside, so it stops appearing on
 * pickers and keeps every posting ever filed against it. Deleting either would
 * orphan last year's rent roll, and "we used to own this" is a fact about the
 * books.
 */
export async function retireProperty(ctx: ActorContext, propertyId: string): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(properties)
      .where(scoped(ctx, properties, eq(properties.id, propertyId)))
      .limit(1)

    if (!row) throw new PropertyError('That property does not exist.')

    const [live] = await tx
      .select({ id: leases.id })
      .from(leases)
      .innerJoin(propertyUnits, eq(propertyUnits.id, leases.unitId))
      .where(
        and(
          eq(leases.companyId, ctx.companyId),
          eq(propertyUnits.propertyId, propertyId),
          eq(leases.status, 'active'),
        ),
      )
      .limit(1)

    if (live) {
      throw new PropertyError(
        'That property still has an active lease. End the tenancies before retiring it.',
      )
    }

    await tx
      .update(properties)
      .set({ isActive: false, updatedAt: new Date() })
      .where(scoped(ctx, properties, eq(properties.id, propertyId)))

    await tx
      .update(dimensionValues)
      .set({ isActive: false, updatedAt: new Date() })
      .where(scoped(ctx, dimensionValues, eq(dimensionValues.id, row.dimensionValueId)))

    await recordAudit(
      ctx,
      {
        action: 'property.retire',
        entityType: 'property',
        entityId: propertyId,
        before: { isActive: true },
        after: { isActive: false },
      },
      tx,
    )
  })
}

// --- Units -------------------------------------------------------------------

export type UnitRow = {
  id: string
  propertyId: string
  propertyCode: string
  propertyName: string
  code: string
  name: string | null
  status: 'available' | 'occupied' | 'unavailable'
  marketRentCents: number
  areaUnits: number | null
}

export async function createUnit(
  ctx: ActorContext,
  input: {
    propertyId: string
    code: string
    name?: string | null
    marketRentCents?: number
    areaUnits?: number | null
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  const code = input.code.trim()
  if (!code) throw new PropertyError('A unit needs a code, like 1A.')
  if ((input.marketRentCents ?? 0) < 0) {
    throw new PropertyError('Market rent cannot be negative.')
  }

  await getProperty(ctx, input.propertyId)

  const [row] = await db
    .insert(propertyUnits)
    .values({
      companyId: ctx.companyId,
      propertyId: input.propertyId,
      code,
      name: input.name?.trim() || null,
      marketRentCents: input.marketRentCents ?? 0,
      areaUnits: input.areaUnits ?? null,
    })
    .returning({ id: propertyUnits.id })

  return row
}

export async function listUnits(
  ctx: ActorContext,
  opts: { propertyId?: string } = {},
): Promise<UnitRow[]> {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: propertyUnits.id,
      propertyId: propertyUnits.propertyId,
      propertyCode: properties.code,
      propertyName: properties.name,
      code: propertyUnits.code,
      name: propertyUnits.name,
      status: propertyUnits.status,
      marketRentCents: propertyUnits.marketRentCents,
      areaUnits: propertyUnits.areaUnits,
    })
    .from(propertyUnits)
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .where(
      scoped(
        ctx,
        propertyUnits,
        opts.propertyId ? eq(propertyUnits.propertyId, opts.propertyId) : undefined,
      ),
    )
    .orderBy(asc(properties.code), asc(propertyUnits.code))
}

// --- Leases ------------------------------------------------------------------

export type LeaseRow = {
  id: string
  unitId: string
  unitCode: string
  propertyId: string
  propertyCode: string
  propertyName: string
  customerId: string
  customerName: string
  status: 'pending' | 'active' | 'ended'
  startsOn: string
  endsOn: string | null
  rentCents: number
  dueDay: number
  depositRequiredCents: number
  endedOn: string | null
  endedReason: string | null
}

const leaseSelection = {
  id: leases.id,
  unitId: leases.unitId,
  unitCode: propertyUnits.code,
  propertyId: propertyUnits.propertyId,
  propertyCode: properties.code,
  propertyName: properties.name,
  customerId: leases.customerId,
  customerName: customers.name,
  status: leases.status,
  startsOn: leases.startsOn,
  endsOn: leases.endsOn,
  rentCents: leases.rentCents,
  dueDay: leases.dueDay,
  depositRequiredCents: leases.depositRequiredCents,
  endedOn: leases.endedOn,
  endedReason: leases.endedReason,
}

function leaseQuery() {
  return db
    .select(leaseSelection)
    .from(leases)
    .innerJoin(propertyUnits, eq(propertyUnits.id, leases.unitId))
    .innerJoin(properties, eq(properties.id, propertyUnits.propertyId))
    .innerJoin(customers, eq(customers.id, leases.customerId))
}

/**
 * Agrees a tenancy.
 *
 * Overlap is refused: two active leases on one unit for the same dates would
 * bill the same space twice and report 200% occupancy. Sequential tenancies on
 * the same unit are ordinary and allowed — what is refused is two that are
 * live at once.
 */
export async function createLease(
  ctx: ActorContext,
  input: {
    unitId: string
    customerId: string
    startsOn: string
    endsOn?: string | null
    rentCents: number
    dueDay?: number
    depositRequiredCents?: number
    notes?: string | null
    /** Starts billing immediately rather than sitting as `pending`. */
    activate?: boolean
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'properties')

  if (input.rentCents <= 0) throw new PropertyError('Rent must be greater than nothing.')
  if ((input.depositRequiredCents ?? 0) < 0) {
    throw new PropertyError('A deposit cannot be negative.')
  }

  const dueDay = input.dueDay ?? 1
  if (dueDay < 1 || dueDay > 28) {
    throw new PropertyError('The rent day must be between 1 and 28.')
  }
  if (input.endsOn && input.endsOn < input.startsOn) {
    throw new PropertyError('A tenancy cannot end before it starts.')
  }

  return db.transaction(async (tx) => {
    const [unit] = await tx
      .select({ id: propertyUnits.id })
      .from(propertyUnits)
      .where(scoped(ctx, propertyUnits, eq(propertyUnits.id, input.unitId)))
      .limit(1)

    if (!unit) throw new PropertyError('That unit does not exist.')

    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
      .limit(1)

    if (!customer) throw new PropertyError('That tenant does not exist.')

    // Two ranges overlap unless one finishes before the other starts. An open
    // end date is treated as "forever", which is what a month-to-month is.
    const overlapping = await tx
      .select({ id: leases.id })
      .from(leases)
      .where(
        and(
          eq(leases.companyId, ctx.companyId),
          eq(leases.unitId, input.unitId),
          inArray(leases.status, ['pending', 'active']),
          sql`${leases.startsOn} <= ${input.endsOn ?? '9999-12-31'}`,
          sql`coalesce(${leases.endsOn}, '9999-12-31') >= ${input.startsOn}`,
        ),
      )
      .limit(1)

    if (overlapping.length > 0) {
      throw new PropertyError('That unit is already let for part of those dates.')
    }

    const status = input.activate ? 'active' : 'pending'

    const [row] = await tx
      .insert(leases)
      .values({
        companyId: ctx.companyId,
        unitId: input.unitId,
        customerId: input.customerId,
        status,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
        rentCents: input.rentCents,
        dueDay,
        depositRequiredCents: input.depositRequiredCents ?? 0,
        notes: input.notes?.trim() || null,
        createdBy: ctx.userId,
      })
      .returning({ id: leases.id })

    if (status === 'active') {
      await tx
        .update(propertyUnits)
        .set({ status: 'occupied' })
        .where(scoped(ctx, propertyUnits, eq(propertyUnits.id, input.unitId)))
    }

    await recordAudit(
      ctx,
      {
        action: 'lease.create',
        entityType: 'lease',
        entityId: row.id,
        after: { unitId: input.unitId, rentCents: input.rentCents, startsOn: input.startsOn },
      },
      tx,
    )

    return row
  })
}

/** Moves a pending tenancy to active, and marks its unit occupied. */
export async function activateLease(ctx: ActorContext, leaseId: string): Promise<boolean> {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(leases)
      .set({ status: 'active' })
      .where(
        and(
          eq(leases.id, leaseId),
          eq(leases.companyId, ctx.companyId),
          eq(leases.status, 'pending'),
        ),
      )
      .returning({ id: leases.id, unitId: leases.unitId })

    if (claimed.length === 0) return false

    await tx
      .update(propertyUnits)
      .set({ status: 'occupied' })
      .where(scoped(ctx, propertyUnits, eq(propertyUnits.id, claimed[0].unitId)))

    return true
  })
}

/**
 * Ends a tenancy.
 *
 * The unit goes back to available and the lease stops billing, but nothing is
 * deleted and no deposit is touched: what happens to the money is a separate
 * decision somebody has to make, and doing it automatically here would refund
 * a deposit that should have been kept against damage.
 */
export async function endLease(
  ctx: ActorContext,
  leaseId: string,
  input: { endedOn: string; reason?: string | null },
): Promise<boolean> {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(leases)
      .set({
        status: 'ended',
        endedOn: input.endedOn,
        endedReason: input.reason?.trim() || null,
      })
      .where(
        and(
          eq(leases.id, leaseId),
          eq(leases.companyId, ctx.companyId),
          inArray(leases.status, ['pending', 'active']),
        ),
      )
      .returning({ id: leases.id, unitId: leases.unitId })

    if (claimed.length === 0) return false

    await tx
      .update(propertyUnits)
      .set({ status: 'available' })
      .where(scoped(ctx, propertyUnits, eq(propertyUnits.id, claimed[0].unitId)))

    await recordAudit(
      ctx,
      {
        action: 'lease.end',
        entityType: 'lease',
        entityId: leaseId,
        after: { endedOn: input.endedOn, reason: input.reason ?? null },
      },
      tx,
    )

    return true
  })
}

export async function listLeases(
  ctx: ActorContext,
  opts: { propertyId?: string; status?: 'pending' | 'active' | 'ended' } = {},
): Promise<LeaseRow[]> {
  requirePermission(ctx, 'accounting:view')

  return leaseQuery()
    .where(
      scoped(
        ctx,
        leases,
        opts.propertyId ? eq(propertyUnits.propertyId, opts.propertyId) : undefined,
        opts.status ? eq(leases.status, opts.status) : undefined,
      ),
    )
    .orderBy(asc(properties.code), asc(propertyUnits.code), asc(leases.startsOn))
}

export async function getLease(ctx: ActorContext, leaseId: string): Promise<LeaseRow> {
  requirePermission(ctx, 'accounting:view')

  const [row] = await leaseQuery()
    .where(scoped(ctx, leases, eq(leases.id, leaseId)))
    .limit(1)

  if (!row) throw new PropertyError('That tenancy does not exist.')
  return row
}
