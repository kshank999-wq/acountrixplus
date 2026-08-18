import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  customers,
  invoices,
  repairOrderAuthorisations,
  repairOrderLines,
  repairOrders,
  vehicles,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { authorityFor } from './authority'

/**
 * What the shop has on the ramp, and what each car has been through.
 *
 * ## Why every total here is a join and a `group by`
 *
 * The obvious way to write these is a correlated subquery in the projection —
 * `(select sum(...) from repair_order_lines l where l.repair_order_id = ...)`.
 * Two of them were written that way and both silently returned zero.
 *
 * **Drizzle omits table qualification in a single-table query.** With no join,
 * `${repairOrders.id}` renders as bare `"id"`, and inside the subquery's own
 * `FROM` that resolves to *its* `id` column — so the correlation became
 * `l.repair_order_id = l.id`, which is never true. Postgres raises nothing,
 * because the query is perfectly valid; it just answers a different question.
 * Add a join to the outer query and the same fragment renders
 * `"repair_orders"."id"` and works, which is why the pattern is safe elsewhere
 * in this codebase and was not safe here.
 *
 * Joining and grouping sidesteps the whole question, and is faster besides. See
 * ADR 0030.
 */

export type VehicleRow = {
  id: string
  registration: string | null
  vin: string | null
  make: string | null
  model: string | null
  year: number | null
  customerName: string | null
  odometerMiles: number | null
  visits: number
  spentCents: number
}

/**
 * Every vehicle on file, with what it has cost its owners.
 *
 * `spentCents` counts completed orders only. An estimate nobody agreed to is
 * not money the customer has spent, and a service history that included them
 * would overstate what every car on the list had been through.
 */
export async function vehicleList(
  ctx: ActorContext,
  opts: { limit?: number } = {},
): Promise<VehicleRow[]> {
  requirePermission(ctx, 'jobs:view')

  const rows = await db
    .select({
      id: vehicles.id,
      registration: vehicles.registration,
      vin: vehicles.vin,
      make: vehicles.make,
      model: vehicles.model,
      year: vehicles.year,
      customerName: customers.name,
      odometerMiles: vehicles.odometerMiles,
      visits: sql<string>`count(distinct ${repairOrders.id}) filter (where ${repairOrders.status} = 'completed')`,
      spentCents: sql<string>`coalesce(sum(round(${repairOrderLines.quantityMilli} * ${repairOrderLines.unitPriceCents} / 1000.0)) filter (where ${repairOrders.status} = 'completed'), 0)`,
    })
    .from(vehicles)
    .leftJoin(customers, eq(customers.id, vehicles.customerId))
    .leftJoin(repairOrders, eq(repairOrders.vehicleId, vehicles.id))
    .leftJoin(repairOrderLines, eq(repairOrderLines.repairOrderId, repairOrders.id))
    .where(scoped(ctx, vehicles))
    .groupBy(
      vehicles.id,
      vehicles.registration,
      vehicles.vin,
      vehicles.make,
      vehicles.model,
      vehicles.year,
      customers.name,
      vehicles.odometerMiles,
    )
    .orderBy(asc(vehicles.registration))
    .limit(opts.limit ?? 200)

  return rows.map((row) => ({
    ...row,
    visits: Number(row.visits),
    spentCents: Number(row.spentCents),
  }))
}

export type HistoryEntry = {
  id: string
  number: string
  status: string
  openedOn: string
  completedOn: string | null
  odometerIn: number | null
  odometerOut: number | null
  totalCents: number
  authorisedCents: number
}

/**
 * What has been done to one car, newest first.
 *
 * Keyed on the vehicle rather than on the customer, and that is the decision
 * worth stating: the record follows the car. A history that reset when the car
 * changed hands would be worth much less to the next owner, to the shop that
 * wants the work, and to anybody establishing what was done and when.
 */
