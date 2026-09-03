import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  inventoryLots,
  invoiceCostings,
  journalEntries,
  journalLines,
  serviceItems,
  stockAdjustments,
  stockMovements,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import { creditableByReceipt } from './receipt-credit'
import {
  applyConsumption,
  consume,
  extend,
  quantityOnHand,
  reversalLot,
  valueOnHand,
  type Consumption,
  type CostMethod,
  type Lot,
} from './costing'

/**
 * Perpetual inventory (spec §5, §13).
 *
 * ## The invariant everything here defends
 *
 * ```
 *   Σ(open lots' value)  ==  balance of the Inventory account in the ledger
 * ```
 *
 * Every function that moves stock writes the lot change and the journal entry
 * **in one transaction**, and the entry's amount is whatever the costing
 * function said — never a figure computed a second time. Two computations of
 * the same number is how a subledger drifts.
 *
 * `reconcileInventory` asserts the identity, and a test runs it over a busy set
 * of books. An inventory subledger that has quietly diverged from the ledger is
 * the single commonest reason a small business's balance sheet cannot be
 * signed, and the divergence is usually a rounding difference nobody can trace
 * because it accumulated a cent at a time.
 *
 * ## Where the postings go
 *
 * ```
 *   Goods arrive        Dr Inventory              Cr Goods Received Not Invoiced
 *   Supplier invoices   Dr Goods Received…        Cr Accounts Payable
 *   Sold                Dr Cost of Goods Sold     Cr Inventory
 *   Count is short      Dr Inventory Shrinkage    Cr Inventory
 *   Returned by a customer   Dr Inventory         Cr Cost of Goods Sold
 * ```
 */

export type InventoryAccounts = {
  inventoryId: string
  cogsId: string
  shrinkageId: string
  grniId: string
}

/**
 * The accounts an inventory posting needs.
 *
 * Per item where the item names its own, falling back to the standard chart.
 * A business that keeps raw materials and finished goods on separate balance
 * sheet lines sets them on the items; everybody else never thinks about it.
 */
export async function inventoryAccounts(
  companyId: string,
  item?: { inventoryAccountId: string | null; cogsAccountId: string | null },
  exec: Executor = db,
): Promise<InventoryAccounts> {
  const [inventory, cogs, shrinkage, grni] = await Promise.all([
    accountByNumber(companyId, SYSTEM_ACCOUNTS.inventory, exec),
    accountByNumber(companyId, SYSTEM_ACCOUNTS.costOfGoodsSold, exec),
    accountByNumber(companyId, SYSTEM_ACCOUNTS.inventoryShrinkage, exec),
    accountByNumber(companyId, SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced, exec),
  ])

  if (!inventory || !cogs || !shrinkage || !grni) {
    throw new Error(
      'The chart of accounts is missing an inventory account. Expected 1400, 5000, 5400, and 2050.',
    )
  }

  return {
    inventoryId: item?.inventoryAccountId ?? inventory.id,
    cogsId: item?.cogsAccountId ?? cogs.id,
    shrinkageId: shrinkage.id,
    grniId: grni.id,
  }
}

/** The company's cost method. One setting, not one per item. */
export async function costMethodFor(companyId: string, exec: Executor = db): Promise<CostMethod> {
  const { companies } = await import('@/db/schema')
  const [company] = await exec
    .select({ method: companies.inventoryCostMethod })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)

  return (company?.method as CostMethod) ?? 'weighted_average'
}

/** Open lots for one item, oldest first — the input to every consumption. */
export async function openLots(
  companyId: string,
  itemId: string,
  exec: Executor = db,
): Promise<Lot[]> {
  const rows = await exec
    .select({
      id: inventoryLots.id,
      remainingMilli: inventoryLots.remainingMilli,
      remainingValueCents: inventoryLots.remainingValueCents,
      unitCostCents: inventoryLots.unitCostCents,
      receivedAt: inventoryLots.receivedOn,
    })
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.companyId, companyId),
        eq(inventoryLots.itemId, itemId),
        gt(inventoryLots.remainingMilli, 0),
      ),
    )
    .orderBy(asc(inventoryLots.receivedOn), asc(inventoryLots.id))

  return rows
}

