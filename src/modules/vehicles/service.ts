import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  customers,
  repairOrderAuthorisations,
  repairOrderLines,
  repairOrders,
  vehicles,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createInvoice } from '@/modules/receivables/service'
import { consumeStock } from '@/modules/inventory/service'
import { authorityFor, odometerStep, type Authority } from './authority'
import { DomainError } from '@/modules/errors'

/**
 * Customer vehicles and repair orders (spec §5 "Automotive / Repair").
 *
 * See `authority.ts` for the arithmetic and `db/schema/vehicles.ts` for why an
 * authorisation is a row rather than a column.
 */

export class RepairError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'RepairError'
  }
}

/** Raised when the bill would exceed what the customer agreed to. */
export class UnauthorisedWorkError extends DomainError {
  readonly status = 409
  constructor(
    message: string,
    readonly authority: Authority,
  ) {
    super(message)
    this.name = 'UnauthorisedWorkError'
  }
}

/** Accounts a shop posts to, by their conventional numbers. */
export const REPAIR_ACCOUNTS = {
  labourRevenue: '4600',
  partsRevenue: '4610',
  /**
   * Sublet revenue.
   *
   * Not in the automotive pack, which gives sublet a cost account (`5180`) and
   * no revenue account. Folding it into labour would be the easy fix and the
   * wrong one — see `ensureAccounts`.
   */
  subletRevenue: '4620',
  partsCost: '5160',
  subletCost: '5180',
  receivable: '1100',
} as const

/**
 * The accounts a shop posts to, installed if missing.
 *
 * The automotive pack carries four of the five; `4620 Sublet Revenue` is in no
 * pack. It is added rather than folded into `4600 Labor Revenue` because sublet
 * is not labour: no technician's time is consumed, so a shop that books it as
 * labour will believe its own bay is more productive than it is, and will price
 * accordingly. That is a real error with a real cost, and one account prevents it.
 *
 * Only ever adds — the rule properties, funds, manufacturing, takings and
 * appointments all follow.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    { number: REPAIR_ACCOUNTS.labourRevenue, name: 'Labor Revenue', type: 'revenue' as const },
    { number: REPAIR_ACCOUNTS.partsRevenue, name: 'Parts Revenue', type: 'revenue' as const },
    {
      number: REPAIR_ACCOUNTS.subletRevenue,
      name: 'Sublet Revenue',
      type: 'revenue' as const,
      description:
        'Work sent out and billed on. Kept apart from labour because no bay time was used, and a shop that confuses the two will misprice both.',
    },
    { number: REPAIR_ACCOUNTS.partsCost, name: 'Parts Cost', type: 'cogs' as const },
    {
      number: REPAIR_ACCOUNTS.subletCost,
      name: 'Sublet Repairs',
      type: 'cogs' as const,
      description:
        'What the machine shop charged. Entered from their bill through accounts payable, not posted by the repair order — see the note in completeRepairOrder.',
    },
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

async function accountsByNumber(
  ctx: ActorContext,
  numbers: string[],
  exec: Executor,
): Promise<Map<string, string>> {
  const wanted = [...new Set(numbers)]
  const rows = await exec
    .select({ id: chartAccounts.id, number: chartAccounts.number })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, inArray(chartAccounts.number, wanted)))

  const map = new Map(rows.map((row) => [row.number, row.id]))
  const unknown = wanted.filter((number) => !map.has(number))

  if (unknown.length > 0) {
    throw new RepairError(`This chart of accounts has no ${unknown.join(', ')}. Add it first.`)
  }

  return map
}

// --- Vehicles --------------------------------------------------------------

export async function addVehicle(
  ctx: ActorContext,
  input: {
    customerId?: string | null
    vin?: string | null
    registration?: string | null
    make?: string | null
    model?: string | null
    year?: number | null
    colour?: string | null
    odometerMiles?: number | null
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'vehicles')

  const vin = input.vin?.trim().toUpperCase() || null

  if (vin) {
    const [clash] = await db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(scoped(ctx, vehicles, eq(vehicles.vin, vin)))
      .limit(1)

    if (clash) throw new RepairError(`A vehicle with VIN ${vin} is already on file.`)
  }

  const [row] = await db
    .insert(vehicles)
    .values({
      companyId: ctx.companyId,
      customerId: input.customerId ?? null,
      vin,
      registration: input.registration?.trim().toUpperCase() || null,
      make: input.make?.trim() || null,
      model: input.model?.trim() || null,
      year: input.year ?? null,
      colour: input.colour?.trim() || null,
      odometerMiles: input.odometerMiles ?? null,
    })
    .returning({ id: vehicles.id })

  return row
}

/**
 * Records the car changing hands.
 *
 * The vehicle row and every repair order on it stay exactly where they are.
 * That is the point: a service history that resets on sale is worth much less
 * than one that does not, to the next owner and to the shop that wants the work.
 */
