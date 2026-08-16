'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  approveTimeAction,
  billWorkAction,
  logTimeAction,
  receiveRetainerAction,
  submitTimeAction,
  writeOffTimeAction,
} from '@/app/actions/timebilling'
import { formatMinutes, parseDuration } from '@/modules/timebilling/rates'
import { GROUPING_LABELS } from '@/modules/timebilling/vocabulary'
import { formatCents, parseAmountToCents } from '@/lib/money'

type Row = {
  id: string
  workedOn: string
  minutes: number
  description: string
  isBillable: boolean
  status: string
  projectName: string | null
  personName: string
}

type Unbilled = {
  projectId: string | null
  projectName: string
  timeMinutes: number
  timeValueCents: number
  expenseCount: number
  expenseValueCents: number
  totalCents: number
  oldestDate: string | null
}

type Utilization = {
  personName: string
  billableMinutes: number
  totalMinutes: number
  utilizationBasisPoints: number | null
}

type Named = { id: string; name: string }
type Retainer = {
  id: string
  customerId: string
  customerName: string
  remainingCents: number
}

/** How old the oldest unbilled item is, in days. */
function daysOld(date: string | null, today: string): number | null {
  if (!date) return null
  return Math.floor((Date.parse(today) - Date.parse(date)) / 86_400_000)
}