export type StockPosition = {
  itemId: string
  code: string | null
  name: string
  unit: string
  quantityMilli: number
  valueCents: number
  averageUnitCostCents: number | null
  reorderPointMilli: number | null
  belowReorderPoint: boolean
}

/** What is on hand, and what it is worth. */
export async function stockOnHand(ctx: ActorContext): Promise<StockPosition[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      itemId: serviceItems.id,
      code: serviceItems.code,
      name: serviceItems.name,
      unit: serviceItems.unit,
      reorderPointMilli: serviceItems.reorderPointMilli,
      quantityMilli: sql<string>`coalesce(sum(${inventoryLots.remainingMilli}), 0)`,
      valueCents: sql<string>`coalesce(sum(${inventoryLots.remainingValueCents}), 0)`,
    })
    .from(serviceItems)
    .leftJoin(
      inventoryLots,
      and(eq(inventoryLots.itemId, serviceItems.id), gt(inventoryLots.remainingMilli, 0)),
    )
    .where(scoped(ctx, serviceItems, eq(serviceItems.isInventoried, true)))
    .groupBy(
      serviceItems.id,
      serviceItems.code,
      serviceItems.name,
      serviceItems.unit,
      serviceItems.reorderPointMilli,
    )
    .orderBy(asc(serviceItems.name))

  return rows.map((row) => {
    const quantityMilli = Number(row.quantityMilli)
    const valueCents = Number(row.valueCents)

    return {
      itemId: row.itemId,
      code: row.code,
      name: row.name,
      unit: row.unit,
      quantityMilli,
      valueCents,
      averageUnitCostCents:
        quantityMilli === 0 ? null : Math.round((valueCents * 1000) / quantityMilli),
      reorderPointMilli: row.reorderPointMilli,
      belowReorderPoint:
        row.reorderPointMilli !== null && quantityMilli <= row.reorderPointMilli,
    }
  })
}

export type ReceiveStockInput = {
  itemId: string
  quantityMilli: number
  unitCostCents: number
  receivedOn: string
  /** Where the other side of the entry goes. */
  creditAccountId: string
  sourceType?: string
  sourceId?: string
  memo?: string
}

/**
 * Brings stock in.
 *
 * The shared path for a goods receipt, an opening balance, and a customer
 * return — they differ only in what gets credited, which is why that is a
 * parameter rather than three near-copies of this function.
 *
 * **And why that parameter is checked (Phase 117).** Naming three legitimate
 * values without naming what is illegitimate is how the fourth gets in, and it
 * did: this repository's own seed credited `2000 Accounts Payable` on four
 * receipts, leaving two demo companies owing money on the balance sheet with no
 * bill, no supplier and no due date behind it. `receipt-credit.ts` holds the one
 * class that is refused, and why.
 */