export async function transferVehicle(
  ctx: ActorContext,
  input: { vehicleId: string; customerId: string | null },
): Promise<void> {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'vehicles')

  await db
    .update(vehicles)
    .set({ customerId: input.customerId })
    .where(scoped(ctx, vehicles, eq(vehicles.id, input.vehicleId)))
}

/**
 * Records a reading, refusing one that goes backwards.
 *
 * `allowRollback` exists for the two honest explanations — a replaced
 * instrument cluster, or a typo already keyed in — and it is a deliberate act
 * with a reason attached rather than a silent override. Without the flag the
 * write is refused, because the alternative is a crime and software should not
 * make it convenient.
 */
export async function recordOdometer(
  ctx: ActorContext,
  input: {
    vehicleId: string
    readingMiles: number
    allowRollback?: boolean
    reason?: string
  },
  exec: Executor = db,
): Promise<{ milesTravelled: number | null; unmoved: boolean }> {
  requirePermission(ctx, 'jobs:manage')

  const [vehicle] = await exec
    .select({ id: vehicles.id, odometerMiles: vehicles.odometerMiles })
    .from(vehicles)
    .where(scoped(ctx, vehicles, eq(vehicles.id, input.vehicleId)))
    .limit(1)
    .for('update')

  if (!vehicle) throw new RepairError('No such vehicle.')

  const verdict = odometerStep(vehicle.odometerMiles, input.readingMiles)

  if (verdict.kind === 'backwards') {
    if (!input.allowRollback) {
      throw new RepairError(
        `That reading is ${verdict.byMiles.toLocaleString()} miles below the last one on file. ` +
          'An odometer does not go backwards — correct the typo, or record a replaced ' +
          'instrument cluster explicitly.',
      )
    }

    await recordAudit(
      ctx,
      {
        action: 'vehicle.odometer_rollback',
        entityType: 'vehicle',
        entityId: vehicle.id,
        before: { odometerMiles: vehicle.odometerMiles },
        after: { odometerMiles: input.readingMiles, reason: input.reason ?? null },
      },
      exec,
    )
  }

  await exec
    .update(vehicles)
    .set({ odometerMiles: Math.max(0, Math.round(input.readingMiles)) })
    .where(scoped(ctx, vehicles, eq(vehicles.id, vehicle.id)))

  return {
    milesTravelled: verdict.kind === 'ok' ? verdict.milesTravelled : null,
    unmoved: verdict.kind === 'unmoved',
  }
}

// --- Repair orders ---------------------------------------------------------

export async function openRepairOrder(
  ctx: ActorContext,
  input: {
    vehicleId: string
    number?: string
    complaint?: string | null
    openedOn: string
    toleranceBp?: number
    odometerIn?: number | null
  },
): Promise<{ id: string; number: string }> {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'vehicles')

  return db.transaction(async (tx) => {
    const [vehicle] = await tx
      .select({ id: vehicles.id, customerId: vehicles.customerId })
      .from(vehicles)
      .where(scoped(ctx, vehicles, eq(vehicles.id, input.vehicleId)))
      .limit(1)

    if (!vehicle) throw new RepairError('No such vehicle.')

    const number = input.number?.trim() || (await nextNumber(ctx, tx))

    if (input.odometerIn !== null && input.odometerIn !== undefined) {
      await recordOdometer(ctx, { vehicleId: vehicle.id, readingMiles: input.odometerIn }, tx)
    }

    const [row] = await tx
      .insert(repairOrders)
      .values({
        companyId: ctx.companyId,
        number,
        vehicleId: vehicle.id,
        // Copied and then held: the car may be sold mid-job, and the bill is
        // owed by whoever brought it in.
        customerId: vehicle.customerId,
        complaint: input.complaint?.trim() || null,
        openedOn: input.openedOn,
        toleranceBp: input.toleranceBp ?? 0,
        odometerIn: input.odometerIn ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: repairOrders.id, number: repairOrders.number })

    return row
  })
}

