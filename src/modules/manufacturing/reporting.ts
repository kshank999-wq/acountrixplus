import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  billsOfMaterials,
  bomComponents,
  chartAccounts,
  inventoryLots,
  journalEntries,
  journalLines,
  serviceItems,
  workOrderEntries,
  workOrders,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  heldAt,
  onBooksAt,
  type DatedMovement,
  type Lifespan,
} from '@/modules/ledger/lifespan'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { explodeBom, componentVariance, unitCostOf, yieldOf, type ComponentVariance, type YieldReport } from './bom'
import { Refusal } from '@/modules/errors'

/**
 * What is on the factory floor, and what a run actually cost (spec §5).
 *
 * ## Rows are the authority, and the check is between two different things
 *
 * `wipPosition` compares the sum of open work orders' `wip_cents` against the
 * balance on account 1450. Those are genuinely independent — one is a subledger
 * this module maintains as it issues material, the other is what the journal
 * lines add up to — so a difference is real information rather than a
 * tautology. It is the same shape Phase 14 uses for inventory and Phase 23 for
 * tenant deposits, and it is the reason `wip_cents` is stored at all.
 */

export type WipPosition = {
  asOf: string | null
  /** Sum of what open runs say they are holding. */
  registerCents: number
  /** Balance on account 1450. */
  ledgerCents: number
  differenceCents: number
  agrees: boolean
  openOrders: Array<{
    id: string
    number: string
    outputItemName: string
    plannedMilli: number
    wipCents: number
    startedOn: string | null
  }>
}