export async function receiveStock(
  ctx: ActorContext,
  input: ReceiveStockInput,
  exec?: Executor,
): Promise<{ lotId: string; costCents: number }> {
  const run = async (tx: Executor) => {
    const item = await requireInventoriedItem(ctx, input.itemId, tx)
    const accounts = await inventoryAccounts(ctx.companyId, item, tx)

    if (input.quantityMilli <= 0) throw new Error('A receipt has to bring something in.')
    if (input.unitCostCents < 0) throw new Error('A negative cost is a mistake, not a discount.')

    // Where the other side of the entry goes is the caller's to choose, except
    // for one class it may never be (Phase 117).
    const [creditAccount] = await tx
      .select({ number: chartAccounts.number, name: chartAccounts.name })
      .from(chartAccounts)
      .where(scoped(ctx, chartAccounts, eq(chartAccounts.id, input.creditAccountId)))
      .limit(1)

    if (!creditAccount) throw new Error('That account is not on this chart.')

    const verdict = creditableByReceipt(creditAccount)
    if (!verdict.ok) throw new Error(verdict.why)

    const costCents = extend(input.quantityMilli, input.unitCostCents)

    const [lot] = await tx
      .insert(inventoryLots)
      .values({
        companyId: ctx.companyId,
        itemId: input.itemId,
        receivedMilli: input.quantityMilli,
        remainingMilli: input.quantityMilli,
        remainingValueCents: costCents,
        unitCostCents: input.unitCostCents,
        receivedOn: input.receivedOn,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      })
      .returning()

    // The entry's amount is the figure the lot was written with. Computing it
    // twice is how a subledger and a ledger start to disagree.
    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.receivedOn,
        memo: input.memo ?? `Stock received — ${item.name}`,
        source: 'manual',
        sourceType: input.sourceType ?? 'stock_receipt',
        sourceId: input.sourceId ?? lot.id,
        lines: [
          { chartAccountId: accounts.inventoryId, debitCents: costCents, memo: item.name },
          { chartAccountId: input.creditAccountId, creditCents: costCents, memo: item.name },
        ],
      },
      tx,
    )

    await tx.insert(stockMovements).values({
      companyId: ctx.companyId,
      itemId: input.itemId,
      kind: 'receipt',
      movedOn: input.receivedOn,
      quantityMilli: input.quantityMilli,
      costCents,
      lotBreakdown: JSON.stringify([
        { lotId: lot.id, quantityMilli: input.quantityMilli, costCents },
      ]),
      memo: input.memo ?? null,
      sourceType: input.sourceType ?? 'stock_receipt',
      sourceId: input.sourceId ?? lot.id,
      journalEntryId: entry.id,
      createdBy: ctx.userId,
    })

    return { lotId: lot.id, costCents }
  }

  return exec ? run(exec) : db.transaction(run)
}

export type ConsumeStockResult = {
  costCents: number
  consumed: Consumption[]
  shortfallMilli: number
}

/**
 * Takes stock out, and posts what it cost to wherever it went.
 *
 * The shared path for a sale and — since Phase 27 — for material issued to a
 * work order. They differ only in which account is debited, what the movement
 * is called, and what the entry is filed under, which is why those are
 * parameters rather than two near-copies of a function that decides a cost.
 * `receiveStock` has taken its `creditAccountId` the same way since Phase 14;
 * this is the other half of that seam.
 *
 * Returns the consumption so the caller can record it against the document —
 * a return has to put the stock back at the cost it left at, and that is only
 * knowable if the decision was written down.
 */
export async function consumeStock(
  ctx: ActorContext,
  input: {
    itemId: string
    quantityMilli: number
    movedOn: string
    /** Where the cost lands. COGS for a sale, WIP for a work order. */
    debitAccountId?: string
    kind?: 'sale' | 'work_order_issue'
    source: 'invoice' | 'manual'
    sourceType: string
    /** Suffix on the entry's `sourceType`, so the posting can be found. */
    entrySourceType?: string
    sourceId: string
    memo?: string
  },
  exec: Executor,
): Promise<ConsumeStockResult> {
  const item = await requireInventoriedItem(ctx, input.itemId, exec)
  const accounts = await inventoryAccounts(ctx.companyId, item, exec)
  const method = await costMethodFor(ctx.companyId, exec)

  const lots = await openLots(ctx.companyId, input.itemId, exec)
  const result = consume(lots, input.quantityMilli, method)

  if (result.consumed.length === 0) {
    // Nothing on hand. The sale still happens — refusing would mean the books
    // cannot record something the business did — and the shortfall is returned
    // so the caller can say so.
    return { costCents: 0, consumed: [], shortfallMilli: result.shortfallMilli }
  }

  for (const entry of result.consumed) {
    await exec
      .update(inventoryLots)
      .set({
        remainingMilli: sql`${inventoryLots.remainingMilli} - ${entry.quantityMilli}`,
        remainingValueCents: sql`${inventoryLots.remainingValueCents} - ${entry.costCents}`,
      })
      .where(eq(inventoryLots.id, entry.lotId))
  }

  const journal = await createJournalEntry(
    ctx,
    {
      entryDate: input.movedOn,
      memo: input.memo ?? `Cost of goods sold — ${item.name}`,
      source: input.source,
      sourceType: input.entrySourceType ?? `${input.sourceType}_cogs`,
      sourceId: input.sourceId,
      lines: [
        {
          chartAccountId: input.debitAccountId ?? accounts.cogsId,
          debitCents: result.totalCostCents,
          memo: item.name,
        },
        {
          chartAccountId: accounts.inventoryId,
          creditCents: result.totalCostCents,
          memo: item.name,
        },
      ],
    },
    exec,
  )

  await exec.insert(stockMovements).values({
    companyId: ctx.companyId,
    itemId: input.itemId,
    kind: input.kind ?? 'sale',
    movedOn: input.movedOn,
    quantityMilli: -(input.quantityMilli - result.shortfallMilli),
    costCents: -result.totalCostCents,
    lotBreakdown: JSON.stringify(result.consumed),
    memo: input.memo ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    journalEntryId: journal.id,
    createdBy: ctx.userId,
  })

  return {
    costCents: result.totalCostCents,
    consumed: result.consumed,
    shortfallMilli: result.shortfallMilli,
  }
}