async function nextNumber(ctx: ActorContext, exec: Executor): Promise<string> {
  const [row] = await exec
    .select({ count: sql<string>`count(*)` })
    .from(repairOrders)
    .where(scoped(ctx, repairOrders))

  return `RO-${String(1000 + Number(row?.count ?? 0) + 1)}`
}

export async function addLine(
  ctx: ActorContext,
  input: {
    repairOrderId: string
    kind: 'labour' | 'part' | 'sublet'
    description: string
    itemId?: string | null
    quantityMilli?: number
    unitPriceCents: number
    subletCostCents?: number
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'vehicles')

  const [order] = await db
    .select({ status: repairOrders.status })
    .from(repairOrders)
    .where(scoped(ctx, repairOrders, eq(repairOrders.id, input.repairOrderId)))
    .limit(1)

  if (!order) throw new RepairError('No such repair order.')
  if (order.status === 'completed' || order.status === 'cancelled') {
    throw new RepairError(`That order is ${order.status}. Nothing more can be added to it.`)
  }

  if (input.kind === 'part' && !input.itemId) {
    throw new RepairError('A part line needs the part it is for.')
  }

  const [row] = await db
    .insert(repairOrderLines)
    .values({
      companyId: ctx.companyId,
      repairOrderId: input.repairOrderId,
      kind: input.kind,
      description: input.description.trim(),
      itemId: input.kind === 'part' ? (input.itemId ?? null) : null,
      quantityMilli: input.quantityMilli ?? 1_000,
      unitPriceCents: input.unitPriceCents,
      subletCostCents: input.kind === 'sublet' ? (input.subletCostCents ?? 0) : 0,
    })
    .returning({ id: repairOrderLines.id })

  return row
}

/**
 * The customer saying yes to a further amount.
 *
 * The row is the record and the column is the cache: the authorisation is
 * inserted and the order's running total is incremented from it, both in one
 * transaction. `authorisedCents` therefore never drifts from the rows it
 * summarises, and `authorisationsAgree` can still check — because the two are
 * written by different statements and a bug in one would not move the other.
 */
export async function authorise(
  ctx: ActorContext,
  input: {
    repairOrderId: string
    amountCents: number
    channel?: 'in_person' | 'phone' | 'email' | 'sms' | 'online'
    approvedBy?: string | null
    notes?: string | null
  },
): Promise<{ authorisedCents: number }> {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'vehicles')

  if (input.amountCents === 0) {
    throw new RepairError('An authorisation for nothing is not an authorisation.')
  }

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(repairOrders)
      .where(scoped(ctx, repairOrders, eq(repairOrders.id, input.repairOrderId)))
      .limit(1)
      .for('update')

    if (!order) throw new RepairError('No such repair order.')
    if (order.status === 'completed' || order.status === 'cancelled') {
      throw new RepairError(`That order is ${order.status}. It cannot be authorised further.`)
    }

    const total = order.authorisedCents + input.amountCents

    if (total < 0) {
      throw new RepairError('Withdrawing that would take the authorised total below zero.')
    }

    await tx.insert(repairOrderAuthorisations).values({
      companyId: ctx.companyId,
      repairOrderId: order.id,
      amountCents: input.amountCents,
      channel: (input.channel ?? 'phone') as never,
      approvedBy: input.approvedBy?.trim() || null,
      takenBy: ctx.userId,
      notes: input.notes?.trim() || null,
    })

    await tx
      .update(repairOrders)
      .set({
        authorisedCents: total,
        // An order with money agreed against it is authorised work, not an
        // estimate. Withdrawing the last of it puts it back.
        status: total > 0 ? 'authorised' : 'estimate',
      })
      .where(scoped(ctx, repairOrders, eq(repairOrders.id, order.id)))

    await recordAudit(
      ctx,
      {
        action: 'repair.authorise',
        entityType: 'repair_order',
        entityId: order.id,
        before: { authorisedCents: order.authorisedCents },
        after: {
          authorisedCents: total,
          amountCents: input.amountCents,
          channel: input.channel ?? 'phone',
          approvedBy: input.approvedBy ?? null,
        },
      },
      tx,
    )

    return { authorisedCents: total }
  })
}

