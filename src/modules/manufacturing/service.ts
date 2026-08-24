import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  billsOfMaterials,
  bomComponents,
  chartAccounts,
  inventoryLots,
  serviceItems,
  workOrderEntries,
  workOrders,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createJournalEntry } from '@/modules/ledger/journal'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { consumeStock, receiveStock } from '@/modules/inventory/service'
import { explodeBom, unitCostOf, type BomLine, type Requirement } from './bom'
import { DomainError } from '@/modules/errors'

/**
 * Bills of materials and work orders (spec §5, Manufacturing).
 *
 * See `db/schema/manufacturing.ts` for what this does *not* build — there is no
 * second costing engine and no second inventory model. This file moves cost
 * from raw materials, through work in process, into finished goods.
 */

export class ManufacturingError extends DomainError {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'ManufacturingError'
  }
}

/**
 * The four accounts a run posts to, installed if they are missing.
 *
 * They come from the manufacturing pack, so a manufacturer already has them. A
 * general-pack workshop that switches the module on does not — and without
 * this, everything would work until the first issue of material failed with
 * "your chart of accounts is missing 1450".
 *
 * Only ever adds, the same rule the properties and funds modules follow.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    {
      number: INDUSTRY_ACCOUNTS.rawMaterials,
      name: 'Raw Materials Inventory',
      type: 'asset' as const,
      subtype: 'inventory' as const,
    },
    {
      number: INDUSTRY_ACCOUNTS.workInProcess,
      name: 'Work in Process Inventory',
      type: 'asset' as const,
      subtype: 'inventory' as const,
    },
    {
      number: INDUSTRY_ACCOUNTS.finishedGoods,
      name: 'Finished Goods Inventory',
      type: 'asset' as const,
      subtype: 'inventory' as const,
    },
    { number: INDUSTRY_ACCOUNTS.directLabor, name: 'Direct Labor', type: 'cogs' as const },
    {
      number: INDUSTRY_ACCOUNTS.manufacturingOverhead,
      name: 'Manufacturing Overhead',
      type: 'cogs' as const,
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

async function wipAccount(ctx: ActorContext, exec: Executor = db): Promise<{ id: string }> {
  const account = await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.workInProcess, exec)
  if (!account) {
    throw new ManufacturingError(
      'This needs a Work in Process account (1450), which this chart of accounts does not have.',
    )
  }
  return account
}

// --- Bills of materials -----------------------------------------------------

export type BomRow = {
  id: string
  outputItemId: string
  outputItemName: string
  name: string
  batchMilli: number
  isActive: boolean
  notes: string | null
  components: Array<{
    id: string
    componentItemId: string
    componentItemName: string
    quantityMilli: number
    scrapBp: number
    notes: string | null
  }>
}

export async function createBom(
  ctx: ActorContext,
  input: {
    outputItemId: string
    name: string
    batchMilli: number
    notes?: string | null
    components: Array<{
      componentItemId: string
      quantityMilli: number
      scrapBp?: number
      notes?: string | null
    }>
  },
): Promise<{ id: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'manufacturing')

  const name = input.name.trim()
  if (!name) throw new ManufacturingError('A bill of materials needs a name.')
  if (input.batchMilli <= 0) throw new ManufacturingError('A bill of materials has to make something.')
  if (input.components.length === 0) {
    throw new ManufacturingError('A bill of materials with no components makes something from nothing.')
  }

  // A recipe whose output is one of its own ingredients is a loop, and the
  // explosion would be infinite. Caught here rather than at run time, because a
  // work order failing halfway through issuing material leaves a mess.
  if (input.components.some((line) => line.componentItemId === input.outputItemId)) {
    throw new ManufacturingError('Something cannot be made out of itself.')
  }

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const [bom] = await tx
      .insert(billsOfMaterials)
      .values({
        companyId: ctx.companyId,
        outputItemId: input.outputItemId,
        name,
        batchMilli: input.batchMilli,
        notes: input.notes?.trim() || null,
        createdBy: ctx.userId,
      })
      .returning({ id: billsOfMaterials.id })

    await tx.insert(bomComponents).values(
      input.components.map((line, index) => ({
        companyId: ctx.companyId,
        bomId: bom.id,
        componentItemId: line.componentItemId,
        quantityMilli: line.quantityMilli,
        scrapBp: line.scrapBp ?? 0,
        notes: line.notes?.trim() || null,
        sortOrder: index,
      })),
    )

    await recordAudit(
      ctx,
      { action: 'bom.create', entityType: 'bill_of_materials', entityId: bom.id, after: { name } },
      tx,
    )

    return { id: bom.id }
  })
}

export async function listBoms(ctx: ActorContext): Promise<BomRow[]> {
  requirePermission(ctx, 'accounting:view')

  const boms = await db
    .select({
      id: billsOfMaterials.id,
      outputItemId: billsOfMaterials.outputItemId,
      outputItemName: serviceItems.name,
      name: billsOfMaterials.name,
      batchMilli: billsOfMaterials.batchMilli,
      isActive: billsOfMaterials.isActive,
      notes: billsOfMaterials.notes,
    })
    .from(billsOfMaterials)
    .innerJoin(serviceItems, eq(serviceItems.id, billsOfMaterials.outputItemId))
    .where(scoped(ctx, billsOfMaterials))
    .orderBy(asc(billsOfMaterials.name))

  if (boms.length === 0) return []

  const components = await db
    .select({
      id: bomComponents.id,
      bomId: bomComponents.bomId,
      componentItemId: bomComponents.componentItemId,
      componentItemName: serviceItems.name,
      quantityMilli: bomComponents.quantityMilli,
      scrapBp: bomComponents.scrapBp,
      notes: bomComponents.notes,
    })
    .from(bomComponents)
    .innerJoin(serviceItems, eq(serviceItems.id, bomComponents.componentItemId))
    .where(
      scoped(
        ctx,
        bomComponents,
        inArray(
          bomComponents.bomId,
          boms.map((bom) => bom.id),
        ),
      ),
    )
    .orderBy(asc(bomComponents.sortOrder))

  return boms.map((bom) => ({
    ...bom,
    components: components.filter((line) => line.bomId === bom.id),
  }))
}

/** The BOM's lines, in the shape the pure core wants. */
async function bomLines(ctx: ActorContext, bomId: string, exec: Executor = db): Promise<BomLine[]> {
  const rows = await exec
    .select({
      componentItemId: bomComponents.componentItemId,
      quantityMilli: bomComponents.quantityMilli,
      scrapBp: bomComponents.scrapBp,
    })
    .from(bomComponents)
    .where(scoped(ctx, bomComponents, eq(bomComponents.bomId, bomId)))
    .orderBy(asc(bomComponents.sortOrder))

  return rows
}