/**
 * Takes stock out for a sale, and posts the cost to COGS.
 *
 * Kept as its own name because every caller since Phase 14 uses it and the
 * defaults it fills in — COGS, `sale`, an `invoice`-sourced entry — are the
 * decisions that make a sale a sale.
 */
export async function consumeStockForSale(
  ctx: ActorContext,
  input: {
    itemId: string
    quantityMilli: number
    soldOn: string
    sourceType: string
    sourceId: string
    memo?: string
  },
  exec: Executor,
): Promise<ConsumeStockResult> {
  return consumeStock(
    ctx,
    {
      itemId: input.itemId,
      quantityMilli: input.quantityMilli,
      movedOn: input.soldOn,
      kind: 'sale',
      source: 'invoice',
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      memo: input.memo,
    },
    exec,
  )
}

/**
 * Counts what is actually there and books the difference.
 *
 * The variance goes to Inventory Shrinkage rather than Cost of Goods Sold.
 * Stock that was sold and stock that went missing are different facts about a
 * business, and a gross margin quietly containing theft explains nothing to the
 * person reading it.
 *
 * A count that finds *more* than expected credits the same account, which reads
 * oddly and is right: the earlier shortfall it reverses was booked there too.
 */
export async function adjustStock(
  ctx: ActorContext,
  input: { itemId: string; countedMilli: number; adjustedOn: string; reason: string },
): Promise<{ varianceMilli: number; valueChangeCents: number }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'inventory')

  const reason = input.reason.trim()
  if (!reason) {
    throw new Error(
      'Say why the count differs. Stock that vanished with no explanation is theft, breakage, ' +
        'or a counting error, and which one changes what to do next.',
    )
  }
  if (input.countedMilli < 0) throw new Error('A count cannot be negative.')

  return db.transaction(async (tx) => {
    const item = await requireInventoriedItem(ctx, input.itemId, tx)
    const accounts = await inventoryAccounts(ctx.companyId, item, tx)
    const method = await costMethodFor(ctx.companyId, tx)

    const lots = await openLots(ctx.companyId, input.itemId, tx)
    const expectedMilli = quantityOnHand(lots)
    const varianceMilli = input.countedMilli - expectedMilli

    if (varianceMilli === 0) {
      // Still recorded. "We counted and it was right" is a fact worth keeping,
      // and it posts nothing because nothing changed.
      await tx.insert(stockAdjustments).values({
        companyId: ctx.companyId,
        itemId: input.itemId,
        adjustedOn: input.adjustedOn,
        expectedMilli,
        countedMilli: input.countedMilli,
        valueChangeCents: 0,
        reason,
        createdBy: ctx.userId,
      })

      return { varianceMilli: 0, valueChangeCents: 0 }
    }

    let valueChangeCents: number
    let breakdown: Consumption[] = []

    if (varianceMilli < 0) {
      const result = consume(lots, -varianceMilli, method)
      breakdown = result.consumed
      valueChangeCents = -result.totalCostCents

      for (const entry of result.consumed) {
        await tx
          .update(inventoryLots)
          .set({
            remainingMilli: sql`${inventoryLots.remainingMilli} - ${entry.quantityMilli}`,
            remainingValueCents: sql`${inventoryLots.remainingValueCents} - ${entry.costCents}`,
          })
          .where(eq(inventoryLots.id, entry.lotId))
      }
    } else {
      // Found more than the books said. Valued at the current average, because
      // there is no receipt behind it to take a cost from — and where there is
      // nothing on hand at all, at the item's standing cost assumption.
      const unitCostCents =
        expectedMilli > 0
          ? Math.round((valueOnHand(lots) * 1000) / expectedMilli)
          : item.unitCostCents

      const [lot] = await tx
        .insert(inventoryLots)
        .values({
          companyId: ctx.companyId,
          itemId: input.itemId,
          receivedMilli: varianceMilli,
          remainingMilli: varianceMilli,
          remainingValueCents: extend(varianceMilli, unitCostCents),
          unitCostCents,
          receivedOn: input.adjustedOn,
          sourceType: 'stock_adjustment',
        })
        .returning()

      valueChangeCents = extend(varianceMilli, unitCostCents)
      breakdown = [{ lotId: lot.id, quantityMilli: varianceMilli, costCents: valueChangeCents }]
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.adjustedOn,
        memo: `Stock adjustment — ${item.name}: ${reason}`,
        source: 'adjusting',
        sourceType: 'stock_adjustment',
        lines:
          valueChangeCents < 0
            ? [
                {
                  chartAccountId: accounts.shrinkageId,
                  debitCents: -valueChangeCents,
                  memo: reason,
                },
                {
                  chartAccountId: accounts.inventoryId,
                  creditCents: -valueChangeCents,
                  memo: item.name,
                },
              ]
            : [
                {
                  chartAccountId: accounts.inventoryId,
                  debitCents: valueChangeCents,
                  memo: item.name,
                },
                {
                  chartAccountId: accounts.shrinkageId,
                  creditCents: valueChangeCents,
                  memo: reason,
                },
              ],
      },
      tx,
    )

    const [adjustment] = await tx
      .insert(stockAdjustments)
      .values({
        companyId: ctx.companyId,
        itemId: input.itemId,
        adjustedOn: input.adjustedOn,
        expectedMilli,
        countedMilli: input.countedMilli,
        valueChangeCents,
        reason,
        journalEntryId: entry.id,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(stockMovements).values({
      companyId: ctx.companyId,
      itemId: input.itemId,
      kind: 'adjustment',
      movedOn: input.adjustedOn,
      quantityMilli: varianceMilli,
      costCents: valueChangeCents,
      lotBreakdown: JSON.stringify(breakdown),
      reason,
      sourceType: 'stock_adjustment',
      sourceId: adjustment.id,
      journalEntryId: entry.id,
      createdBy: ctx.userId,
    })

    await recordAudit(
      ctx,
      {
        action: 'stock.adjust',
        entityType: 'stock_adjustment',
        entityId: adjustment.id,
        after: {
          item: item.name,
          expectedMilli,
          countedMilli: input.countedMilli,
          valueChangeCents,
          reason,
        },
      },
      tx,
    )

    return { varianceMilli, valueChangeCents }
  })
}