export type OrderTotals = {
  labourCents: number
  partsCents: number
  subletCents: number
  subletCostCents: number
  totalCents: number
}

function totalsOf(
  lines: Array<{
    kind: string
    quantityMilli: number
    unitPriceCents: number
    subletCostCents: number
  }>,
): OrderTotals {
  let labourCents = 0
  let partsCents = 0
  let subletCents = 0
  let subletCostCents = 0

  for (const line of lines) {
    // Quantities are thousandths; the extension rounds once, here, rather than
    // once per report.
    const extended = Math.round((line.quantityMilli * line.unitPriceCents) / 1_000)

    if (line.kind === 'labour') labourCents += extended
    else if (line.kind === 'part') partsCents += extended
    else {
      subletCents += extended
      subletCostCents += line.subletCostCents
    }
  }

  return {
    labourCents,
    partsCents,
    subletCents,
    subletCostCents,
    totalCents: labourCents + partsCents + subletCents,
  }
}

export type RepairOrderView = {
  id: string
  number: string
  status: string
  vehicleId: string
  registration: string | null
  make: string | null
  model: string | null
  customerName: string | null
  complaint: string | null
  openedOn: string
  completedOn: string | null
  odometerIn: number | null
  odometerOut: number | null
  toleranceBp: number
  authorisedCents: number
  totals: OrderTotals
  authority: Authority
}

/** One order, with what it comes to and whether that is covered. */
export async function repairOrderView(
  ctx: ActorContext,
  repairOrderId: string,
): Promise<RepairOrderView> {
  requirePermission(ctx, 'jobs:view')

  const [order] = await db
    .select({
      id: repairOrders.id,
      number: repairOrders.number,
      status: repairOrders.status,
      vehicleId: repairOrders.vehicleId,
      complaint: repairOrders.complaint,
      openedOn: repairOrders.openedOn,
      completedOn: repairOrders.completedOn,
      odometerIn: repairOrders.odometerIn,
      odometerOut: repairOrders.odometerOut,
      toleranceBp: repairOrders.toleranceBp,
      authorisedCents: repairOrders.authorisedCents,
      registration: vehicles.registration,
      make: vehicles.make,
      model: vehicles.model,
      customerName: customers.name,
    })
    .from(repairOrders)
    .innerJoin(vehicles, eq(vehicles.id, repairOrders.vehicleId))
    .leftJoin(customers, eq(customers.id, repairOrders.customerId))
    .where(scoped(ctx, repairOrders, eq(repairOrders.id, repairOrderId)))
    .limit(1)

  if (!order) throw new RepairError('No such repair order.')

  const lines = await db
    .select({
      kind: repairOrderLines.kind,
      quantityMilli: repairOrderLines.quantityMilli,
      unitPriceCents: repairOrderLines.unitPriceCents,
      subletCostCents: repairOrderLines.subletCostCents,
    })
    .from(repairOrderLines)
    .where(scoped(ctx, repairOrderLines, eq(repairOrderLines.repairOrderId, order.id)))

  const totals = totalsOf(lines)

  return {
    ...order,
    totals,
    authority: authorityFor({
      authorisedCents: order.authorisedCents,
      toleranceBp: order.toleranceBp,
      quotedCents: totals.totalCents,
    }),
  }
}

export type CompleteRepairResult = {
  id: string
  totals: OrderTotals
  /** What the parts actually cost, out of the lots they came from. */
  partsCostCents: number
  journalEntryId: string
  /** False when the order was already completed and nothing was posted. */
  posted: boolean
  /** Parts the shelf could not supply. Named rather than silently zero-costed. */
  shortfalls: Array<{ itemId: string; shortfallMilli: number }>
}