export async function wipPosition(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<WipPosition> {
  requirePermission(ctx, 'reports:view')

  const runs = await db
    .select({
      id: workOrders.id,
      number: workOrders.number,
      outputItemName: serviceItems.name,
      plannedMilli: workOrders.plannedMilli,
      wipCents: workOrders.wipCents,
      startedOn: workOrders.startedOn,
      completedOn: workOrders.completedOn,
      status: workOrders.status,
    })
    .from(workOrders)
    .innerJoin(serviceItems, eq(serviceItems.id, workOrders.outputItemId))
    .where(
      scoped(
        ctx,
        workOrders,
        // Undated, the question is the present-tense one and `wip_cents` is the
        // answer: the table's own check constraint says a settled run holds
        // nothing.
        opts.asOf ? undefined : eq(workOrders.status, 'released'),
      ),
    )
    .orderBy(asc(workOrders.number))

  /**
   * What each run was holding on `asOf` (Phase 111).
   *
   * `status = 'released'` and `wip_cents` are both present tense, and both were
   * wrong for a past date. A run released in February and finished in May is
   * not released *now*, so a March report missed it entirely; and a run still
   * open carries a `wip_cents` that includes material issued after the date. On
   * the development books the register side never moved at all:
   *
   * ```
   * 2026-03-31: agrees  12600/12600
   * 2025-12-31: DIFFERS 12600/0
   * ```
   *
   * Both halves are already recorded. `work_order_entries.occurred_on` dates
   * every absorption and is the same date the journal entry carries, and
   * `completed_on` is set — with a journal entry dated the same day — whether
   * the run finished or was cancelled. So the ledger and the subledger walk
   * back on identical dates rather than merely similar ones.
   */
  const absorbed = new Map<string, DatedMovement[]>()

  if (opts.asOf && runs.length > 0) {
    const entries = await db
      .select({
        workOrderId: workOrderEntries.workOrderId,
        on: workOrderEntries.occurredOn,
        cents: workOrderEntries.costCents,
      })
      .from(workOrderEntries)
      .where(
        scoped(
          ctx,
          workOrderEntries,
          inArray(
            workOrderEntries.workOrderId,
            runs.map((run) => run.id),
          ),
        ),
      )

    for (const entry of entries) {
      const list = absorbed.get(entry.workOrderId) ?? []
      list.push({ on: entry.on, cents: entry.cents })
      absorbed.set(entry.workOrderId, list)
    }
  }

  /**
   * One lifespan per run, decided once.
   *
   * `started_on` is set from the first issue, so a run with movements always
   * has one. Taking the earliest movement as a fallback means a run that
   * somehow absorbed cost without a start date is still counted rather than
   * silently dropped from a figure somebody reconciles against — and it is
   * computed here, once, because *whether* a run was open and *what* it held
   * are the same question asked twice, and answering them in two places is how
   * they come to disagree.
   */
  const lifespanOf = (run: (typeof runs)[number]): Lifespan => {
    const movements = absorbed.get(run.id) ?? []
    const earliest = movements.reduce<string | null>(
      (soonest, movement) => (soonest === null || movement.on < soonest ? movement.on : soonest),
      null,
    )

    return { openedOn: run.startedOn ?? earliest, closedOn: run.completedOn }
  }

  const open = opts.asOf
    ? runs
        .map((run) => ({ run, life: lifespanOf(run) }))
        .filter(({ life }) => onBooksAt(life, opts.asOf as string))
        .map(({ run, life }) => ({
          ...run,
          wipCents: heldAt(life, absorbed.get(run.id) ?? [], opts.asOf as string),
        }))
    : runs

  const wip = await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.workInProcess)

  let ledgerCents = 0
  if (wip) {
    const [row] = await db
      .select({
        value: sql<string>`coalesce(sum(${journalLines.debitCents} - ${journalLines.creditCents}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalLines.companyId, ctx.companyId),
          eq(journalLines.chartAccountId, wip.id),
          eq(journalEntries.status, 'posted'),
          opts.asOf ? lte(journalEntries.entryDate, opts.asOf) : undefined,
        ),
      )

    ledgerCents = Number(row?.value ?? 0)
  }

  const registerCents = open.reduce((sum, order) => sum + order.wipCents, 0)

  return {
    asOf: opts.asOf ?? null,
    registerCents,
    ledgerCents,
    differenceCents: registerCents - ledgerCents,
    agrees: registerCents === ledgerCents,
    openOrders: open,
  }
}

export type RunCostReport = {
  workOrderId: string
  number: string
  outputItemName: string
  status: string
  materialCents: number
  labourCents: number
  overheadCents: number
  totalCents: number
  unitCostCents: number
  yield: YieldReport
  /** Null when the run was raised without a bill of materials. */
  variances: Array<ComponentVariance & { componentItemName: string }> | null
}

/**
 * What one run cost, and how that compares with what its BOM expected.
 *
 * The variance is on **quantity**, not price. Material is issued at whatever
 * the lots cost, so a run that cost more than expected did so either because it
 * used more material or because the material had gone up — and one number
 * covering both tells a production manager nothing they can act on. This
 * answers the half they control; the other half is a purchasing question and
 * Phase 14's lot history already holds it.
 */
export async function runCost(
  ctx: ActorContext,
  workOrderId: string,
): Promise<RunCostReport> {
  requirePermission(ctx, 'accounting:view')

  const [order] = await db
    .select({
      id: workOrders.id,
      number: workOrders.number,
      outputItemName: serviceItems.name,
      bomId: workOrders.bomId,
      status: workOrders.status,
      plannedMilli: workOrders.plannedMilli,
      producedMilli: workOrders.producedMilli,
      scrappedMilli: workOrders.scrappedMilli,
      materialCents: workOrders.materialCents,
      labourCents: workOrders.labourCents,
      overheadCents: workOrders.overheadCents,
      wipCents: workOrders.wipCents,
    })
    .from(workOrders)
    .innerJoin(serviceItems, eq(serviceItems.id, workOrders.outputItemId))
    .where(scoped(ctx, workOrders, eq(workOrders.id, workOrderId)))
    .limit(1)

  if (!order) throw new Refusal('That work order does not exist.')

  const cost = unitCostOf({
    materialCents: order.materialCents,
    labourCents: order.labourCents,
    overheadCents: order.overheadCents,
    // While a run is still open, the unit cost is quoted against what was
    // *planned* — quoting it against zero produced units would show nothing,
    // and a factory watching a run wants to know whether it is on track.
    goodMilli: order.producedMilli > 0 ? order.producedMilli : order.plannedMilli,
  })

  let variances: RunCostReport['variances'] = null

  if (order.bomId) {
    const [bom] = await db
      .select({ batchMilli: billsOfMaterials.batchMilli })
      .from(billsOfMaterials)
      .where(scoped(ctx, billsOfMaterials, eq(billsOfMaterials.id, order.bomId)))
      .limit(1)

    if (bom) {
      const lines = await db
        .select({
          componentItemId: bomComponents.componentItemId,
          quantityMilli: bomComponents.quantityMilli,
          scrapBp: bomComponents.scrapBp,
        })
        .from(bomComponents)
        .where(scoped(ctx, bomComponents, eq(bomComponents.bomId, order.bomId)))
        .orderBy(asc(bomComponents.sortOrder))

      const issued = await db
        .select({
          componentItemId: workOrderEntries.itemId,
          quantityMilli: workOrderEntries.quantityMilli,
        })
        .from(workOrderEntries)
        .where(
          scoped(
            ctx,
            workOrderEntries,
            and(
              eq(workOrderEntries.workOrderId, order.id),
              eq(workOrderEntries.kind, 'material'),
            ),
          ),
        )

      const expected = explodeBom(lines, bom.batchMilli, order.plannedMilli)
      const rows = componentVariance(
        expected,
        issued
          .filter((row) => row.componentItemId !== null)
          .map((row) => ({
            componentItemId: row.componentItemId as string,
            quantityMilli: row.quantityMilli ?? 0,
          })),
      )

      const names = await itemNames(
        ctx,
        rows.map((row) => row.componentItemId),
      )

      variances = rows.map((row) => ({
        ...row,
        componentItemName: names.get(row.componentItemId) ?? 'Unknown item',
      }))
    }
  }

  return {
    workOrderId: order.id,
    number: order.number,
    outputItemName: order.outputItemName,
    status: order.status,
    materialCents: order.materialCents,
    labourCents: order.labourCents,
    overheadCents: order.overheadCents,
    totalCents: cost.totalCents,
    unitCostCents: cost.unitCostCents,
    yield: yieldOf(order.plannedMilli, order.producedMilli, order.scrappedMilli),
    variances,
  }
}

async function itemNames(ctx: ActorContext, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({ id: serviceItems.id, name: serviceItems.name })
    .from(serviceItems)
    .where(scoped(ctx, serviceItems, inArray(serviceItems.id, ids)))

  return new Map(rows.map((row) => [row.id, row.name]))
}

export type StageValue = {
  accountNumber: string
  accountName: string
  cents: number
}

/**
 * Stock value split across the three stages a manufacturer reports.
 *
 * Read off the ledger rather than off the lots, because that is the figure a
 * balance sheet shows and the question this answers is "how much of what we own
 * could be sold tomorrow". A manufacturer with £80,000 of stock of which
 * £60,000 is unmachined bar has a very different business from one holding
 * £60,000 of finished units, and one Inventory line cannot say which.
 */
export async function stageValues(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<StageValue[]> {
  requirePermission(ctx, 'reports:view')

  const numbers = [
    INDUSTRY_ACCOUNTS.rawMaterials,
    INDUSTRY_ACCOUNTS.workInProcess,
    INDUSTRY_ACCOUNTS.finishedGoods,
  ]

  const rows = await db
    .select({
      accountNumber: chartAccounts.number,
      accountName: chartAccounts.name,
      // The condition lives in the sum rather than in the WHERE.
      //
      // A left join can match a line whose entry is a draft, and those must not
      // count. Filtering them out in the WHERE would need `entry IS NOT NULL OR
      // line IS NULL` — a raw OR, which `and()` joins without parentheses, and
      // SQL binds AND tighter than OR. The filter silently became
      // `(everything else) OR line IS NULL`, which every account with no
      // activity satisfies, and the report returned the entire chart. Found in
      // a browser, not by a test, because both were the right shape.
      cents: sql<string>`
        coalesce(
          sum(
            case when ${journalEntries.id} is not null
            then ${journalLines.debitCents} - ${journalLines.creditCents}
            else 0 end
          ),
          0
        )`,
    })
    .from(chartAccounts)
    .leftJoin(journalLines, eq(journalLines.chartAccountId, chartAccounts.id))
    .leftJoin(
      journalEntries,
      and(
        eq(journalEntries.id, journalLines.journalEntryId),
        eq(journalEntries.status, 'posted'),
        opts.asOf ? lte(journalEntries.entryDate, opts.asOf) : undefined,
      ),
    )
    .where(and(eq(chartAccounts.companyId, ctx.companyId), inArray(chartAccounts.number, numbers)))
    .groupBy(chartAccounts.number, chartAccounts.name)
    .orderBy(asc(chartAccounts.number))

  return rows.map((row) => ({
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    cents: Number(row.cents ?? 0),
  }))
}

/**
 * What a finished item is actually carried at, from its open lots.
 *
 * Not the same question as `runCost`: a run's unit cost is what one batch cost,
 * and this is what the shelf is worth after several batches at different costs
 * have been mixed. A factory quoting a price wants the second.
 */
export async function finishedGoodsOnHand(ctx: ActorContext) {
  requirePermission(ctx, 'reports:view')

  // Which items this company manufactures, resolved first and on its own.
  // Joining `work_orders` into the aggregate below would multiply every lot by
  // the number of runs that ever made that item — three batches of the same
  // part would report three times the stock, and the figure would look
  // plausible right up until somebody counted the shelf.
  const made = await db
    .selectDistinct({ itemId: workOrders.outputItemId })
    .from(workOrders)
    .where(scoped(ctx, workOrders))

  if (made.length === 0) return []

  const rows = await db
    .select({
      itemId: inventoryLots.itemId,
      itemName: serviceItems.name,
      quantityMilli: sql<string>`coalesce(sum(${inventoryLots.remainingMilli}), 0)`,
      valueCents: sql<string>`coalesce(sum(${inventoryLots.remainingValueCents}), 0)`,
    })
    .from(inventoryLots)
    .innerJoin(serviceItems, eq(serviceItems.id, inventoryLots.itemId))
    .where(
      and(
        eq(inventoryLots.companyId, ctx.companyId),
        sql`${inventoryLots.remainingMilli} > 0`,
        inArray(
          inventoryLots.itemId,
          made.map((row) => row.itemId),
        ),
      ),
    )
    .groupBy(inventoryLots.itemId, serviceItems.name)
    .orderBy(asc(serviceItems.name))

  return rows.map((row) => {
    const quantityMilli = Number(row.quantityMilli ?? 0)
    const valueCents = Number(row.valueCents ?? 0)

    return {
      itemId: row.itemId,
      itemName: row.itemName,
      quantityMilli,
      valueCents,
      unitCostCents: quantityMilli > 0 ? Math.round((valueCents * 1000) / quantityMilli) : 0,
    }
  })
}
