'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  absorbCostAction,
  cancelWorkOrderAction,
  completeWorkOrderAction,
  createBomAction,
  createWorkOrderAction,
  issueMaterialAction,
  type ActionResult,
} from '@/app/actions/manufacturing'

type Item = { id: string; name: string }

type WorkOrder = {
  id: string
  number: string
  outputItemId: string
  outputItemName: string
  bomId: string | null
  status: 'draft' | 'released' | 'completed' | 'cancelled'
  plannedMilli: number
  producedMilli: number
  scrappedMilli: number
  wipCents: number
  materialCents: number
  labourCents: number
  overheadCents: number
  startedOn: string | null
  completedOn: string | null
}

type Bom = {
  id: string
  outputItemId: string
  outputItemName: string
  name: string
  batchMilli: number
  isActive: boolean
  components: Array<{
    id: string
    componentItemId: string
    componentItemName: string
    quantityMilli: number
    scrapBp: number
  }>
}

type Props = {
  boms: Bom[]
  orders: WorkOrder[]
  wip: {
    registerCents: number
    ledgerCents: number
    differenceCents: number
    agrees: boolean
    openOrders: Array<{ id: string; number: string; wipCents: number }>
  } | null
  stages: Array<{ accountNumber: string; accountName: string; cents: number }>
  finished: Array<{
    itemId: string
    itemName: string
    quantityMilli: number
    valueCents: number
    unitCostCents: number
  }>
  items: Item[]
  today: string
  canManage: boolean
}

const qty = (milli: number) => (milli / 1000).toFixed(3).replace(/\.?0+$/, '')

/**
 * The manufacturing workspace (spec §5 Manufacturing, Phase 27).
 *
 * Opens on the runs in flight rather than on the recipe book, because the
 * question a factory opens this to answer is "what is on the floor and what has
 * it cost so far" — a list of bills of materials answers neither.
 */
export function ManufacturingBoard(props: Props) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState<'runs' | 'boms' | 'stock'>('runs')
  const [open, setOpen] = useState<string | null>(null)

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  const live = props.orders.filter((order) => order.status === 'released')
  const wipCents = live.reduce((sum, order) => sum + order.wipCents, 0)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Manufacturing</h2>
        <p className="text-sm text-muted">
          {live.length} run{live.length === 1 ? '' : 's'} on the floor ·{' '}
          <span className={wipCents > 0 ? 'text-warning' : 'text-muted'}>
            {formatCents(wipCents)} in work in process
          </span>
        </p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              ['runs', 'Runs'],
              ['boms', 'Bills of materials'],
              ['stock', 'Where the value sits'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`chip px-3 py-1 text-xs ${
                tab === key ? 'bg-brand text-brand-ink' : 'bg-raised text-muted'
              }`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {tab === 'runs' && (
        <Runs {...props} act={act} pending={pending} open={open} setOpen={setOpen} />
      )}
      {tab === 'boms' && <Boms {...props} act={act} pending={pending} />}
      {tab === 'stock' && <Stock {...props} />}
    </div>
  )
}

type Helpers = { act: (fn: () => Promise<ActionResult>) => void; pending: boolean }

