'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatCents } from '@/lib/money'
import {
  addLineAction,
  addVehicleAction,
  authoriseAction,
  cancelAction,
  completeAction,
  openRepairOrderAction,
  takePaymentAction,
  type ActionResult,
} from '@/app/actions/vehicles'
import { TakePayment } from '@/components/take-payment'

type Order = {
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
  invoiceId: string | null
  outstandingCents: number
}

type Car = {
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

type Line = {
  id: string
  kind: string
  description: string
  quantityMilli: number
  unitPriceCents: number
  subletCostCents: number
}

type Props = {
  orders: Order[]
  cars: Car[]
  mix: {
    labourCents: number
    partsCents: number
    subletCents: number
    subletCostCents: number
    subletMarginCents: number
    totalCents: number
  } | null
  check: {
    storedCents: number
    recordedCents: number
    differenceCents: number
    agrees: boolean
    offenders: Array<{ id: string; number: string; storedCents: number; recordedCents: number }>
  } | null
  order: {
    id: string
    number: string
    status: string
    registration: string | null
    customerName: string | null
    complaint: string | null
    authorisedCents: number
    toleranceBp: number
    totals: {
      labourCents: number
      partsCents: number
      subletCents: number
      totalCents: number
    }
    authority: {
      ceilingCents: number
      headroomCents: number
      withinAuthority: boolean
      overByCents: number
      needsAuthorisationForCents: number
    }
  } | null
  lines: Line[]
  history: Array<{
    id: string
    number: string
    status: string
    openedOn: string
    completedOn: string | null
    odometerIn: number | null
    odometerOut: number | null
    totalCents: number
  }>
  historyVehicleId: string | null
  today: string
  canManage: boolean
  canBill: boolean
}

const TABS = ['On the ramp', 'Vehicles', 'What the shop was made of'] as const
type Tab = (typeof TABS)[number]

/**
 * The shop workspace (spec §5, Phase 30).
 *
 * Opens on the ramp, because the question somebody opens this to answer is
 * "what is in, and can I bill it" — and the second half of that has an answer
 * the software is willing to say no to.
 */
export function ShopBoard(props: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>(props.order ? 'On the ramp' : 'On the ramp')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

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

  const over = props.orders.filter((row) => !row.withinAuthority)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">The shop</h2>
        <p className="text-sm text-muted">
          {props.orders.filter((row) => row.status !== 'completed' && row.status !== 'cancelled')
            .length}{' '}
          open · {props.cars.length} vehicle{props.cars.length === 1 ? '' : 's'} on file
          {over.length > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="text-danger">
                {over.length} over what the customer agreed to
              </span>
            </>
          )}
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {props.order && (
        <OrderPanel {...props} order={props.order} act={act} pending={pending} />
      )}

      <nav className="flex gap-1 border-b border-line text-sm">
        {TABS.map((name) => (
          <button
            className={`px-3 py-2 ${
              tab === name ? 'border-b-2 border-brand font-medium' : 'text-muted'
            }`}
            key={name}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === 'On the ramp' && <Ramp {...props} act={act} pending={pending} />}
      {tab === 'Vehicles' && <Vehicles {...props} act={act} pending={pending} />}
      {tab === 'What the shop was made of' && <Mix {...props} />}
    </div>
  )
}

type Helpers = { act: (fn: () => Promise<ActionResult>) => void; pending: boolean }

function Ramp({ orders, today, canBill, act, pending }: Props & Helpers) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
          <tr>
            <th className="px-4 py-2">Order</th>
            <th className="px-4 py-2">Vehicle</th>
            <th className="px-4 py-2">Work</th>
            <th className="px-4 py-2">Authorised</th>
            <th className="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {orders.length === 0 && (
            <tr>
              <td className="px-4 py-6 text-center text-sm text-muted" colSpan={5}>
                Nothing on the ramp.
              </td>
            </tr>
          )}
          {orders.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-2">
                <Link className="text-action hover:underline" href={`/shop?order=${row.id}`}>
                  {row.number}
                </Link>
                <span className="block text-xs text-faint">{row.openedOn}</span>
              </td>
              <td className="px-4 py-2">
                {row.registration ?? <span className="text-faint">—</span>}
                <span className="block text-xs text-faint">{row.customerName ?? 'no keeper'}</span>
              </td>
              <td className="px-4 py-2 tabular-nums">{formatCents(row.totalCents)}</td>
              <td className="px-4 py-2 tabular-nums">
                {formatCents(row.authorisedCents)}
                {row.ceilingCents !== row.authorisedCents && (
                  <span className="block text-xs text-faint">
                    ceiling {formatCents(row.ceilingCents)}
                  </span>
                )}
              </td>
              <td className="px-4 py-2">
                {row.status === 'completed' ? (
                  row.outstandingCents > 0 ? (
                    <>
                      <span className="text-warning">
                        billed · {formatCents(row.outstandingCents)} owing
                      </span>
                      {canBill && row.invoiceId && (
                        <div className="mt-1">
                          <TakePayment
                            act={act}
                            invoiceId={row.invoiceId}
                            outstandingCents={row.outstandingCents}
                            pending={pending}
                            takePaymentAction={takePaymentAction}
                            today={today}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-success">billed · paid</span>
                  )
                ) : row.status === 'cancelled' ? (
                  <span className="text-faint">cancelled</span>
                ) : !row.withinAuthority ? (
                  <span className="text-danger">
                    {formatCents(row.overByCents)} over — needs a yes
                  </span>
                ) : row.status === 'estimate' ? (
                  <span className="text-warning">estimate, nothing agreed</span>
                ) : (
                  <span className="text-success">within authority</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One order, with the ceiling stated in the same place as the buttons.
 *
 * The headroom is shown even when there is plenty, because the number an
 * advisor needs before quoting more work is the one that stops them having to
 * ring back twice.
 */
function OrderPanel({
  order,
  lines,
  today,
  canManage,
  canBill,
  act,
  pending,
}: Props & Helpers & { order: NonNullable<Props['order']> }) {
  const [showLine, setShowLine] = useState(false)

  return (
    <div className="card space-y-4 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            {order.number} · {order.registration ?? 'no plate'}
          </h3>
          <p className="text-xs text-muted">
            {order.customerName ?? 'No keeper on file'}
            {order.complaint && ` · ${order.complaint}`}
          </p>
        </div>
        <Link className="btn btn-ghost text-xs" href="/shop">
          Close
        </Link>
      </div>

      <dl className="grid gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-faint">Work priced</dt>
          <dd className="text-lg tabular-nums">{formatCents(order.totals.totalCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Authorised</dt>
          <dd className="text-lg tabular-nums">{formatCents(order.authorisedCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-faint">Ceiling</dt>
          <dd className="text-lg tabular-nums">
            {formatCents(order.authority.ceilingCents)}
            {order.toleranceBp > 0 && (
              <span className="ml-1 text-xs text-faint">
                incl. {(order.toleranceBp / 100).toFixed(0)}%
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-faint">
            {order.authority.withinAuthority ? 'Headroom' : 'Over by'}
          </dt>
          <dd
            className={`text-lg tabular-nums ${
              order.authority.withinAuthority ? 'text-success' : 'text-danger'
            }`}
          >
            {order.authority.withinAuthority
              ? formatCents(order.authority.headroomCents)
              : formatCents(order.authority.overByCents)}
          </dd>
        </div>
      </dl>

      {!order.authority.withinAuthority && order.status !== 'completed' && (
        <p className="text-xs text-danger">
          This cannot be billed as it stands. Ring the customer and get a further{' '}
          <strong>{formatCents(order.authority.needsAuthorisationForCents)}</strong> authorised —
          that is the extra, which is what they are being asked to agree to, not the new total.
        </p>
      )}

      <div className="overflow-hidden rounded border border-line">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">What</th>
              <th className="px-3 py-2">Qty</th>
              <th className="px-3 py-2">Each</th>
              <th className="px-3 py-2">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-xs text-muted" colSpan={5}>
                  Nothing on this order yet.
                </td>
              </tr>
            )}
            {lines.map((line) => (
              <tr key={line.id}>
                <td className="px-3 py-2 text-xs">
                  <span
                    className={
                      line.kind === 'labour'
                        ? 'text-action'
                        : line.kind === 'part'
                          ? 'text-success'
                          : 'text-warning'
                    }
                  >
                    {line.kind}
                  </span>
                </td>
                <td className="px-3 py-2">{line.description}</td>
                <td className="px-3 py-2 tabular-nums">{(line.quantityMilli / 1000).toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums">{formatCents(line.unitPriceCents)}</td>
                <td className="px-3 py-2 tabular-nums">
                  {formatCents(Math.round((line.quantityMilli * line.unitPriceCents) / 1000))}
                  {line.subletCostCents > 0 && (
                    <span className="block text-xs text-faint">
                      cost {formatCents(line.subletCostCents)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && order.status !== 'completed' && order.status !== 'cancelled' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost text-xs" onClick={() => setShowLine((was) => !was)}>
              {showLine ? 'Never mind' : 'Add work'}
            </button>
            <button
              className="btn btn-ghost text-xs"
              disabled={pending}
              onClick={() => act(() => cancelAction({ repairOrderId: order.id }))}
            >
              Cancel order
            </button>
            {canBill && (
              <button
                className="btn text-xs"
                disabled={pending}
                onClick={() =>
                  act(() => completeAction({ repairOrderId: order.id, completedOn: today }))
                }
              >
                Bill it
              </button>
            )}
          </div>

          {showLine && (
            <form
              className="grid gap-2 sm:grid-cols-5"
              onSubmit={(event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                act(() =>
                  addLineAction({
                    repairOrderId: order.id,
                    kind: String(form.get('kind')),
                    description: String(form.get('description')),
                    quantityMilli: Math.round(Number(form.get('qty') ?? 1) * 1000),
                    unitPriceCents: Math.round(Number(form.get('price') ?? 0) * 100),
                    subletCostCents: Math.round(Number(form.get('cost') ?? 0) * 100),
                  }),
                )
                setShowLine(false)
              }}
            >
              <label className="text-xs">
                <span className="block text-faint">Kind</span>
                <select className="field" name="kind">
                  <option value="labour">Labour</option>
                  <option value="sublet">Sublet</option>
                </select>
              </label>
              <label className="text-xs sm:col-span-2">
                <span className="block text-faint">What</span>
                <input className="field" name="description" required />
              </label>
              <label className="text-xs">
                <span className="block text-faint">Qty / hours</span>
                <input className="field" defaultValue={1} min="0.01" name="qty" step="0.01" type="number" />
              </label>
              <label className="text-xs">
                <span className="block text-faint">Each</span>
                <input className="field" min="0" name="price" step="0.01" type="number" required />
              </label>
              <label className="text-xs">
                <span className="block text-faint">Sublet cost</span>
                <input className="field" min="0" name="cost" step="0.01" type="number" />
              </label>
              <div className="flex items-end">
                <button className="btn text-sm" disabled={pending} type="submit">
                  Add
                </button>
              </div>
            </form>
          )}

          <form
            className="grid gap-2 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              act(() =>
                authoriseAction({
                  repairOrderId: order.id,
                  amountCents: Math.round(Number(form.get('amount') ?? 0) * 100),
                  channel: String(form.get('channel')),
                  approvedBy: String(form.get('approvedBy') ?? ''),
                }),
              )
              event.currentTarget.reset()
            }}
          >
            <label className="text-xs">
              <span className="block text-faint">Authorise a further</span>
              <input className="field" name="amount" step="0.01" type="number" required />
            </label>
            <label className="text-xs">
              <span className="block text-faint">How</span>
              <select className="field" defaultValue="phone" name="channel">
                <option value="phone">By phone</option>
                <option value="in_person">In person</option>
                <option value="email">By email</option>
                <option value="sms">By text</option>
                <option value="online">Online</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-faint">Who said yes</span>
              <input className="field" name="approvedBy" />
            </label>
            <div className="flex items-end">
              <button className="btn text-sm" disabled={pending} type="submit">
                Record it
              </button>
            </div>
          </form>
          <p className="text-xs text-faint">
            Every approval is its own row with who, when and down which channel — because a shop
            challenged over a bill has to be able to say exactly that, and a single running total
            cannot.
          </p>
        </div>
      )}
    </div>
  )
}

function Vehicles({ cars, history, historyVehicleId, today, canManage, act, pending }: Props & Helpers) {
  const [showAdd, setShowAdd] = useState(false)

  return (
    <div className="space-y-4">
      {canManage && (
        <div>
          <button className="btn btn-ghost text-xs" onClick={() => setShowAdd((was) => !was)}>
            {showAdd ? 'Never mind' : 'Add a vehicle'}
          </button>
        </div>
      )}

      {showAdd && canManage && (
        <form
          className="card grid gap-2 px-4 py-3 sm:grid-cols-6"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            act(() =>
              addVehicleAction({
                registration: String(form.get('registration') ?? ''),
                vin: String(form.get('vin') ?? ''),
                make: String(form.get('make') ?? ''),
                model: String(form.get('model') ?? ''),
                year: Number(form.get('year')) || undefined,
                odometerMiles: Number(form.get('miles')) || undefined,
              }),
            )
            setShowAdd(false)
          }}
        >
          <label className="text-xs">
            <span className="block text-faint">Plate</span>
            <input className="field" name="registration" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="block text-faint">VIN</span>
            <input className="field" name="vin" />
          </label>
          <label className="text-xs">
            <span className="block text-faint">Make</span>
            <input className="field" name="make" />
          </label>
          <label className="text-xs">
            <span className="block text-faint">Model</span>
            <input className="field" name="model" />
          </label>
          <label className="text-xs">
            <span className="block text-faint">Miles</span>
            <input className="field" min="0" name="miles" type="number" />
          </label>
          <div className="flex items-end">
            <button className="btn text-sm" disabled={pending} type="submit">
              Add
            </button>
          </div>
        </form>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th className="px-4 py-2">Vehicle</th>
              <th className="px-4 py-2">Keeper</th>
              <th className="px-4 py-2">Miles</th>
              <th className="px-4 py-2">Visits</th>
              <th className="px-4 py-2">Spent</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {cars.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted" colSpan={6}>
                  No vehicles on file yet.
                </td>
              </tr>
            )}
            {cars.map((car) => (
              <tr key={car.id}>
                <td className="px-4 py-2">
                  {car.registration ?? <span className="text-faint">no plate</span>}
                  <span className="block text-xs text-faint">
                    {[car.year, car.make, car.model].filter(Boolean).join(' ') || car.vin}
                  </span>
                </td>
                <td className="px-4 py-2">{car.customerName ?? <span className="text-faint">—</span>}</td>
                <td className="px-4 py-2 tabular-nums">
                  {car.odometerMiles?.toLocaleString() ?? '—'}
                </td>
                <td className="px-4 py-2 tabular-nums">{car.visits}</td>
                <td className="px-4 py-2 tabular-nums">{formatCents(car.spentCents)}</td>
                <td className="px-4 py-2 text-right">
                  <Link className="text-xs text-action hover:underline" href={`/shop?vehicle=${car.id}`}>
                    History
                  </Link>
                  {canManage && (
                    <form
                      className="mt-1 inline-block"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const form = new FormData(event.currentTarget)
                        act(() =>
                          openRepairOrderAction({
                            vehicleId: car.id,
                            openedOn: today,
                            complaint: String(form.get('complaint') ?? ''),
                            odometerIn: Number(form.get('miles')) || undefined,
                          }),
                        )
                      }}
                    >
                      <input className="field w-28 text-xs" name="complaint" placeholder="Complaint" />
                      <input className="field w-20 text-xs" name="miles" placeholder="Miles" type="number" />
                      <button className="btn btn-ghost text-xs" disabled={pending} type="submit">
                        Book in
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {historyVehicleId && (
        <div className="card px-4 py-3">
          <h3 className="text-sm font-semibold">What this car has been through</h3>
          <p className="mt-1 text-xs text-muted">
            Keyed on the vehicle, not the keeper. A history that reset when the car changed hands
            would be worth much less — to the next owner, and to the shop that wants the work.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {history.length === 0 && <li className="text-muted">Nothing recorded.</li>}
            {history.map((entry) => (
              <li className="flex justify-between gap-4" key={entry.id}>
                <span>
                  {entry.openedOn} · {entry.number}
                  <span className="ml-1 text-xs text-faint">{entry.status}</span>
                  {entry.odometerOut !== null && (
                    <span className="ml-1 text-xs text-faint">
                      at {entry.odometerOut.toLocaleString()} miles
                    </span>
                  )}
                </span>
                <span className="tabular-nums">{formatCents(entry.totalCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Mix({ mix, check }: Props) {
  if (!mix) {
    return <p className="text-sm text-muted">Your role does not include the shop reports.</p>
  }

  return (
    <div className="space-y-4">
      <div className="card px-4 py-3">
        <h3 className="text-sm font-semibold">What the shop was made of</h3>
        <p className="mt-1 text-xs text-muted">
          Three revenue kinds kept apart, because they behave differently: labour is capacity,
          parts are a margin on somebody else&rsquo;s product, and sublet is neither. One revenue
          figure cannot tell a busy bay from an expensive gearbox.
        </p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-faint">Labour</dt>
            <dd className="text-lg tabular-nums">{formatCents(mix.labourCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Parts</dt>
            <dd className="text-lg tabular-nums">{formatCents(mix.partsCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Sublet</dt>
            <dd className="text-lg tabular-nums">{formatCents(mix.subletCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Made on sublet</dt>
            <dd className="text-lg tabular-nums">{formatCents(mix.subletMarginCents)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-faint">
          The sublet <em>cost</em> is not posted here — the machine shop&rsquo;s invoice comes in
          through accounts payable and is coded to 5180. Accruing it twice is how a shop ends up
          paying for the same gearbox on its own books.
        </p>
      </div>

      {check && (
        <div className="card px-4 py-3">
          <h3 className="text-sm font-semibold">Do the approvals add up?</h3>
          <p className="mt-1 text-xs text-muted">
            Every order&rsquo;s authorised total against its own approvals. These{' '}
            <strong>should</strong> match exactly: the total is a cache and the rows are the
            record, and it is the cache the billing ceiling is computed from — so a drift here is a
            bill somebody could not defend.
          </p>
          <p className={`mt-3 text-lg ${check.agrees ? 'text-success' : 'text-danger'}`}>
            {check.agrees
              ? `Yes — ${formatCents(check.recordedCents)} approved across every order.`
              : `No — ${check.offenders.length} order(s) disagree with their own approvals.`}
          </p>
          {check.offenders.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-danger">
              {check.offenders.map((row) => (
                <li key={row.id}>
                  {row.number}: says {formatCents(row.storedCents)}, approvals total{' '}
                  {formatCents(row.recordedCents)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
