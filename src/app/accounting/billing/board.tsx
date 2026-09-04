'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createScheduleAction,
  raiseOccurrenceAction,
  runDueSchedulesAction,
  setScheduleActiveAction,
  type ActionResult,
} from '@/app/actions/billing'
import { formatCents } from '@/lib/money'

type Schedule = {
  id: string
  name: string
  customerName: string
  cadence: string
  dayOfMonth: number
  autoRaise: boolean
  isActive: boolean
  startsOn: string
  endsOn: string | null
  nextRunOn: string
  lastRunOn: string | null
  occurrenceCount: number
  perOccurrenceCents: number
}

type Detail = {
  lines: Array<{
    id: string
    description: string
    quantityMilli: number
    unitPriceCents: number
  }>
  history: Array<{
    id: string
    occurredOn: string
    totalCents: number
    invoiceNumber: string | null
    invoiceStatus: string | null
    balanceCents: number | null
    /** The raised invoice's own currency (Phase 125). */
    invoiceCurrency: string | null
  }>
  perOccurrenceCents: number
}

type Waiting = {
  occurrenceId: string
  scheduleId: string
  name: string
  customerName: string
  occurredOn: string
  totalCents: number
}

type Forecast = {
  from: string
  through: string
  occurrences: Array<{
    scheduleId: string
    name: string
    customerName: string
    dueOn: string
    totalCents: number
    autoRaise: boolean
    overdue: boolean
  }>
  totalCents: number
  automaticCents: number
  manualCents: number
  overdueCents: number
  scheduleCount: number
}

const CADENCE_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
}

/**
 * Arrangements to bill a customer every period.
 *
 * ## What this screen is careful not to say
 *
 * The forecast is the largest number here, and it is not a receivable. Nobody
 * has been invoiced for any of it. The wording says so out loud, because a
 * figure that size on an accounting screen will be read as money owed unless
 * something stops it being.
 */
