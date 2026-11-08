import { and, eq, inArray } from 'drizzle-orm'
import { requireActor, requireSession } from '@/lib/current-user'
import { can, scoped } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { db } from '@/db'
import { chartAccounts, serviceItems } from '@/db/schema'
import { moduleEnabled } from '@/modules/industry/modules'
import {
  costMethodFor,
  listAdjustments,
  reconcileInventory,
  stockOnHand,
} from '@/modules/inventory/service'
import { listPurchaseOrders, unbilledReceipts } from '@/modules/inventory/purchasing'
import { listVendors } from '@/modules/receivables/service'
import { InventoryBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The inventory workspace (spec §5, Phase 14).
 *
 * Gated on the module rather than the industry: a landscaper on the general
 * pack who sells mulch by the yard has stock, and a consultancy on the retail
 * pack that switched it off does not.
 */
export default async function InventoryPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to inventory.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'inventory'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session.companyName}
        active="inventory"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Inventory is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-action hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to count stock, receive purchases, and post cost of goods sold.
          </p>
        </div>
      </AppShell>
    )
  }

  const [
    positions,
    orders,
    unbilled,
    adjustments,
    vendors,
    method,
    reconciliation,
    items,
    accounts,
  ] = await Promise.all([
    stockOnHand(actor),
    listPurchaseOrders(actor, { limit: 20 }),
    unbilledReceipts(actor),
    listAdjustments(actor, { limit: 20 }),
    listVendors(actor),
    costMethodFor(actor.companyId),
    reconcileInventory(actor),
    db
      .select({
        id: serviceItems.id,
        name: serviceItems.name,
        unit: serviceItems.unit,
        // Phase 201: the two the board can now change. Read here rather than
        // through `stockOnHand`, whose rows are a costing answer — an account
        // choice is a property of the item, not of the position.
        inventoryAccountId: serviceItems.inventoryAccountId,
        cogsAccountId: serviceItems.cogsAccountId,
      })
      .from(serviceItems)
      .where(scoped(actor, serviceItems, eq(serviceItems.isInventoried, true))),
    /*
      The accounts an item may post to (Phase 201).

      Queried here rather than through `coa/service`'s `listAccounts`, which
      gates on `bookkeeping:view` while this page gates on `accounting:view` —
      two permissions, and a picker that threw for somebody who can see the
      screen would be a worse bug than the one this closes.

      Narrowed to the two types that can answer: stock is an asset and its cost
      is a cost of sale. Offering the whole chart would let somebody book
      inventory to Accounts Receivable, which `categorizableAccounts` refuses
      for the same reason.
    */
    db
      .select({
        id: chartAccounts.id,
        number: chartAccounts.number,
        name: chartAccounts.name,
        type: chartAccounts.type,
      })
      .from(chartAccounts)
      .where(
        scoped(
          actor,
          chartAccounts,
          and(
            eq(chartAccounts.isActive, true),
            inArray(chartAccounts.type, ['asset', 'cogs']),
          ),
        ),
      )
      .orderBy(chartAccounts.number),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="inventory"
    >
      <InventoryBoard
        positions={positions}
        orders={orders.map((order) => ({
          id: order.id,
          number: order.number,
          orderedOn: order.orderedOn,
          status: order.status,
          totalCents: order.totalCents,
          vendorName: order.vendorName,
        }))}
        unbilled={unbilled.map((row) => ({
          id: row.id,
          number: row.number,
          receivedOn: row.receivedOn,
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          totalCents: row.totalCents,
        }))}
        adjustments={adjustments.map((row) => ({
          id: row.id,
          adjustedOn: row.adjustedOn,
          itemName: row.itemName,
          expectedMilli: row.expectedMilli,
          countedMilli: row.countedMilli,
          valueChangeCents: row.valueChangeCents,
          reason: row.reason,
        }))}
        vendors={vendors.map((vendor) => ({ id: vendor.id, name: vendor.name }))}
        items={items}
        accounts={accounts}
        costMethod={method}
        reconciliation={reconciliation}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