/** What a run of this size would need, before anything is issued. */
export async function requirementsFor(
  ctx: ActorContext,
  input: { bomId: string; quantityMilli: number },
): Promise<Requirement[]> {
  requirePermission(ctx, 'accounting:view')

  const [bom] = await db
    .select({ batchMilli: billsOfMaterials.batchMilli })
    .from(billsOfMaterials)
    .where(scoped(ctx, billsOfMaterials, eq(billsOfMaterials.id, input.bomId)))
    .limit(1)

  if (!bom) throw new ManufacturingError('That bill of materials does not exist.')

  return explodeBom(await bomLines(ctx, input.bomId), bom.batchMilli, input.quantityMilli)
}

// --- Work orders ------------------------------------------------------------

export type WorkOrderRow = typeof workOrders.$inferSelect

async function nextNumber(ctx: ActorContext, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(workOrders)
    .where(eq(workOrders.companyId, ctx.companyId))

  return `WO-${1001 + Number(row?.count ?? 0)}`
}

/**
 * Plans a run. Consumes nothing and posts nothing.
 *
 * A draft exists so somebody can see what a run would need before committing
 * stock to it — `requirementsFor` answers that against a BOM, and the draft is
 * where the intention lives until material is actually issued.
 */
export async function createWorkOrder(
  ctx: ActorContext,
  input: {
    outputItemId: string
    bomId?: string | null
    plannedMilli: number
    startedOn?: string | null
    notes?: string | null
  },
): Promise<{ id: string; number: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'manufacturing')

  if (input.plannedMilli <= 0) throw new ManufacturingError('A run has to make something.')

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const number = await nextNumber(ctx, tx)

    const [order] = await tx
      .insert(workOrders)
      .values({
        companyId: ctx.companyId,
        number,
        outputItemId: input.outputItemId,
        bomId: input.bomId ?? null,
        plannedMilli: input.plannedMilli,
        startedOn: input.startedOn ?? null,
        notes: input.notes?.trim() || null,
        createdBy: ctx.userId,
      })
      .returning({ id: workOrders.id, number: workOrders.number })

    await recordAudit(
      ctx,
      {
        action: 'work_order.create',
        entityType: 'work_order',
        entityId: order.id,
        after: { number, plannedMilli: input.plannedMilli },
      },
      tx,
    )

    return order
  })
}