function Runs({
  orders,
  boms,
  items,
  today,
  canManage,
  act,
  pending,
  open,
  setOpen,
}: Props & Helpers & { open: string | null; setOpen: (id: string | null) => void }) {
  const [showNew, setShowNew] = useState(false)

  return (
    <div className="space-y-4">
      {canManage && (
        <div>
          <button className="btn btn-ghost text-xs" onClick={() => setShowNew((was) => !was)}>
            {showNew ? 'Never mind' : 'Plan a run'}
          </button>
        </div>
      )}

      {showNew && canManage && (
        <form
          className="card space-y-3 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const bomId = String(form.get('bomId')) || null
            const bom = boms.find((row) => row.id === bomId)

            act(() =>
              createWorkOrderAction({
                outputItemId: bom ? bom.outputItemId : String(form.get('outputItemId')),
                bomId,
                plannedMilli: Math.round(Number(form.get('planned')) * 1000),
                startedOn: String(form.get('startedOn')) || undefined,
              }),
            )
            setShowNew(false)
          }}
        >
          <h3 className="text-sm font-semibold">Plan a run</h3>
          <p className="text-xs text-muted">
            A plan consumes nothing and posts nothing. The run starts holding cost the moment
            material is issued to it.
          </p>

          <div className="grid gap-2 sm:grid-cols-4">
            <label className="text-xs sm:col-span-2">
              <span className="block text-faint">Bill of materials</span>
              <select className="field" name="bomId">
                <option value="">None — no recipe</option>
                {boms.map((bom) => (
                  <option key={bom.id} value={bom.id}>
                    {bom.name} ({bom.outputItemName})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs sm:col-span-2">
              <span className="block text-faint">…or make this directly</span>
              <select className="field" name="outputItemId">
                <option value="">Pick an item</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-faint">How many</span>
              <input className="field" type="number" step="0.001" name="planned" required />
            </label>
            <label className="text-xs">
              <span className="block text-faint">Starting</span>
              <input className="field" type="date" name="startedOn" defaultValue={today} />
            </label>
          </div>

          <button className="btn text-sm" type="submit" disabled={pending}>
            Plan it
          </button>
        </form>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Run</th>
              <th className="px-4 py-2">Making</th>
              <th className="px-4 py-2">Planned</th>
              <th className="px-4 py-2">In WIP</th>
              <th className="px-4 py-2">Made</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {orders.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={6}>
                  No runs yet. Plan one to start moving cost through work in process.
                </td>
              </tr>
            )}
            {orders.map((order) => (
              <tr key={order.id}>
                <td className="px-4 py-2">
                  <span className="font-medium">{order.number}</span>
                  <span className="block text-xs text-faint">
                    {order.status}
                    {order.startedOn && ` · from ${order.startedOn}`}
                  </span>
                </td>
                <td className="px-4 py-2">{order.outputItemName}</td>
                <td className="px-4 py-2 tabular-nums">{qty(order.plannedMilli)}</td>
                <td className="px-4 py-2 tabular-nums">
                  {order.status === 'released' ? (
                    <span className="text-warning">{formatCents(order.wipCents)}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {order.producedMilli > 0 ? (
                    <>
                      {qty(order.producedMilli)}
                      {order.scrappedMilli > 0 && (
                        <span className="block text-xs text-danger">
                          {qty(order.scrappedMilli)} scrapped
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="text-xs text-brand hover:underline"
                    onClick={() => setOpen(open === order.id ? null : order.id)}
                  >
                    {open === order.id ? 'Hide' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && canManage && (
        <RunPanel
          order={orders.find((row) => row.id === open)!}
          boms={boms}
          items={items}
          today={today}
          act={act}
          pending={pending}
        />
      )}
    </div>
  )
}

function RunPanel({
  order,
  boms,
  items,
  today,
  act,
  pending,
}: Helpers & { order: WorkOrder; boms: Bom[]; items: Item[]; today: string }) {
  const bom = boms.find((row) => row.id === order.bomId)
  const settled = order.status === 'completed' || order.status === 'cancelled'

  return (
    <div className="card space-y-4 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold">{order.number}</h3>
        <p className="text-xs text-muted">
          {formatCents(order.materialCents)} material · {formatCents(order.labourCents)} labour ·{' '}
          {formatCents(order.overheadCents)} overhead
          {settled && order.producedMilli > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="text-success">
                {formatCents(
                  Math.round(
                    ((order.materialCents + order.labourCents + order.overheadCents) * 1000) /
                      order.producedMilli,
                  ),
                )}{' '}
                each
              </span>
            </>
          )}
        </p>
      </div>

      {settled ? (
        <p className="text-xs text-muted">
          This run is {order.status}. Work in process on it is zero — everything it absorbed has
          left.
        </p>
      ) : (
        <>
          {bom && (
            <p className="text-xs text-faint">
              Recipe: {bom.name}, written for {qty(bom.batchMilli)} —{' '}
              {bom.components
                .map(
                  (line) =>
                    `${qty(Math.round((line.quantityMilli * order.plannedMilli) / bom.batchMilli))} ${line.componentItemName}`,
                )
                .join(', ')}
            </p>
          )}

          <form
            className="grid gap-2 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              act(() =>
                issueMaterialAction({
                  workOrderId: order.id,
                  itemId: String(form.get('itemId')),
                  quantityMilli: Math.round(Number(form.get('quantity')) * 1000),
                  occurredOn: String(form.get('occurredOn')),
                }),
              )
            }}
          >
            <label className="text-xs sm:col-span-2">
              <span className="block text-faint">Issue material</span>
              <select className="field" name="itemId" required>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-faint">How much</span>
              <input className="field" type="number" step="0.001" name="quantity" required />
            </label>
            <label className="text-xs">
              <span className="block text-faint">On</span>
              <input className="field" type="date" name="occurredOn" defaultValue={today} required />
            </label>
            <div className="sm:col-span-4">
              <button className="btn btn-ghost text-xs" type="submit" disabled={pending}>
                Issue it
              </button>
              <span className="ml-2 text-xs text-faint">
                Costed from the lots it comes out of, never from a price list.
              </span>
            </div>
          </form>

          <form
            className="grid gap-2 border-t border-line pt-3 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              act(() =>
                absorbCostAction({
                  workOrderId: order.id,
                  kind: String(form.get('kind')) as 'labour' | 'overhead',
                  costCents: Math.round(Number(form.get('amount')) * 100),
                  occurredOn: String(form.get('occurredOn')),
                }),
              )
            }}
          >
            <label className="text-xs sm:col-span-2">
              <span className="block text-faint">Absorb</span>
              <select className="field" name="kind">
                <option value="labour">Direct labour</option>
                <option value="overhead">Manufacturing overhead</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-faint">Amount</span>
              <input className="field" type="number" step="0.01" name="amount" required />
            </label>
            <label className="text-xs">
              <span className="block text-faint">On</span>
              <input className="field" type="date" name="occurredOn" defaultValue={today} required />
            </label>
            <div className="sm:col-span-4">
              <button className="btn btn-ghost text-xs" type="submit" disabled={pending}>
                Absorb it
              </button>
              <span className="ml-2 text-xs text-faint">
                Credits the expense account and debits WIP — the cost stops being this month&rsquo;s
                and becomes part of what is on the shelf.
              </span>
            </div>
          </form>

          <form
            className="grid gap-2 border-t border-line pt-3 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              act(() =>
                completeWorkOrderAction({
                  workOrderId: order.id,
                  producedMilli: Math.round(Number(form.get('produced')) * 1000),
                  scrappedMilli: Math.round(Number(form.get('scrapped') ?? 0) * 1000),
                  completedOn: String(form.get('completedOn')),
                }),
              )
            }}
          >
            <label className="text-xs">
              <span className="block text-faint">Good units</span>
              <input
                className="field"
                type="number"
                step="0.001"
                name="produced"
                defaultValue={qty(order.plannedMilli)}
                required
              />
            </label>
            <label className="text-xs">
              <span className="block text-faint">Scrapped</span>
              <input className="field" type="number" step="0.001" name="scrapped" defaultValue="0" />
            </label>
            <label className="text-xs">
              <span className="block text-faint">On</span>
              <input
                className="field"
                type="date"
                name="completedOn"
                defaultValue={today}
                required
              />
            </label>
            <div className="flex items-end gap-2">
              <button className="btn text-xs" type="submit" disabled={pending}>
                Finish the run
              </button>
            </div>
            <p className="text-xs text-faint sm:col-span-4">
              Everything in WIP moves into finished goods, so WIP clears to exactly zero. Scrap
              raises the unit cost — the run cost what it cost and made fewer units.
            </p>
          </form>

          <div className="border-t border-line pt-3">
            <button
              className="btn btn-ghost text-xs text-danger"
              disabled={pending}
              onClick={() =>
                act(() =>
                  cancelWorkOrderAction({
                    workOrderId: order.id,
                    cancelledOn: today,
                    reason: 'Abandoned',
                  }),
                )
              }
            >
              Cancel the run
            </button>
            <span className="ml-2 text-xs text-faint">
              Writes WIP off to Manufacturing Overhead. The material was cut and mixed — it does
              not go back to the store.
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function Boms({ boms, items, canManage, act, pending }: Props & Helpers) {
  const [showNew, setShowNew] = useState(false)
  const [lines, setLines] = useState([{ componentItemId: '', quantity: '', scrapBp: '0' }])

  return (
    <div className="space-y-4">
      {canManage && (
        <div>
          <button className="btn btn-ghost text-xs" onClick={() => setShowNew((was) => !was)}>
            {showNew ? 'Never mind' : 'Write a bill of materials'}
          </button>
        </div>
      )}

      {showNew && canManage && (
        <form
          className="card space-y-3 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            act(() =>
              createBomAction({
                outputItemId: String(form.get('outputItemId')),
                name: String(form.get('name')),
                batchMilli: Math.round(Number(form.get('batch')) * 1000),
                components: lines
                  .filter((line) => line.componentItemId && Number(line.quantity) > 0)
                  .map((line) => ({
                    componentItemId: line.componentItemId,
                    quantityMilli: Math.round(Number(line.quantity) * 1000),
                    scrapBp: Number(line.scrapBp) || 0,
                  })),
              }),
            )
            setShowNew(false)
            setLines([{ componentItemId: '', quantity: '', scrapBp: '0' }])
          }}
        >
          <h3 className="text-sm font-semibold">Write a bill of materials</h3>
          <p className="text-xs text-muted">
            Written per batch rather than per unit: a recipe for 100 forces no rounding on a
            component used a third of a time each.
          </p>

          <div className="grid gap-2 sm:grid-cols-4">
            <label className="text-xs sm:col-span-2">
              <span className="block text-faint">Name</span>
              <input className="field" name="name" placeholder="Oak stool, batch of 20" required />
            </label>
            <label className="text-xs">
              <span className="block text-faint">Makes</span>
              <select className="field" name="outputItemId" required>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-faint">Batch size</span>
              <input className="field" type="number" step="0.001" name="batch" required />
            </label>
          </div>

          {lines.map((line, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-4">
              <label className="text-xs sm:col-span-2">
                <span className="block text-faint">Component</span>
                <select
                  className="field"
                  value={line.componentItemId}
                  onChange={(event) => {
                    const next = [...lines]
                    next[index] = { ...line, componentItemId: event.target.value }
                    setLines(next)
                  }}
                >
                  <option value="">Pick one</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="block text-faint">Per batch</span>
                <input
                  className="field"
                  type="number"
                  step="0.001"
                  value={line.quantity}
                  onChange={(event) => {
                    const next = [...lines]
                    next[index] = { ...line, quantity: event.target.value }
                    setLines(next)
                  }}
                />
              </label>
              <label className="text-xs">
                <span className="block text-faint">Wastage (bp)</span>
                <input
                  className="field"
                  type="number"
                  value={line.scrapBp}
                  onChange={(event) => {
                    const next = [...lines]
                    next[index] = { ...line, scrapBp: event.target.value }
                    setLines(next)
                  }}
                />
              </label>
            </div>
          ))}

          <div className="flex gap-2">
            <button
              className="btn btn-ghost text-xs"
              type="button"
              onClick={() => setLines([...lines, { componentItemId: '', quantity: '', scrapBp: '0' }])}
            >
              Another component
            </button>
            <button className="btn text-sm" type="submit" disabled={pending}>
              Save it
            </button>
          </div>
        </form>
      )}

      {boms.length === 0 ? (
        <div className="card px-4 py-6 text-center text-sm text-muted">
          No recipes yet. A run can be raised without one — it just has nothing to compare its
          material against.
        </div>
      ) : (
        boms.map((bom) => (
          <div key={bom.id} className="card px-4 py-3">
            <h3 className="text-sm font-semibold">{bom.name}</h3>
            <p className="text-xs text-faint">
              Makes {qty(bom.batchMilli)} × {bom.outputItemName}
            </p>
            <ul className="mt-2 divide-y divide-line text-sm">
              {bom.components.map((line) => (
                <li key={line.id} className="flex justify-between py-1.5">
                  <span>{line.componentItemName}</span>
                  <span className="tabular-nums text-muted">
                    {qty(line.quantityMilli)}
                    {line.scrapBp > 0 && (
                      <span className="ml-2 text-xs text-faint">
                        +{(line.scrapBp / 100).toFixed(2)}% wastage
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  )
}

function Stock({ wip, stages, finished }: Props) {
  return (
    <div className="space-y-4">
      {wip && (
        <div className="card px-4 py-3">
          <h3 className="text-sm font-semibold">Work in process</h3>
          <p className="mt-1 text-xs text-muted">
            What the open runs say they are holding, against what account 1450 says. Two different
            things — a subledger this module maintains, and what the journal lines add up to — so a
            difference is real rather than a tautology.
          </p>

          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-faint">Open runs</dt>
              <dd className="text-lg tabular-nums">{formatCents(wip.registerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Account 1450</dt>
              <dd className="text-lg tabular-nums">{formatCents(wip.ledgerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Agrees</dt>
              <dd className={`text-lg ${wip.agrees ? 'text-success' : 'text-danger'}`}>
                {wip.agrees ? 'Yes' : formatCents(wip.differenceCents)}
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div className="card px-4 py-3">
        <h3 className="text-sm font-semibold">Where the value sits</h3>
        <p className="mt-1 text-xs text-muted">
          Three balance-sheet lines rather than one. A factory with most of its stock in unmachined
          bar is a different business from one holding finished units, and a single Inventory line
          cannot say which.
        </p>
        <ul className="mt-3 divide-y divide-line text-sm">
          {stages.map((stage) => (
            <li key={stage.accountNumber} className="flex justify-between py-2">
              <span>
                {stage.accountNumber} {stage.accountName}
              </span>
              <span className="tabular-nums">{formatCents(stage.cents)}</span>
            </li>
          ))}
        </ul>
      </div>

      {finished.length > 0 && (
        <div className="card overflow-hidden">
          <h3 className="px-4 py-3 text-sm font-semibold">
            Finished, on the shelf
            <span className="ml-2 text-xs font-normal text-muted">
              what several batches at different costs actually averaged out to
            </span>
          </h3>
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">On hand</th>
                <th className="px-4 py-2">Value</th>
                <th className="px-4 py-2">Each</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {finished.map((row) => (
                <tr key={row.itemId}>
                  <td className="px-4 py-2">{row.itemName}</td>
                  <td className="px-4 py-2 tabular-nums">{qty(row.quantityMilli)}</td>
                  <td className="px-4 py-2 tabular-nums">{formatCents(row.valueCents)}</td>
                  <td className="px-4 py-2 tabular-nums">{formatCents(row.unitCostCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