export function BillingBoard({
  schedules,
  selectedId,
  detail,
  waiting,
  forecast,
  canForecast,
  canManage,
  canCreate,
  customers,
  accounts,
}: {
  schedules: Schedule[]
  selectedId: string | null
  detail: Detail | null
  waiting: Waiting[]
  forecast: Forecast | null
  canForecast: boolean
  canManage: boolean
  canCreate: boolean
  customers: Array<{ id: string; name: string }>
  accounts: Array<{ id: string; number: string; name: string }>
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showNew, setShowNew] = useState(false)

  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [cadence, setCadence] = useState('monthly')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10))
  const [autoRaise, setAutoRaise] = useState(true)

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  const selected = schedules.find((row) => row.id === selectedId) ?? null

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Recurring billing</h2>
        <p className="text-sm text-muted">
          Arrangements to invoice a customer every period — retainers, maintenance contracts,
          subscriptions.{' '}
          <span className="text-faint">
            A schedule is a promise to bill, not a bill. Nothing is owed and nothing ages until a
            period arrives and a real invoice is raised.
          </span>
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

      {waiting.length > 0 && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">Waiting for somebody to raise them</h3>
          <p className="mt-1 text-xs text-muted">
            These periods came due on a schedule that does not raise its own invoices. The period
            is already claimed, so it cannot be billed twice — but nothing further happens on its
            own, which is why it is at the top of this page.
          </p>
          <ul className="mt-3 space-y-2">
            {waiting.map((row) => (
              <li
                key={row.occurrenceId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line/50 pb-2 text-sm"
              >
                <span>
                  <span className="font-medium">{row.name}</span>{' '}
                  <span className="text-muted">
                    · {row.customerName} · due {row.occurredOn}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{formatCents(row.totalCents)}</span>
                  {canManage && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        act(() => raiseOccurrenceAction({ occurrenceId: row.occurrenceId }))
                      }
                      className="btn btn-primary py-1 text-xs"
                    >
                      Raise the invoice
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canForecast && forecast && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">
            What is coming, {forecast.from} to {forecast.through}
          </h3>
          <p className="mt-1 text-xs text-muted">
            <strong className="text-ink">Reported, never posted.</strong> Nobody has been invoiced
            for any of this, nothing is owed, and none of it is on a statement. Schedules get
            cancelled and prices change — which is exactly why this is a screen rather than a
            journal entry.
          </p>

          {forecast.occurrences.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              Nothing is due in this window. An arrangement that has been paused, or has passed its
              end date, is deliberately not counted here — it is not going to bill.
            </p>
          ) : (
            <>
              <p className="mt-3 text-sm">
                <span className="text-muted">Raised automatically</span>{' '}
                <span className="tabular-nums">{formatCents(forecast.automaticCents)}</span>
                <span className="text-faint"> · </span>
                <span className="text-muted">waiting for somebody</span>{' '}
                <span className="tabular-nums">{formatCents(forecast.manualCents)}</span>
                <span className="text-faint"> · </span>
                <span className="text-muted">across</span>{' '}
                <span className="tabular-nums">
                  {forecast.scheduleCount} schedule{forecast.scheduleCount === 1 ? '' : 's'}
                </span>
                {forecast.overdueCents > 0 && (
                  <>
                    <span className="text-faint"> · </span>
                    <span className="text-danger">
                      {formatCents(forecast.overdueCents)} already overdue
                    </span>
                  </>
                )}
              </p>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line text-left">
                      <th className="py-1.5 pr-3">Due</th>
                      <th className="py-1.5 pr-3">Arrangement</th>
                      <th className="py-1.5 pr-3">Customer</th>
                      <th className="py-1.5 pr-3">How</th>
                      <th className="py-1.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecast.occurrences.map((row, index) => (
                      <tr key={`${row.scheduleId}-${row.dueOn}-${index}`} className="border-b border-line/50">
                        <td
                          className={`py-1.5 pr-3 tabular-nums ${row.overdue ? 'text-danger' : ''}`}
                        >
                          {row.dueOn}
                          {row.overdue && <span className="ml-1 text-xs">overdue</span>}
                        </td>
                        <td className="py-1.5 pr-3">{row.name}</td>
                        <td className="py-1.5 pr-3 text-muted">{row.customerName}</td>
                        <td className="py-1.5 pr-3 text-muted">
                          {row.autoRaise ? 'automatically' : 'needs a person'}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {formatCents(row.totalCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-medium">
                      <td className="py-1.5 pr-3" colSpan={4}>
                        Forecast total — not owed by anybody
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(forecast.totalCents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      <section className="card px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">Arrangements</h3>
          <div className="flex items-center gap-2">
            {canManage && (
              <button
                type="button"
                disabled={pending}
                onClick={() => act(() => runDueSchedulesAction({}))}
                className="btn btn-secondary py-1.5 text-sm"
              >
                Raise anything due now
              </button>
            )}
            {canCreate && (
              <button
                type="button"
                onClick={() => setShowNew((value) => !value)}
                className="btn btn-primary py-1.5 text-sm"
              >
                {showNew ? 'Cancel' : 'New arrangement'}
              </button>
            )}
          </div>
        </div>

        {canManage && (
          <p className="mt-1 text-xs text-faint">
            The daily job does this on its own at 5am. The button is for somebody who does not want
            to wait — running it twice bills once, because the period is claimed by the database
            rather than by whoever pressed it.
          </p>
        )}

        {showNew && canCreate && (
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Customer</span>
              <select
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
                className="field w-full py-1.5 text-sm"
              >
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Called</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ashwood — monthly retainer"
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Revenue account</span>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="field w-full py-1.5 text-sm"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.number} {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">What the customer reads</span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Monthly retainer"
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Amount each time</span>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="500.00"
                inputMode="decimal"
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">How often</span>
              <select
                value={cadence}
                onChange={(event) => setCadence(event.target.value)}
                className="field w-full py-1.5 text-sm"
              >
                {Object.entries(CADENCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {cadence !== 'weekly' && (
              <label className="text-xs text-muted">
                <span className="mb-1 block">On the</span>
                <select
                  value={dayOfMonth}
                  onChange={(event) => setDayOfMonth(event.target.value)}
                  className="field w-full py-1.5 text-sm"
                >
                  {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-faint">
                  Up to the 28th — not every month has a 31st.
                </span>
              </label>
            )}
            <label className="text-xs text-muted">
              <span className="mb-1 block">Starting</span>
              <input
                type="date"
                value={startsOn}
                onChange={(event) => setStartsOn(event.target.value)}
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={autoRaise}
                onChange={(event) => setAutoRaise(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Raise the invoice automatically
                <span className="mt-0.5 block text-faint">
                  Off means the period is claimed and waits for somebody — right when the amount is
                  something a person checks first.
                </span>
              </span>
            </label>
            <div className="sm:col-span-2 lg:col-span-3">
              <button
                type="button"
                disabled={pending || !customerId || !name.trim() || !description.trim() || !amount.trim()}
                onClick={() =>
                  act(async () => {
                    const result = await createScheduleAction({
                      customerId,
                      name: name.trim(),
                      cadence,
                      dayOfMonth: cadence === 'weekly' ? undefined : Number(dayOfMonth),
                      autoRaise,
                      startsOn,
                      chartAccountId: accountId,
                      description: description.trim(),
                      amount,
                    })
                    if (result.ok) {
                      setShowNew(false)
                      setName('')
                      setDescription('')
                      setAmount('')
                    }
                    return result
                  })
                }
                className="btn btn-primary py-1.5 text-sm"
              >
                Set it up
              </button>
            </div>
          </div>
        )}

        {schedules.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Nothing set up yet. An arrangement here bills a customer the same amount every period
            without anybody remembering to — and until the first period arrives, it owes nobody
            anything.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line text-left">
                  <th className="py-1.5 pr-3">Arrangement</th>
                  <th className="py-1.5 pr-3">Customer</th>
                  <th className="py-1.5 pr-3">How often</th>
                  <th className="py-1.5 pr-3 text-right">Each time</th>
                  <th className="py-1.5 pr-3">Next</th>
                  <th className="py-1.5 pr-3 text-right">Billed</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {schedules.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-line/50 ${row.id === selectedId ? 'bg-raised' : ''}`}
                  >
                    <td className="py-1.5 pr-3">
                      <button
                        type="button"
                        onClick={() => router.push(`/accounting/billing?s=${row.id}`)}
                        className="text-left font-medium hover:underline"
                      >
                        {row.name}
                      </button>
                      {!row.isActive && <span className="ml-2 text-xs text-muted">paused</span>}
                      {!row.autoRaise && (
                        <span className="ml-2 text-xs text-muted">needs a person</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted">{row.customerName}</td>
                    <td className="py-1.5 pr-3 text-muted">
                      {CADENCE_LABELS[row.cadence] ?? row.cadence}
                      {row.cadence !== 'weekly' && ` · ${row.dayOfMonth}`}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatCents(row.perOccurrenceCents)}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-muted">
                      {row.isActive ? row.nextRunOn : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                      {row.occurrenceCount}
                    </td>
                    <td className="py-1.5 text-right">
                      {canManage && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            act(() =>
                              setScheduleActiveAction({
                                scheduleId: row.id,
                                isActive: !row.isActive,
                              }),
                            )
                          }
                          className="btn btn-secondary py-1 text-xs"
                        >
                          {row.isActive ? 'Pause' : 'Resume'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && detail && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">{selected.name}</h3>
          <p className="mt-1 text-xs text-muted">
            {CADENCE_LABELS[selected.cadence] ?? selected.cadence} · {selected.customerName} ·
            started {selected.startsOn}
            {selected.endsOn ? ` · ends ${selected.endsOn}` : ''} ·{' '}
            {formatCents(detail.perOccurrenceCents)} each time
          </p>

          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
            What it bills
          </h4>
          <ul className="mt-1 space-y-1 text-sm">
            {detail.lines.map((line) => (
              <li key={line.id} className="text-muted">
                {line.description} —{' '}
                <span className="tabular-nums">{formatCents(line.unitPriceCents)}</span>
                {line.quantityMilli !== 1000 && (
                  <span className="text-faint"> × {(line.quantityMilli / 1000).toFixed(3)}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-faint">
            Changing these changes the future, not the past. Invoices already raised are documents
            a customer holds, and editing an arrangement cannot reach back and restate them.
          </p>

          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">
            What it has billed
          </h4>
          {detail.history.length === 0 ? (
            <p className="mt-1 text-sm text-muted">Nothing yet.</p>
          ) : (
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-line text-left">
                    <th className="py-1.5 pr-3">Period</th>
                    <th className="py-1.5 pr-3">Invoice</th>
                    <th className="py-1.5 pr-3">Status</th>
                    <th className="py-1.5 pr-3 text-right">Billed</th>
                    <th className="py-1.5 text-right">Still owed</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.history.map((row) => (
                    <tr key={row.id} className="border-b border-line/50">
                      <td className="py-1.5 pr-3 tabular-nums">{row.occurredOn}</td>
                      <td className="py-1.5 pr-3">{row.invoiceNumber ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-muted">
                        {row.invoiceStatus ?? 'not raised'}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {formatCents(row.totalCents)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {row.balanceCents === null
                          ? '—'
                          : formatCents(row.balanceCents, row.invoiceCurrency ?? undefined)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