async function requireOpenOrder(
  ctx: ActorContext,
  workOrderId: string,
  exec: Executor,
): Promise<WorkOrderRow> {
  // Locked, because two people issuing material at the same moment would each
  // read the old `wipCents` and the later write would lose the earlier one —
  // leaving stock consumed, an entry posted, and a WIP figure that has silently
  // forgotten one of them.
  const [order] = await exec
    .select()
    .from(workOrders)
    .where(scoped(ctx, workOrders, eq(workOrders.id, workOrderId)))
    .for('update')
    .limit(1)

  if (!order) throw new ManufacturingError('That work order does not exist.')
  if (order.status === 'completed') throw new ManufacturingError('That run is already finished.')
  if (order.status === 'cancelled') throw new ManufacturingError('That run was cancelled.')

  return order
}

/**
 * Issues material from the store to a run.
 *
 * The cost is whatever the lots were worth — Phase 14 decides that by FIFO or
 * weighted average, and this asks rather than guessing. A BOM's quantities say
 * *how much* to take; they never say what it cost, because the price of steel
 * in March is not a property of the drawing.
 *
 * Releases the run on first issue: a draft that has consumed stock is not a
 * plan any more.
 */
export async function issueMaterial(
  ctx: ActorContext,
  input: {
    workOrderId: string
    itemId: string
    quantityMilli: number
    occurredOn: string
    memo?: string | null
  },
): Promise<{ costCents: number; shortfallMilli: number; wipCents: number }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'manufacturing')

  if (input.quantityMilli <= 0) {
    throw new ManufacturingError('An issue has to take something out.')
  }

  const wip = await wipAccount(ctx)

  return db.transaction(async (tx) => {
    const order = await requireOpenOrder(ctx, input.workOrderId, tx)

    const result = await consumeStock(
      ctx,
      {
        itemId: input.itemId,
        quantityMilli: input.quantityMilli,
        movedOn: input.occurredOn,
        debitAccountId: wip.id,
        kind: 'work_order_issue',
        source: 'manual',
        sourceType: 'work_order',
        entrySourceType: 'work_order_issue',
        sourceId: order.id,
        memo: input.memo ?? `Issued to ${order.number}`,
      },
      tx,
    )

    if (result.consumed.length === 0) {
      // Nothing on hand. Phase 14's rule holds — the books record what
      // happened — but here nothing happened, so there is no entry and no
      // absorbed cost to write down. The shortfall is the whole answer.
      return { costCents: 0, shortfallMilli: result.shortfallMilli, wipCents: order.wipCents }
    }

    await tx.insert(workOrderEntries).values({
      companyId: ctx.companyId,
      workOrderId: order.id,
      kind: 'material',
      itemId: input.itemId,
      quantityMilli: input.quantityMilli - result.shortfallMilli,
      costCents: result.costCents,
      occurredOn: input.occurredOn,
      memo: input.memo?.trim() || null,
      recordedBy: ctx.userId,
    })

    const wipCents = order.wipCents + result.costCents

    await tx
      .update(workOrders)
      .set({
        status: 'released',
        wipCents,
        materialCents: order.materialCents + result.costCents,
        startedOn: order.startedOn ?? input.occurredOn,
        updatedAt: new Date(),
      })
      .where(eq(workOrders.id, order.id))

    return { costCents: result.costCents, shortfallMilli: result.shortfallMilli, wipCents }
  })
}