export async function vehicleHistory(
  ctx: ActorContext,
  vehicleId: string,
): Promise<HistoryEntry[]> {
  requirePermission(ctx, 'jobs:view')

  const rows = await db
    .select({
      id: repairOrders.id,
      number: repairOrders.number,
      status: repairOrders.status,
      openedOn: repairOrders.openedOn,
      completedOn: repairOrders.completedOn,
      odometerIn: repairOrders.odometerIn,
      odometerOut: repairOrders.odometerOut,
      authorisedCents: repairOrders.authorisedCents,
      totalCents: sql<string>`coalesce(sum(round(${repairOrderLines.quantityMilli} * ${repairOrderLines.unitPriceCents} / 1000.0)), 0)`,
    })
    .from(repairOrders)
    .leftJoin(repairOrderLines, eq(repairOrderLines.repairOrderId, repairOrders.id))
    .where(scoped(ctx, repairOrders, eq(repairOrders.vehicleId, vehicleId)))
    .groupBy(
      repairOrders.id,
      repairOrders.number,
      repairOrders.status,
      repairOrders.openedOn,
      repairOrders.completedOn,
      repairOrders.odometerIn,
      repairOrders.odometerOut,
      repairOrders.authorisedCents,
    )
    .orderBy(desc(repairOrders.openedOn), desc(repairOrders.number))

  return rows.map((row) => ({ ...row, totalCents: Number(row.totalCents) }))
}

export type OrderSummary = {
  id: string
  number: string
  status: string
  registration: string | null
  customerName: string | null
  openedOn: string
  totalCents: number
  authorisedCents: number
  ceilingCents: number
  overByCents: number
  withinAuthority: boolean
  /** The bill raised when it was completed (Phase 31). */
  invoiceId: string | null
  /** What the customer still owes on it (Phase 32). */
  outstandingCents: number
}

/** The shop's open work, with anything over its authority flagged. */
export async function openOrders(ctx: ActorContext): Promise<OrderSummary[]> {
  requirePermission(ctx, 'jobs:view')

  const rows = await db
    .select({
      id: repairOrders.id,
      number: repairOrders.number,
      status: repairOrders.status,
      registration: vehicles.registration,
      customerName: customers.name,
      openedOn: repairOrders.openedOn,
      authorisedCents: repairOrders.authorisedCents,
      toleranceBp: repairOrders.toleranceBp,
      invoiceId: repairOrders.invoiceId,
      outstandingCents: invoices.balanceCents,
      totalCents: sql<string>`coalesce(sum(round(${repairOrderLines.quantityMilli} * ${repairOrderLines.unitPriceCents} / 1000.0)), 0)`,
    })
    .from(repairOrders)
    .innerJoin(vehicles, eq(vehicles.id, repairOrders.vehicleId))
    .leftJoin(customers, eq(customers.id, repairOrders.customerId))
    .leftJoin(repairOrderLines, eq(repairOrderLines.repairOrderId, repairOrders.id))
    .leftJoin(invoices, eq(invoices.id, repairOrders.invoiceId))
    .where(scoped(ctx, repairOrders))
    .groupBy(
      repairOrders.id,
      repairOrders.number,
      repairOrders.status,
      vehicles.registration,
      customers.name,
      repairOrders.openedOn,
      repairOrders.authorisedCents,
      repairOrders.toleranceBp,
      repairOrders.invoiceId,
      invoices.balanceCents,
    )
    .orderBy(desc(repairOrders.openedOn), asc(repairOrders.number))
    .limit(200)

  return rows.map((row) => {
    const totalCents = Number(row.totalCents)
    const authority = authorityFor({
      authorisedCents: row.authorisedCents,
      toleranceBp: row.toleranceBp,
      quotedCents: totalCents,
    })

    return {
      id: row.id,
      number: row.number,
      status: row.status,
      registration: row.registration,
      customerName: row.customerName,
      openedOn: row.openedOn,
      totalCents,
      authorisedCents: row.authorisedCents,
      ceilingCents: authority.ceilingCents,
      overByCents: authority.overByCents,
      invoiceId: row.invoiceId,
      outstandingCents: row.outstandingCents ?? 0,
      // An estimate nobody has agreed to is not "over authority" — it has no
      // authority yet, which is a different and unalarming state.
      withinAuthority: row.status === 'estimate' ? true : authority.withinAuthority,
    }
  })
}

export type AuthorisationCheck = {
  /** What the order rows say was agreed, summed. */
  storedCents: number
  /** What the authorisation rows themselves add up to. */
  recordedCents: number
  differenceCents: number
  agrees: boolean
  /** Orders whose stored total does not match their own approvals. */
  offenders: Array<{ id: string; number: string; storedCents: number; recordedCents: number }>
}