/**
 * Puts stock back when a sale is undone, at the cost it left at.
 *
 * Reads the frozen consumption from `invoice_costings` rather than valuing at
 * today's average. Restoring at today's cost invents value out of nothing: sell
 * at $4, prices rise, take the return in at $6, and $2 of inventory exists with
 * no transaction behind it.
 */
export async function returnStockFromSale(
  ctx: ActorContext,
  invoiceId: string,
  returnedOn: string,
  exec: Executor,
): Promise<number> {
  const costings = await exec
    .select()
    .from(invoiceCostings)
    .where(
      and(eq(invoiceCostings.companyId, ctx.companyId), eq(invoiceCostings.invoiceId, invoiceId)),
    )

  let restoredCents = 0

  for (const costing of costings) {
    const consumed = JSON.parse(costing.lotBreakdown) as Consumption[]
    const lot = reversalLot(consumed, returnedOn, 'pending')
    if (!lot) continue

    const item = await requireInventoriedItem(ctx, costing.itemId, exec)
    const accounts = await inventoryAccounts(ctx.companyId, item, exec)

    const [created] = await exec
      .insert(inventoryLots)
      .values({
        companyId: ctx.companyId,
        itemId: costing.itemId,
        receivedMilli: lot.remainingMilli,
        remainingMilli: lot.remainingMilli,
        remainingValueCents: lot.remainingValueCents,
        unitCostCents: lot.unitCostCents,
        receivedOn: returnedOn,
        sourceType: 'sale_return',
        sourceId: invoiceId,
      })
      .returning()

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: returnedOn,
        memo: `Stock returned — ${item.name}`,
        source: 'invoice',
        sourceType: 'sale_return',
        sourceId: invoiceId,
        lines: [
          { chartAccountId: accounts.inventoryId, debitCents: costing.costCents, memo: item.name },
          { chartAccountId: accounts.cogsId, creditCents: costing.costCents, memo: item.name },
        ],
      },
      exec,
    )

    await exec.insert(stockMovements).values({
      companyId: ctx.companyId,
      itemId: costing.itemId,
      kind: 'sale_return',
      movedOn: returnedOn,
      quantityMilli: costing.quantityMilli,
      costCents: costing.costCents,
      lotBreakdown: JSON.stringify([
        { lotId: created.id, quantityMilli: costing.quantityMilli, costCents: costing.costCents },
      ]),
      sourceType: 'sale_return',
      sourceId: invoiceId,
      journalEntryId: entry.id,
      createdBy: ctx.userId,
    })

    restoredCents += costing.costCents
  }

  return restoredCents
}