/**
 * Absorbs labour or overhead into a run.
 *
 * Debits WIP and credits Direct Labor or Manufacturing Overhead. The credit
 * reads oddly to anybody expecting an expense to be debited, and is right: the
 * cost was already incurred when the wages were paid (Phase 9 posted that), and
 * this is the moment it stops being an expense of the period and becomes part
 * of the value of something on a shelf.
 *
 * What is left in 5070 at a period end is the labour that was *not* absorbed —
 * idle time, in other words — which is a number a factory manager wants and
 * which a model that expensed everything directly could never show.
 */
export async function absorbCost(
  ctx: ActorContext,
  input: {
    workOrderId: string
    kind: 'labour' | 'overhead'
    costCents: number
    occurredOn: string
    memo?: string | null
  },
): Promise<{ wipCents: number }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'manufacturing')

  if (input.costCents <= 0) throw new ManufacturingError('An absorption has to be worth something.')

  const wip = await wipAccount(ctx)
  const creditNumber =
    input.kind === 'labour' ? INDUSTRY_ACCOUNTS.directLabor : INDUSTRY_ACCOUNTS.manufacturingOverhead

  const credit = await accountByNumber(ctx.companyId, creditNumber)
  if (!credit) {
    throw new ManufacturingError(
      `This needs a ${input.kind === 'labour' ? 'Direct Labor' : 'Manufacturing Overhead'} account (${creditNumber}), which this chart of accounts does not have.`,
    )
  }

  return db.transaction(async (tx) => {
    const order = await requireOpenOrder(ctx, input.workOrderId, tx)

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.occurredOn,
        memo: input.memo ?? `${input.kind === 'labour' ? 'Labour' : 'Overhead'} absorbed — ${order.number}`,
        source: 'manual',
        sourceType: 'work_order_absorption',
        sourceId: order.id,
        lines: [
          { chartAccountId: wip.id, debitCents: input.costCents },
          { chartAccountId: credit.id, creditCents: input.costCents },
        ],
      },
      tx,
    )

    await tx.insert(workOrderEntries).values({
      companyId: ctx.companyId,
      workOrderId: order.id,
      kind: input.kind,
      costCents: input.costCents,
      occurredOn: input.occurredOn,
      memo: input.memo?.trim() || null,
      journalEntryId: entry.id,
      recordedBy: ctx.userId,
    })

    const wipCents = order.wipCents + input.costCents

    await tx
      .update(workOrders)
      .set({
        status: 'released',
        wipCents,
        labourCents: order.labourCents + (input.kind === 'labour' ? input.costCents : 0),
        overheadCents: order.overheadCents + (input.kind === 'overhead' ? input.costCents : 0),
        startedOn: order.startedOn ?? input.occurredOn,
        updatedAt: new Date(),
      })
      .where(eq(workOrders.id, order.id))

    return { wipCents }
  })
}

export type CompletionResult = {
  producedMilli: number
  scrappedMilli: number
  unitCostCents: number
  totalCents: number
  /** The rounding that a lot at the unit rate could not carry. */
  roundingCents: number
  lotId: string
}

/**
 * Finishes a run: WIP becomes finished goods, and WIP becomes zero.
 *
 * ## Everything that went in comes out
 *
 * The finished-goods lot is created through Phase 14's `receiveStock`, crediting
 * WIP — so the cost that leaves is the cost the run absorbed, to the cent. The
 * unit rate is `total / good units`, which means scrap raises it: a run that
 * consumed the material for 100 and yielded 95 cost the same money and made
 * less, and the 95 carry all of it.
 *
 * ## The remainder is posted, not dropped
 *
 * £100.00 over 3 units is £33.33 each, and three of those is £99.99. A lot
 * written at the unit rate would leave a penny in WIP for ever. So the lot
 * carries the exact total — `receiveStock` is given a rate, and the difference
 * between the extended value and the true total is added to the last penny by
 * adjusting the unit rate's remainder into the lot. See `unitCostOf`.
 */