/**
 * Bills the order, and refuses to bill past what was agreed.
 *
 * ```
 *   Dr Accounts Receivable      total
 *       Cr Labor Revenue                labour
 *       Cr Parts Revenue                parts
 *       Cr Sublet Revenue               sublet
 * ```
 *
 * plus, per part, Phase 14's `consumeStock` relieving the shelf and debiting
 * `5160 Parts Cost` — a genuine sale, so it uses the existing `sale` movement
 * kind rather than inventing one. Only the account it debits differs, and
 * `consumeStock` has taken that as an argument since Phase 27.
 *
 * **The refusal is the point of this module.** A shop that bills past the
 * customer's authorisation has a bill it may not be able to collect and, in
 * most jurisdictions, a statute to answer to. The check happens here rather
 * than when a line is added, because adding a line is quoting — the advisor has
 * to be able to price the extra work in order to ring up and ask about it.
 *
 * ## What is deliberately not posted: the cost of a sublet
 *
 * A sublet's revenue is booked here; its **cost is not**. The machine shop will
 * send an invoice, and that invoice is entered through accounts payable and
 * coded to `5180 Sublet Repairs` like any other bill. Accruing it here as well
 * would double-count it the moment the real bill arrived, and nothing links the
 * two well enough to net them off.
 *
 * The consequence is real and is named in ADR 0030: a sublet's cost lands in
 * the period its bill is entered rather than the period the job completed.
 * `line.sublet_cost_cents` is recorded anyway, so `shopMix` can still say
 * whether the shop makes anything on work it sends out — which is the question
 * worth asking, and usually has a disappointing answer.
 */
export async function completeRepairOrder(
  ctx: ActorContext,
  input: { repairOrderId: string; completedOn: string; odometerOut?: number | null },
): Promise<CompleteRepairResult> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'vehicles')

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const [order] = await tx
      .select()
      .from(repairOrders)
      .where(scoped(ctx, repairOrders, eq(repairOrders.id, input.repairOrderId)))
      .limit(1)
      .for('update')

    if (!order) throw new RepairError('No such repair order.')

    const lines = await tx
      .select()
      .from(repairOrderLines)
      .where(scoped(ctx, repairOrderLines, eq(repairOrderLines.repairOrderId, order.id)))
      .orderBy(asc(repairOrderLines.createdAt))

    const totals = totalsOf(lines)

    if (order.status === 'completed') {
      return {
        id: order.id,
        totals,
        partsCostCents: 0,
        journalEntryId: order.journalEntryId ?? '',
        posted: false,
        shortfalls: [],
      }
    }

    if (order.status === 'cancelled') {
      throw new RepairError('That order was cancelled. Reopen it before billing it.')
    }

    if (lines.length === 0) {
      throw new RepairError('There is nothing on that order to bill.')
    }

    const authority = authorityFor({
      authorisedCents: order.authorisedCents,
      toleranceBp: order.toleranceBp,
      quotedCents: totals.totalCents,
    })

    if (!authority.withinAuthority) {
      throw new UnauthorisedWorkError(
        `This order comes to more than the customer agreed to. ` +
          `Authorised ${money(order.authorisedCents)}` +
          (order.toleranceBp > 0 ? ` (ceiling ${money(authority.ceilingCents)})` : '') +
          `, the work comes to ${money(totals.totalCents)}. ` +
          `Get a further ${money(authority.needsAuthorisationForCents)} authorised before billing.`,
        authority,
      )
    }

    if (input.odometerOut !== null && input.odometerOut !== undefined) {
      await recordOdometer(ctx, { vehicleId: order.vehicleId, readingMiles: input.odometerOut }, tx)
    }

    const accounts = await accountsByNumber(
      ctx,
      [
        REPAIR_ACCOUNTS.receivable,
        REPAIR_ACCOUNTS.labourRevenue,
        REPAIR_ACCOUNTS.partsRevenue,
        REPAIR_ACCOUNTS.subletRevenue,
        REPAIR_ACCOUNTS.partsCost,
      ],
      tx,
    )

    // Parts first: relieving the shelf is a separate entry per part, posted by
    // Phase 14, and it has to happen whether or not the revenue side balances.
    let partsCostCents = 0
    const shortfalls: Array<{ itemId: string; shortfallMilli: number }> = []

    for (const line of lines) {
      if (line.kind !== 'part' || !line.itemId) continue

      const consumed = await consumeStock(
        ctx,
        {
          itemId: line.itemId,
          quantityMilli: line.quantityMilli,
          movedOn: input.completedOn,
          debitAccountId: accounts.get(REPAIR_ACCOUNTS.partsCost) as string,
          kind: 'sale',
          source: 'invoice',
          sourceType: 'repair_order',
          entrySourceType: 'repair_order_part',
          sourceId: order.id,
          memo: `${order.number}: ${line.description}`,
        },
        tx,
      )

      partsCostCents += consumed.costCents
      if (consumed.shortfallMilli > 0) {
        shortfalls.push({ itemId: line.itemId, shortfallMilli: consumed.shortfallMilli })
      }
    }

    // --- What the customer owes: a real invoice ---------------------------
    //
    // Phase 30 posted `Dr 1100 / Cr revenue` by hand, which balanced and was
    // wrong: the money landed on the balance sheet and on no aging report, no
    // statement and no PDF, and could not be paid. See
    // `ledger/receivables-check.ts` for the detector that catches it.
    if (!order.customerId) {
      throw new RepairError(
        'This order has no customer on it, so there is nobody to bill. ' +
          'Put the keeper against the vehicle and reopen the order.',
      )
    }

    const invoiceLines: Array<{
      chartAccountId: string
      description: string
      quantityMilli?: number
      unitPriceCents: number
    }> = []

    for (const line of lines) {
      const account =
        line.kind === 'labour'
          ? REPAIR_ACCOUNTS.labourRevenue
          : line.kind === 'part'
            ? REPAIR_ACCOUNTS.partsRevenue
            : REPAIR_ACCOUNTS.subletRevenue

      invoiceLines.push({
        chartAccountId: accounts.get(account) as string,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        // Deliberately no `itemId`, even on a part. `createInvoice` relieves
        // stock for a line that names one, and the loop above has already done
        // it — debiting `5160 Parts Cost` rather than the default cost of
        // sales, which is the distinction the automotive pack exists for.
        // Passing it here would consume the same part twice.
      })
    }

    const invoice = await createInvoice(
      ctx,
      {
        customerId: order.customerId,
        issueDate: input.completedOn,
        memo: `Repair order ${order.number}`,
        lines: invoiceLines,
      },
      tx,
    )

    await tx
      .update(repairOrders)
      .set({
        status: 'completed',
        completedOn: input.completedOn,
        odometerOut: input.odometerOut ?? order.odometerOut,
        invoiceId: invoice.id,
      })
      .where(scoped(ctx, repairOrders, eq(repairOrders.id, order.id)))

    await recordAudit(
      ctx,
      {
        action: 'repair.complete',
        entityType: 'repair_order',
        entityId: order.id,
        before: { status: order.status, authorisedCents: order.authorisedCents },
        after: { status: 'completed', totalCents: totals.totalCents, partsCostCents },
      },
      tx,
    )

    return {
      id: order.id,
      totals,
      partsCostCents,
      journalEntryId: invoice.id,
      posted: true,
      shortfalls,
    }
  })
}

