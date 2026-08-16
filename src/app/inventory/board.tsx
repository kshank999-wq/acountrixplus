'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  adjustStockAction,
  createPurchaseOrderAction,
  receiveGoodsAction,
  saveItemAction,
} from '@/app/actions/inventory'
import { COST_METHOD_LABELS } from '@/modules/inventory/costing'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Position = {
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

type Order = {
  id: string
  number: string
  orderedOn: string
  status: string
  totalCents: number
  vendorName: string
}

type Unbilled = {
  id: string
  number: string
  receivedOn: string
  vendorName: string
  totalCents: number
}

type Adjustment = {
  id: string
  adjustedOn: string
  itemName: string
  expectedMilli: number
  countedMilli: number
  valueChangeCents: number
  reason: string
}

type Named = { id: string; name: string; unit?: string }

/** Thousandths to a readable quantity. */
function units(milli: number): string {
  const value = milli / 1000
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '')
}

export function InventoryBoard({
  positions,
  orders,
  unbilled,
  adjustments,
  vendors,
  items,
  costMethod,
  reconciliation,
  canManage,
}: {
  positions: Position[]
  orders: Order[]
  unbilled: Unbilled[]
  adjustments: Adjustment[]
  vendors: Named[]
  items: Named[]
  costMethod: 'fifo' | 'weighted_average'
  reconciliation: { subledgerCents: number; ledgerCents: number; differenceCents: number; agrees: boolean }
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const today = new Date().toISOString().slice(0, 10)

  const [counting, setCounting] = useState<string | null>(null)
  const [counted, setCounted] = useState('')
  const [reason, setReason] = useState('')

  const [showItem, setShowItem] = useState(false)
  const [itemName, setItemName] = useState('')
  const [itemUnit, setItemUnit] = useState('each')
  const [itemPrice, setItemPrice] = useState('')
  const [itemCost, setItemCost] = useState('')

  const [showReceive, setShowReceive] = useState(false)
  const [receiveVendor, setReceiveVendor] = useState(vendors[0]?.id ?? '')
  const [receiveItem, setReceiveItem] = useState(items[0]?.id ?? '')
  const [receiveQuantity, setReceiveQuantity] = useState('')
  const [receiveCost, setReceiveCost] = useState('')

  const [showOrder, setShowOrder] = useState(false)
  const [orderVendor, setOrderVendor] = useState(vendors[0]?.id ?? '')
  const [orderItem, setOrderItem] = useState(items[0]?.id ?? '')
  const [orderQuantity, setOrderQuantity] = useState('')
  const [orderCost, setOrderCost] = useState('')

  const totalValueCents = positions.reduce((sum, position) => sum + position.valueCents, 0)
  const lowCount = positions.filter((position) => position.belowReorderPoint).length

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) {
        setCounting(null)
        setCounted('')
        setReason('')
        setShowItem(false)
        setShowReceive(false)
        setShowOrder(false)
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Inventory</h2>
          <p className="text-sm text-muted">
            Costed on {COST_METHOD_LABELS[costMethod].toLowerCase()}. Stock moves and the ledger
            move together.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost text-xs" onClick={() => setShowItem((v) => !v)}>
              New item
            </button>
            <button className="btn btn-ghost text-xs" onClick={() => setShowOrder((v) => !v)}>
              Purchase order
            </button>
            <button className="btn btn-primary text-xs" onClick={() => setShowReceive((v) => !v)}>
              Receive stock
            </button>
          </div>
        )}
      </header>

      {message && (
        <p
          className={`card p-3 text-sm ${message.ok ? 'text-positive' : 'border-danger/40 text-negative'}`}
          role="status"
        >
          {message.text}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Stock on hand" value={formatCents(totalValueCents)} />
        <Stat
          label="Awaiting a supplier bill"
          value={formatCents(unbilled.reduce((sum, row) => sum + row.totalCents, 0))}
          hint={`${unbilled.length} receipt${unbilled.length === 1 ? '' : 's'} in Goods Received Not Invoiced`}
        />
        <Stat
          label="Below reorder point"
          value={String(lowCount)}
          tone={lowCount > 0 ? 'bad' : undefined}
        />
      </div>

      {/* The subledger identity, shown rather than only asserted in a test. */}
      <p
        className={`card p-3 text-xs ${reconciliation.agrees ? 'text-muted' : 'border-danger/40 text-danger'}`}
      >
        {reconciliation.agrees ? (
          <>
            Stock records and the Inventory account agree at{' '}
            {formatCents(reconciliation.subledgerCents)}. They are computed separately, so
            agreeing is evidence rather than arithmetic.
          </>
        ) : (
          <>
            Stock records say {formatCents(reconciliation.subledgerCents)} and the Inventory
            account says {formatCents(reconciliation.ledgerCents)} —{' '}
            {formatCents(reconciliation.differenceCents)} apart. Something wrote to one without
            the other.
          </>
        )}
      </p>

      {showItem && canManage && (
        <section className="card p-4">
          <h3 className="text-sm font-semibold">New stocked item</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Name</span>
              <input
                value={itemName}
                onChange={(event) => setItemName(event.target.value)}
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Unit</span>
              <input
                value={itemUnit}
                onChange={(event) => setItemUnit(event.target.value)}
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Sells for</span>
              <input
                value={itemPrice}
                onChange={(event) => setItemPrice(event.target.value)}
                placeholder="0.00"
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Usual cost</span>
              <input
                value={itemCost}
                onChange={(event) => setItemCost(event.target.value)}
                placeholder="0.00"
                className="field w-full py-1.5 text-sm"
              />
            </label>
          </div>
          <button
            className="btn btn-primary mt-3"
            disabled={pending || !itemName.trim()}
            onClick={() =>
              act(() =>
                saveItemAction({
                  name: itemName,
                  unit: itemUnit || 'each',
                  unitPriceCents: itemPrice ? (parseAmountToCents(itemPrice) ?? 0) : 0,
                  unitCostCents: itemCost ? (parseAmountToCents(itemCost) ?? 0) : 0,
                  isInventoried: true,
                }),
              )
            }
          >
            Add item
          </button>
        </section>
      )}

      {showOrder && canManage && (
        <section className="card p-4">
          <h3 className="text-sm font-semibold">Purchase order</h3>
          <p className="mt-0.5 text-xs text-muted">
            An order posts nothing. It is a commitment to buy — the books move when the goods
            arrive.
          </p>
          <PurchaseForm
            vendors={vendors}
            items={items}
            vendorId={orderVendor}
            setVendorId={setOrderVendor}
            itemId={orderItem}
            setItemId={setOrderItem}
            quantity={orderQuantity}
            setQuantity={setOrderQuantity}
            cost={orderCost}
            setCost={setOrderCost}
          />
          <button
            className="btn btn-primary mt-3"
            disabled={pending || !orderVendor || !orderItem || !orderQuantity}
            onClick={() =>
              act(() =>
                createPurchaseOrderAction({
                  vendorId: orderVendor,
                  orderedOn: today,
                  lines: [
                    {
                      itemId: orderItem,
                      quantity: Number(orderQuantity),
                      unitCostCents: parseAmountToCents(orderCost || '0') ?? 0,
                    },
                  ],
                }),
              )
            }
          >
            Raise order
          </button>
        </section>
      )}

      {showReceive && canManage && (
        <section className="card p-4">
          <h3 className="text-sm font-semibold">Receive stock</h3>
          <p className="mt-0.5 text-xs text-muted">
            Posts Dr Inventory / Cr Goods Received Not Invoiced — the stock is yours and no
            supplier has invoiced yet.
          </p>
          <PurchaseForm
            vendors={vendors}
            items={items}
            vendorId={receiveVendor}
            setVendorId={setReceiveVendor}
            itemId={receiveItem}
            setItemId={setReceiveItem}
            quantity={receiveQuantity}
            setQuantity={setReceiveQuantity}
            cost={receiveCost}
            setCost={setReceiveCost}
          />
          <button
            className="btn btn-primary mt-3"
            disabled={pending || !receiveVendor || !receiveItem || !receiveQuantity || !receiveCost}
            onClick={() =>
              act(() =>
                receiveGoodsAction({
                  vendorId: receiveVendor,
                  receivedOn: today,
                  lines: [
                    {
                      itemId: receiveItem,
                      quantity: Number(receiveQuantity),
                      unitCostCents: parseAmountToCents(receiveCost) ?? 0,
                    },
                  ],
                }),
              )
            }
          >
            Receive
          </button>
        </section>
      )}

      <Card title="Stock on hand" subtitle="Quantity, what it is worth, and the average it cost.">
        {positions.length === 0 ? (
          <Empty>No stocked items yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-4 py-2 text-right font-medium">On hand</th>
                <th className="px-4 py-2 text-right font-medium">Average cost</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
                <th className="px-4 py-2 text-right font-medium">Reorder at</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.itemId} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    {position.code && <span className="tnum mr-2 text-faint">{position.code}</span>}
                    {position.name}
                    {position.belowReorderPoint && (
                      <span className="ml-2 chip bg-warning/15 px-2 py-0.5 text-xs text-warning">
                        low
                      </span>
                    )}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {units(position.quantityMilli)} {position.unit}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">
                    {position.averageUnitCostCents === null
                      ? '—'
                      : formatCents(position.averageUnitCostCents)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(position.valueCents)}</td>
                  <td className="tnum px-4 py-1.5 text-right text-faint">
                    {position.reorderPointMilli === null
                      ? '—'
                      : units(position.reorderPointMilli)}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {canManage && (
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() =>
                          setCounting(counting === position.itemId ? null : position.itemId)
                        }
                      >
                        Count
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {counting && canManage && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Counted</span>
              <input
                value={counted}
                onChange={(event) => setCounted(event.target.value)}
                className="field w-28 py-1.5 text-sm"
              />
            </label>
            <label className="grow text-xs text-muted">
              <span className="mb-1 block">Why it differs</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Breakage, theft, miscount…"
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <button
              className="btn btn-primary"
              disabled={pending || counted === '' || !reason.trim()}
              onClick={() =>
                act(() =>
                  adjustStockAction({
                    itemId: counting,
                    counted: Number(counted),
                    adjustedOn: today,
                    reason,
                  }),
                )
              }
            >
              Book the difference
            </button>
            <p className="w-full text-xs text-faint">
              A shortage goes to Inventory Shrinkage, not Cost of Goods Sold. Stock that was sold
              and stock that went missing are different facts.
            </p>
          </div>
        )}
      </Card>

      {unbilled.length > 0 && (
        <Card
          title="Received, not yet billed"
          subtitle="This is the Goods Received Not Invoiced balance, itemised."
        >
          <table className="w-full text-sm">
            <tbody>
              {unbilled.map((row) => (
                <tr key={row.id} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-1.5">{row.number}</td>
                  <td className="px-4 py-1.5">{row.vendorName}</td>
                  <td className="px-4 py-1.5 text-muted">{row.receivedOn}</td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(row.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {orders.length > 0 && (
        <Card title="Purchase orders">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 font-medium">Ordered</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t border-line">
                  <td className="px-4 py-1.5">{order.number}</td>
                  <td className="px-4 py-1.5">{order.vendorName}</td>
                  <td className="px-4 py-1.5 text-muted">{order.orderedOn}</td>
                  <td className="px-4 py-1.5 text-muted">{order.status}</td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(order.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {adjustments.length > 0 && (
        <Card title="Counts and adjustments" subtitle="Every one carries a reason.">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-4 py-2 text-right font-medium">Expected</th>
                <th className="px-4 py-2 text-right font-medium">Counted</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
                <th className="px-4 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-1.5 text-muted">{row.adjustedOn}</td>
                  <td className="px-4 py-1.5">{row.itemName}</td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">
                    {units(row.expectedMilli)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">{units(row.countedMilli)}</td>
                  <td
                    className={`tnum px-4 py-1.5 text-right ${row.valueChangeCents < 0 ? 'text-negative' : ''}`}
                  >
                    {formatCents(row.valueChangeCents)}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function PurchaseForm({
  vendors,
  items,
  vendorId,
  setVendorId,
  itemId,
  setItemId,
  quantity,
  setQuantity,
  cost,
  setCost,
}: {
  vendors: Named[]
  items: Named[]
  vendorId: string
  setVendorId: (value: string) => void
  itemId: string
  setItemId: (value: string) => void
  quantity: string
  setQuantity: (value: string) => void
  cost: string
  setCost: (value: string) => void
}) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-4">
      <label className="text-xs text-muted">
        <span className="mb-1 block">Vendor</span>
        <select
          value={vendorId}
          onChange={(event) => setVendorId(event.target.value)}
          className="field w-full py-1.5 text-sm"
        >
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-muted">
        <span className="mb-1 block">Item</span>
        <select
          value={itemId}
          onChange={(event) => setItemId(event.target.value)}
          className="field w-full py-1.5 text-sm"
        >
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-muted">
        <span className="mb-1 block">Quantity</span>
        <input
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          className="field w-full py-1.5 text-sm"
        />
      </label>
      <label className="text-xs text-muted">
        <span className="mb-1 block">Unit cost</span>
        <input
          value={cost}
          onChange={(event) => setCost(event.target.value)}
          placeholder="0.00"
          className="field w-full py-1.5 text-sm"
        />
      </label>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'bad'
}) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${tone === 'bad' ? 'text-warning' : ''}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}