/**
 * Whether every order's authorised total matches its own approvals.
 *
 * These two **should** agree exactly, and that is what makes the check worth
 * running. `repair_orders.authorised_cents` is a cache incremented by
 * `authorise`; the rows in `repair_order_authorisations` are the record. They
 * are written by different statements in the same transaction, so a bug in one
 * would not move the other — and the cache is what the billing ceiling is
 * computed from, which makes a drift here a bill somebody could not defend.
 *
 * This is the one reconciliation in the application where both sides come from
 * the same module. It is still not self-checking: nothing derives one from the
 * other, and either could be wrong alone.
 */
export async function authorisationsAgree(ctx: ActorContext): Promise<AuthorisationCheck> {
  requirePermission(ctx, 'reports:view')

  const rows = await db
    .select({
      id: repairOrders.id,
      number: repairOrders.number,
      storedCents: repairOrders.authorisedCents,
      recordedCents: sql<string>`coalesce(sum(${repairOrderAuthorisations.amountCents}), 0)`,
    })
    .from(repairOrders)
    .leftJoin(
      repairOrderAuthorisations,
      eq(repairOrderAuthorisations.repairOrderId, repairOrders.id),
    )
    .where(scoped(ctx, repairOrders))
    .groupBy(repairOrders.id, repairOrders.number, repairOrders.authorisedCents)

  let storedCents = 0
  let recordedCents = 0
  const offenders: AuthorisationCheck['offenders'] = []

  for (const row of rows) {
    const recorded = Number(row.recordedCents)
    storedCents += row.storedCents
    recordedCents += recorded

    if (recorded !== row.storedCents) {
      offenders.push({
        id: row.id,
        number: row.number,
        storedCents: row.storedCents,
        recordedCents: recorded,
      })
    }
  }

  return {
    storedCents,
    recordedCents,
    differenceCents: storedCents - recordedCents,
    // Totals can net out while individual orders are wrong, so the offender
    // list decides rather than the difference.
    agrees: offenders.length === 0,
    offenders,
  }
}

export type ShopMix = {
  labourCents: number
  partsCents: number
  subletCents: number
  subletCostCents: number
  /** What the shop made on work it sent out. Often less than anybody expects. */
  subletMarginCents: number
  totalCents: number
}

/**
 * What the shop's completed work was made of.
 *
 * Three revenue kinds kept apart, because they behave differently: labour is
 * capacity, parts are a margin on somebody else's product, and sublet is
 * neither. A shop looking at one revenue figure cannot tell whether a good
 * month was a busy bay or an expensive gearbox.
 */
export async function shopMix(
  ctx: ActorContext,
  opts: { from?: string; to?: string } = {},
): Promise<ShopMix> {
  requirePermission(ctx, 'reports:view')

  const [row] = await db
    .select({
      labourCents: sql<string>`coalesce(sum(round(${repairOrderLines.quantityMilli} * ${repairOrderLines.unitPriceCents} / 1000.0)) filter (where ${repairOrderLines.kind} = 'labour'), 0)`,
      partsCents: sql<string>`coalesce(sum(round(${repairOrderLines.quantityMilli} * ${repairOrderLines.unitPriceCents} / 1000.0)) filter (where ${repairOrderLines.kind} = 'part'), 0)`,
      subletCents: sql<string>`coalesce(sum(round(${repairOrderLines.quantityMilli} * ${repairOrderLines.unitPriceCents} / 1000.0)) filter (where ${repairOrderLines.kind} = 'sublet'), 0)`,
      subletCostCents: sql<string>`coalesce(sum(${repairOrderLines.subletCostCents}), 0)`,
    })
    .from(repairOrderLines)
    .innerJoin(repairOrders, eq(repairOrders.id, repairOrderLines.repairOrderId))
    .where(
      scoped(
        ctx,
        repairOrderLines,
        and(
          eq(repairOrders.status, 'completed'),
          opts.from ? sql`${repairOrders.completedOn} >= ${opts.from}` : undefined,
          opts.to ? sql`${repairOrders.completedOn} <= ${opts.to}` : undefined,
        ),
      ),
    )

  const labourCents = Number(row?.labourCents ?? 0)
  const partsCents = Number(row?.partsCents ?? 0)
  const subletCents = Number(row?.subletCents ?? 0)
  const subletCostCents = Number(row?.subletCostCents ?? 0)

  return {
    labourCents,
    partsCents,
    subletCents,
    subletCostCents,
    subletMarginCents: subletCents - subletCostCents,
    totalCents: labourCents + partsCents + subletCents,
  }
}