function money(cents: number): string {
  return `${(cents / 100).toFixed(2)}`
}

export async function cancelRepairOrder(
  ctx: ActorContext,
  input: { repairOrderId: string },
): Promise<void> {
  requirePermission(ctx, 'jobs:manage')
  await requireModule(ctx, 'vehicles')

  const [order] = await db
    .select({ status: repairOrders.status })
    .from(repairOrders)
    .where(scoped(ctx, repairOrders, eq(repairOrders.id, input.repairOrderId)))
    .limit(1)

  if (!order) throw new RepairError('No such repair order.')
  if (order.status === 'completed') {
    throw new RepairError('That order was billed. Reverse the entry rather than cancelling it.')
  }

  await db
    .update(repairOrders)
    .set({ status: 'cancelled' })
    .where(scoped(ctx, repairOrders, eq(repairOrders.id, input.repairOrderId)))
}

export async function listLines(ctx: ActorContext, repairOrderId: string) {
  requirePermission(ctx, 'jobs:view')

  return db
    .select()
    .from(repairOrderLines)
    .where(scoped(ctx, repairOrderLines, eq(repairOrderLines.repairOrderId, repairOrderId)))
    .orderBy(asc(repairOrderLines.createdAt))
}

export async function listAuthorisations(ctx: ActorContext, repairOrderId: string) {
  requirePermission(ctx, 'jobs:view')

  return db
    .select()
    .from(repairOrderAuthorisations)
    .where(
      scoped(
        ctx,
        repairOrderAuthorisations,
        eq(repairOrderAuthorisations.repairOrderId, repairOrderId),
      ),
    )
    .orderBy(asc(repairOrderAuthorisations.approvedAt))
}