export function TimeBoard({
  today,
  rows,
  unbilled,
  utilization,
  projects,
  customers,
  retainers,
  banks,
  peopleCount,
  canApprove,
}: {
  today: string
  rows: Row[]
  unbilled: Unbilled[]
  utilization: Utilization[]
  projects: Named[]
  customers: Named[]
  retainers: Retainer[]
  banks: Named[]
  peopleCount: number
  canApprove: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [workedOn, setWorkedOn] = useState(today)
  const [duration, setDuration] = useState('')
  const [description, setDescription] = useState('')
  const [isBillable, setIsBillable] = useState(true)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [writeOffReason, setWriteOffReason] = useState('')
  const [showWriteOff, setShowWriteOff] = useState(false)

  const [billing, setBilling] = useState<string | null>(null)
  const [billCustomer, setBillCustomer] = useState(customers[0]?.id ?? '')
  const [grouping, setGrouping] = useState<'person' | 'day' | 'service' | 'single'>('person')
  const [throughDate, setThroughDate] = useState(today)
  const [retainerId, setRetainerId] = useState('')

  const parsed = useMemo(() => (duration ? parseDuration(duration) : null), [duration])
  const unbilledTotal = unbilled.reduce((sum, row) => sum + row.totalCents, 0)
  const oldest = unbilled.reduce<number | null>((worst, row) => {
    const age = daysOld(row.oldestDate, today)
    return age === null ? worst : worst === null ? age : Math.max(worst, age)
  }, null)

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) {
        setSelected(new Set())
        setDuration('')
        setDescription('')
        setShowWriteOff(false)
        setWriteOffReason('')
        setBilling(null)
        router.refresh()
      }
    })
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Time and billing</h2>
        <p className="text-sm text-muted">
          Log it, approve it, bill it. Recording time posts nothing — it becomes revenue when a
          client is invoiced.
        </p>
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
        <Stat label="Unbilled work" value={formatCents(unbilledTotal)} />
        <Stat
          label="Oldest unbilled"
          value={oldest === null ? '—' : `${oldest} days`}
          hint="Work from months ago means the billing is broken, not the client."
          tone={oldest !== null && oldest > 45 ? 'bad' : undefined}
        />
        <Stat label="People logging time" value={String(peopleCount)} />
      </div>

      <section className="card p-4">
        <h3 className="text-sm font-semibold">Log time</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-5">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Engagement</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="field w-full py-1.5 text-sm"
            >
              <option value="">None</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Date</span>
            <input
              type="date"
              value={workedOn}
              onChange={(event) => setWorkedOn(event.target.value)}
              className="field w-full py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">How long</span>
            <input
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              placeholder="1.5, 1:30, 90m"
              className="field w-full py-1.5 text-sm"
            />
            {/* Echoed back as you type, because "1:30" and "1.30" are a very
                easy thing to get wrong and an expensive one. */}
            <span className="mt-1 block text-xs text-faint">
              {duration === '' ? ' ' : parsed === null ? 'Not a length of time' : formatMinutes(parsed)}
            </span>
          </label>
          <label className="col-span-2 text-xs text-muted">
            <span className="mb-1 block">What you did</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What a client would recognize on an invoice"
              className="field w-full py-1.5 text-sm"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isBillable}
              onChange={(event) => setIsBillable(event.target.checked)}
            />
            Billable
          </label>
          <button
            className="btn btn-primary"
            disabled={pending || parsed === null || !description.trim()}
            onClick={() =>
              act(() =>
                logTimeAction({
                  projectId: projectId || undefined,
                  workedOn,
                  duration,
                  description,
                  isBillable,
                }),
              )
            }
          >
            Log it
          </button>
        </div>
      </section>

      {unbilled.length > 0 && (
        <Card
          title="Ready to bill"
          subtitle="Approved work that has not been invoiced. This is the report that pays for the phase."
        >
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Engagement</th>
                <th className="px-4 py-2 text-right font-medium">Time</th>
                <th className="px-4 py-2 text-right font-medium">Expenses</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Oldest</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {unbilled.map((row) => {
                const age = daysOld(row.oldestDate, today)
                return (
                  <tr key={row.projectId ?? 'none'} className="border-t border-line">
                    <td className="px-4 py-1.5">{row.projectName}</td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatMinutes(row.timeMinutes)} · {formatCents(row.timeValueCents)}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right text-muted">
                      {row.expenseCount === 0 ? '—' : formatCents(row.expenseValueCents)}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right font-medium">
                      {formatCents(row.totalCents)}
                    </td>
                    <td className={`px-4 py-1.5 ${age !== null && age > 45 ? 'text-warning' : 'text-muted'}`}>
                      {row.oldestDate ?? '—'}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {canApprove && row.projectId && (
                        <button
                          className="btn btn-ghost text-xs"
                          onClick={() =>
                            setBilling(billing === row.projectId ? null : row.projectId)
                          }
                        >
                          Bill it
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {billing && canApprove && (
            <div className="border-t border-line px-4 py-3">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Client</span>
                  <select
                    value={billCustomer}
                    onChange={(event) => setBillCustomer(event.target.value)}
                    className="field py-1.5 text-sm"
                  >
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Up to</span>
                  <input
                    type="date"
                    value={throughDate}
                    onChange={(event) => setThroughDate(event.target.value)}
                    className="field py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-muted">
                  <span className="mb-1 block">Lines</span>
                  <select
                    value={grouping}
                    onChange={(event) =>
                      setGrouping(event.target.value as 'person' | 'day' | 'service' | 'single')
                    }
                    className="field py-1.5 text-sm"
                  >
                    {Object.entries(GROUPING_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {retainers.length > 0 && (
                  <label className="text-xs text-muted">
                    <span className="mb-1 block">Draw a retainer</span>
                    <select
                      value={retainerId}
                      onChange={(event) => setRetainerId(event.target.value)}
                      className="field py-1.5 text-sm"
                    >
                      <option value="">No</option>
                      {retainers
                        .filter((retainer) => retainer.customerId === billCustomer)
                        .map((retainer) => (
                          <option key={retainer.id} value={retainer.id}>
                            {formatCents(retainer.remainingCents)} left
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <button
                  className="btn btn-primary"
                  disabled={pending || !billCustomer}
                  onClick={() =>
                    act(() =>
                      billWorkAction({
                        projectId: billing,
                        customerId: billCustomer,
                        issueDate: today,
                        throughDate,
                        grouping,
                        applyRetainerId: retainerId || undefined,
                      }),
                    )
                  }
                >
                  Raise the invoice
                </button>
              </div>
              <p className="mt-2 text-xs text-faint">
                How the lines are grouped changes what the client reads, never the total — the
                amounts come from the entries.
              </p>
            </div>
          )}
        </Card>
      )}

      <Card title="Timesheet" subtitle="Newest first.">
        {rows.length === 0 ? (
          <Empty>Nothing logged yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium" />
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Who</th>
                <th className="px-4 py-2 font-medium">Engagement</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 text-right font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    {row.status !== 'billed' && row.status !== 'written_off' && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        aria-label={`Select ${row.description}`}
                      />
                    )}
                  </td>
                  <td className="tnum px-4 py-1.5 text-muted">{row.workedOn}</td>
                  <td className="px-4 py-1.5">{row.personName}</td>
                  <td className="px-4 py-1.5 text-muted">{row.projectName ?? '—'}</td>
                  <td className="px-4 py-1.5">
                    {row.description}
                    {!row.isBillable && (
                      <span className="ml-2 chip bg-raised px-2 py-0.5 text-xs text-muted">
                        not billable
                      </span>
                    )}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">{formatMinutes(row.minutes)}</td>
                  <td className="px-4 py-1.5 text-muted">{row.status.replace('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {selected.size > 0 && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
            <button
              className="btn btn-ghost text-xs"
              disabled={pending}
              onClick={() => act(() => submitTimeAction([...selected]))}
            >
              Submit {selected.size}
            </button>
            {canApprove && (
              <button
                className="btn btn-primary text-xs"
                disabled={pending}
                onClick={() => act(() => approveTimeAction([...selected]))}
              >
                Approve {selected.size}
              </button>
            )}
            {canApprove && (
              <button className="btn btn-ghost text-xs" onClick={() => setShowWriteOff((v) => !v)}>
                Write off
              </button>
            )}
            {showWriteOff && (
              <>
                <input
                  value={writeOffReason}
                  onChange={(event) => setWriteOffReason(event.target.value)}
                  placeholder="Why it is not being charged for"
                  className="field grow py-1.5 text-sm"
                />
                <button
                  className="btn btn-ghost text-xs text-danger"
                  disabled={pending || !writeOffReason.trim()}
                  onClick={() => act(() => writeOffTimeAction([...selected], writeOffReason))}
                >
                  Confirm write-off
                </button>
              </>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Utilization this month"
        subtitle="Billable against time recorded — not against a notional week, which only measures who took leave."
      >
        {utilization.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">
            Nobody has logged time this month yet. An empty month is a fact about the month, not a
            missing report.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {utilization.map((row) => (
                <tr key={row.personName} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-1.5">{row.personName}</td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">
                    {formatMinutes(row.billableMinutes)} of {formatMinutes(row.totalMinutes)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right font-medium">
                    {row.utilizationBasisPoints === null
                      ? '—'
                      : `${(row.utilizationBasisPoints / 100).toFixed(0)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {canApprove && customers.length > 0 && banks.length > 0 && (
        <RetainerForm
          customers={customers}
          banks={banks}
          today={today}
          act={act}
          pending={pending}
        />
      )}
    </div>
  )
}

function RetainerForm({
  customers,
  banks,
  today,
  act,
  pending,
}: {
  customers: Named[]
  banks: Named[]
  today: string
  act: (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '')
  const [bankId, setBankId] = useState(banks[0]?.id ?? '')
  const [amount, setAmount] = useState('')

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Retainers</h3>
          <p className="text-xs text-muted">
            Money taken before the work is done. A liability until it is earned, never revenue on
            arrival.
          </p>
        </div>
        <button className="btn btn-ghost text-xs" onClick={() => setOpen((v) => !v)}>
          Record one
        </button>
      </div>

      {open && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Client</span>
            <select
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              className="field py-1.5 text-sm"
            >
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Into</span>
            <select
              value={bankId}
              onChange={(event) => setBankId(event.target.value)}
              className="field py-1.5 text-sm"
            >
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Amount</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="field py-1.5 text-sm"
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={pending || !customerId || !bankId || !amount.trim()}
            onClick={() =>
              act(() =>
                receiveRetainerAction({
                  customerId,
                  receivedOn: today,
                  amountCents: parseAmountToCents(amount) ?? 0,
                  financialAccountId: bankId,
                }),
              )
            }
          >
            Record retainer
          </button>
        </div>
      )}
    </section>
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