export type InventoryReconciliation = {
  subledgerCents: number
  ledgerCents: number
  differenceCents: number
  /** True when the lots and the Inventory account agree, as they must. */
  agrees: boolean
}

/**
 * Checks the subledger against the ledger (spec §13).
 *
 * The same shape as Phase 7's AR-control check and for the same reason: the
 * two are computed by different code from different tables, so agreement is
 * evidence rather than tautology. Surfaced in the UI rather than only asserted
 * in a test, because the drift that matters happens in production.
 */
export async function reconcileInventory(
  ctx: ActorContext,
  opts: { asOfDate?: string } = {},
): Promise<InventoryReconciliation> {
  requirePermission(ctx, 'reports:view')

  const [lots] = await db
    .select({
      value: sql<string>`coalesce(sum(${inventoryLots.remainingValueCents}), 0)`,
    })
    .from(inventoryLots)
    .where(and(eq(inventoryLots.companyId, ctx.companyId), gt(inventoryLots.remainingMilli, 0)))

  /**
   * What moved since the date asked about (Phase 109).
   *
   * `remaining_value_cents` is a running column: it says what the lots are
   * worth *now*. Compared against a ledger walked back with `entry_date <=
   * asOfDate`, that reported a difference on correct books for every date but
   * today — measured at $28,559.20 for 31 March on the development database,
   * as a **fault**. This file's own comment names the cost of that: "a
   * reconciliation that cries wolf is one people learn to ignore."
   *
   * `stock_movements.cost_cents` is already signed — a receipt is positive and
   * an issue negative — so subtracting everything dated after the day gives
   * what the lots were worth on it, with no case analysis over movement kinds.
   */
  const [moved] = opts.asOfDate
    ? await db
        .select({ value: sql<string>`coalesce(sum(${stockMovements.costCents}), 0)` })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.companyId, ctx.companyId),
            gt(stockMovements.movedOn, opts.asOfDate),
          ),
        )
    : [{ value: '0' }]

  const inventoryAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.inventory)
  if (!inventoryAccount) throw new Error('The Inventory account is missing from the chart.')

  /**
   * Every account stock is actually carried on, not just 1400.
   *
   * An item may name its own inventory account, and Phase 27's manufacturer
   * does exactly that — raw materials on 1440, finished goods on 1460, and
   * nothing at all on 1400. Comparing all the lots against 1400 alone reported
   * a difference the size of the whole subledger, on books that were perfectly
   * correct, which is worse than not checking: a reconciliation that cries wolf
   * is one people learn to ignore.
   *
   * The default is always included, because an item that names no account
   * lands there.
   */
  const named = await db
    .selectDistinct({ id: serviceItems.inventoryAccountId })
    .from(serviceItems)
    .where(
      and(
        eq(serviceItems.companyId, ctx.companyId),
        eq(serviceItems.isInventoried, true),
        isNotNull(serviceItems.inventoryAccountId),
      ),
    )

  const accountIds = [
    inventoryAccount.id,
    ...named.map((row) => row.id as string).filter((id) => id !== inventoryAccount.id),
  ]

  const [ledger] = await db
    .select({
      value: sql<string>`coalesce(sum(${journalLines.debitCents} - ${journalLines.creditCents}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        inArray(journalLines.chartAccountId, accountIds),
        eq(journalEntries.status, 'posted'),
        opts.asOfDate ? sql`${journalEntries.entryDate} <= ${opts.asOfDate}` : undefined,
      ),
    )

  const subledgerCents = Number(lots?.value ?? 0) - Number(moved?.value ?? 0)
  const ledgerCents = Number(ledger?.value ?? 0)

  return {
    subledgerCents,
    ledgerCents,
    differenceCents: subledgerCents - ledgerCents,
    agrees: subledgerCents === ledgerCents,
  }
}

/** Movement history for one item, newest first. */
export async function movementsForItem(
  ctx: ActorContext,
  itemId: string,
  opts: { limit?: number } = {},
) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select()
    .from(stockMovements)
    .where(scoped(ctx, stockMovements, eq(stockMovements.itemId, itemId)))
    .orderBy(desc(stockMovements.movedOn), desc(stockMovements.createdAt))
    .limit(opts.limit ?? 50)
}

/** Adjustment history, for the count trail. */
export async function listAdjustments(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: stockAdjustments.id,
      adjustedOn: stockAdjustments.adjustedOn,
      itemName: serviceItems.name,
      expectedMilli: stockAdjustments.expectedMilli,
      countedMilli: stockAdjustments.countedMilli,
      valueChangeCents: stockAdjustments.valueChangeCents,
      reason: stockAdjustments.reason,
    })
    .from(stockAdjustments)
    .innerJoin(serviceItems, eq(serviceItems.id, stockAdjustments.itemId))
    .where(scoped(ctx, stockAdjustments))
    .orderBy(desc(stockAdjustments.adjustedOn))
    .limit(opts.limit ?? 50)
}

/**
 * Loads an item and insists it is one that carries stock.
 *
 * A service cannot be received, sold at cost, or counted, and quietly treating
 * one as though it could would put a value on the balance sheet for something
 * that does not exist.
 */
async function requireInventoriedItem(ctx: ActorContext, itemId: string, exec: Executor) {
  const [item] = await exec
    .select()
    .from(serviceItems)
    .where(and(eq(serviceItems.companyId, ctx.companyId), eq(serviceItems.id, itemId)))
    .limit(1)

  if (!item) throw new Error('Item not found')
  if (!item.isInventoried) {
    throw new Error(
      `${item.name} is not a stocked item. Switch stock tracking on for it first, or use a plain invoice line.`,
    )
  }

  return item
}

/** Preview: what a sale of this quantity would cost, without writing anything. */
export async function previewSaleCost(
  ctx: ActorContext,
  itemId: string,
  quantityMilli: number,
): Promise<{ costCents: number; shortfallMilli: number; remainingAfter: number }> {
  requirePermission(ctx, 'accounting:view')

  const method = await costMethodFor(ctx.companyId)
  const lots = await openLots(ctx.companyId, itemId)
  const result = consume(lots, quantityMilli, method)

  return {
    costCents: result.totalCostCents,
    shortfallMilli: result.shortfallMilli,
    remainingAfter: quantityOnHand(applyConsumption(lots, result.consumed)),
  }
}

/** Items below their reorder point, for the purchasing screen. */
export async function reorderList(ctx: ActorContext): Promise<StockPosition[]> {
  const positions = await stockOnHand(ctx)
  return positions.filter((position) => position.belowReorderPoint)
}