export async function completeWorkOrder(
  ctx: ActorContext,
  input: {
    workOrderId: string
    producedMilli: number
    scrappedMilli?: number
    completedOn: string
    memo?: string | null
  },
): Promise<CompletionResult> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'manufacturing')

  if (input.producedMilli <= 0) {
    throw new ManufacturingError('A run that made nothing is cancelled, not completed.')
  }

  const wip = await wipAccount(ctx)

  return db.transaction(async (tx) => {
    const order = await requireOpenOrder(ctx, input.workOrderId, tx)

    if (order.wipCents <= 0) {
      throw new ManufacturingError(
        'Nothing has been issued to this run, so there is no cost to turn into finished goods.',
      )
    }

    const cost = unitCostOf({
      materialCents: order.materialCents,
      labourCents: order.labourCents,
      overheadCents: order.overheadCents,
      goodMilli: input.producedMilli,
    })

    // The lot is written for the run's whole WIP balance rather than for the
    // extended unit rate, so nothing is left behind. `receiveStock` computes
    // its own extension from the rate, so the rate is nudged by the remainder
    // where it does not divide — one lot, one exact total.
    const received = await receiveStock(
      ctx,
      {
        itemId: order.outputItemId,
        quantityMilli: input.producedMilli,
        unitCostCents: cost.unitCostCents,
        receivedOn: input.completedOn,
        creditAccountId: wip.id,
        sourceType: 'work_order',
        sourceId: order.id,
        memo: input.memo ?? `Completed ${order.number}`,
      },
      tx,
    )

    // Whatever `receiveStock` could not carry at the rounded rate.
    const remainder = order.wipCents - received.costCents

    if (remainder !== 0) {
      // **Both sides move, or neither should.**
      //
      // Posting only the journal entry would clear WIP and leave the finished
      // goods *lot* carrying the extended figure — so the inventory subledger
      // and the inventory accounts would disagree by those pennies, for ever,
      // on every run whose cost does not divide. That is precisely the drift
      // Phase 14's costing notes warn about, and it is only visible if you
      // check the lot rather than the account.
      //
      // So the lot's value is corrected to the run's true total in the same
      // transaction as the entry that corrects the ledger.
      const finishedGoodsAccountId =
        (await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.finishedGoods, tx))?.id ?? wip.id

      await tx
        .update(inventoryLots)
        .set({
          remainingValueCents: sql`${inventoryLots.remainingValueCents} + ${remainder}`,
        })
        .where(eq(inventoryLots.id, received.lotId))

      await createJournalEntry(
        ctx,
        {
          entryDate: input.completedOn,
          memo: `Rounding on ${order.number}`,
          source: 'manual',
          sourceType: 'work_order_rounding',
          sourceId: order.id,
          lines:
            remainder > 0
              ? [
                  { chartAccountId: finishedGoodsAccountId, debitCents: remainder },
                  { chartAccountId: wip.id, creditCents: remainder },
                ]
              : [
                  { chartAccountId: wip.id, debitCents: -remainder },
                  { chartAccountId: finishedGoodsAccountId, creditCents: -remainder },
                ],
        },
        tx,
      )
    }

    await tx
      .update(workOrders)
      .set({
        status: 'completed',
        producedMilli: input.producedMilli,
        scrappedMilli: input.scrappedMilli ?? 0,
        wipCents: 0,
        completedOn: input.completedOn,
        outputLotId: received.lotId,
        updatedAt: new Date(),
      })
      .where(eq(workOrders.id, order.id))

    await recordAudit(
      ctx,
      {
        action: 'work_order.complete',
        entityType: 'work_order',
        entityId: order.id,
        after: {
          producedMilli: input.producedMilli,
          scrappedMilli: input.scrappedMilli ?? 0,
          totalCents: order.wipCents,
          unitCostCents: cost.unitCostCents,
        },
      },
      tx,
    )

    return {
      producedMilli: input.producedMilli,
      scrappedMilli: input.scrappedMilli ?? 0,
      unitCostCents: cost.unitCostCents,
      totalCents: order.wipCents,
      roundingCents: remainder,
      lotId: received.lotId,
    }
  })
}

/**
 * Abandons a run, and writes off what it absorbed.
 *
 * The write-off goes to Manufacturing Overhead rather than back to raw
 * materials, because the material is gone — it was cut, mixed or melted — and
 * crediting the store would put back stock that nobody can pick. A cancelled
 * run is a cost of manufacturing that produced nothing, which is exactly what
 * 5080 is for.
 */
export async function cancelWorkOrder(
  ctx: ActorContext,
  input: { workOrderId: string; cancelledOn: string; reason?: string | null },
): Promise<{ writtenOffCents: number }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'manufacturing')

  const wip = await wipAccount(ctx)
  const overhead = await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.manufacturingOverhead)
  if (!overhead) {
    throw new ManufacturingError(
      'This needs a Manufacturing Overhead account (5080), which this chart of accounts does not have.',
    )
  }

  return db.transaction(async (tx) => {
    const order = await requireOpenOrder(ctx, input.workOrderId, tx)
    const writtenOffCents = order.wipCents

    if (writtenOffCents > 0) {
      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: input.cancelledOn,
          memo: `Cancelled ${order.number}${input.reason ? ` — ${input.reason}` : ''}`,
          source: 'manual',
          sourceType: 'work_order_cancellation',
          sourceId: order.id,
          lines: [
            { chartAccountId: overhead.id, debitCents: writtenOffCents },
            { chartAccountId: wip.id, creditCents: writtenOffCents },
          ],
        },
        tx,
      )

      await tx
        .update(workOrders)
        .set({ journalEntryId: entry.id })
        .where(eq(workOrders.id, order.id))
    }

    await tx
      .update(workOrders)
      .set({
        status: 'cancelled',
        wipCents: 0,
        completedOn: input.cancelledOn,
        notes: input.reason?.trim() || order.notes,
        updatedAt: new Date(),
      })
      .where(eq(workOrders.id, order.id))

    await recordAudit(
      ctx,
      {
        action: 'work_order.cancel',
        entityType: 'work_order',
        entityId: order.id,
        after: { writtenOffCents, reason: input.reason ?? null },
      },
      tx,
    )

    return { writtenOffCents }
  })
}

export async function listWorkOrders(
  ctx: ActorContext,
  opts: { status?: 'draft' | 'released' | 'completed' | 'cancelled'; limit?: number } = {},
) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: workOrders.id,
      number: workOrders.number,
      outputItemId: workOrders.outputItemId,
      outputItemName: serviceItems.name,
      bomId: workOrders.bomId,
      status: workOrders.status,
      plannedMilli: workOrders.plannedMilli,
      producedMilli: workOrders.producedMilli,
      scrappedMilli: workOrders.scrappedMilli,
      wipCents: workOrders.wipCents,
      materialCents: workOrders.materialCents,
      labourCents: workOrders.labourCents,
      overheadCents: workOrders.overheadCents,
      startedOn: workOrders.startedOn,
      completedOn: workOrders.completedOn,
      notes: workOrders.notes,
    })
    .from(workOrders)
    .innerJoin(serviceItems, eq(serviceItems.id, workOrders.outputItemId))
    .where(scoped(ctx, workOrders, opts.status ? eq(workOrders.status, opts.status) : undefined))
    .orderBy(desc(workOrders.createdAt))
    .limit(opts.limit ?? 100)
}

/** Everything one run absorbed, in the order it happened. */
export async function workOrderEntryList(ctx: ActorContext, workOrderId: string) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: workOrderEntries.id,
      kind: workOrderEntries.kind,
      itemId: workOrderEntries.itemId,
      itemName: serviceItems.name,
      quantityMilli: workOrderEntries.quantityMilli,
      costCents: workOrderEntries.costCents,
      occurredOn: workOrderEntries.occurredOn,
      memo: workOrderEntries.memo,
    })
    .from(workOrderEntries)
    .leftJoin(serviceItems, eq(serviceItems.id, workOrderEntries.itemId))
    .where(scoped(ctx, workOrderEntries, eq(workOrderEntries.workOrderId, workOrderId)))
    .orderBy(asc(workOrderEntries.occurredOn), asc(workOrderEntries.createdAt))
}

export async function getWorkOrder(ctx: ActorContext, workOrderId: string) {
  const [order] = await db
    .select()
    .from(workOrders)
    .where(scoped(ctx, workOrders, eq(workOrders.id, workOrderId)))
    .limit(1)

  if (!order) throw new ManufacturingError('That work order does not exist.')
  return order
}
