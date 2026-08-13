'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents, parseAmountToCents } from '@/lib/money'
import { formatBasisPoints } from '@/lib/ratio'
import {
  approveChangeOrderAction,
  createChangeOrderAction,
  createProgressBillingAction,
  rejectChangeOrderAction,
  releaseRetainageAction,
  setJobBudgetAction,
  setScheduleOfValuesAction,
} from '@/app/actions/jobs'

export type CostCodeOption = { id: string; code: string; name: string }
export type AccountOption = { id: string; number: string; name: string }
export type CustomerOption = { id: string; name: string }

export type BudgetRow = {
  costCodeId: string | null
  code: string
  name: string
  costType: string
  actualCents: number
  originalBudgetCents: number
  changeBudgetCents: number
  revisedBudgetCents: number
  varianceCents: number
  spentBp: number | null
}

export type ChangeOrderRow = {
  id: string
  number: string
  title: string
  status: string
  contractAmountCents: number
  costAmountCents: number
  decidedOn: string | null
}

export type SovRow = {
  id: string
  itemNumber: string
  description: string
  scheduledValueCents: number
  chartAccountId: string
  billedCents: number
}

export type ApplicationRow = {
  id: string
  applicationNumber: number
  billingDate: string
  thisPeriodCents: number
  retainedCents: number
  netDueCents: number
  isRetainageRelease: boolean
  invoiceNumber: string | null
  invoiceBalanceCents: number | null
}

/**
 * The job workspace's editing surface.
 *
 * One client component with three tabs rather than three pages: budget,
 * change orders, and billing are the same conversation about one job, and a
 * contractor updating a budget after approving a change order should not lose
 * their place.
 */
export function JobPanels({
  projectId,
  terms,
  canManage,
  budget,
  changeOrders,
  sov,
  applications,
  costCodes,
  revenueAccounts,
  customers,
  retainageHeldCents,
  defaultRetainageBp,
}: {
  projectId: string
  terms: { job: string; customer: string }
  canManage: boolean
  budget: BudgetRow[]
  changeOrders: ChangeOrderRow[]
  sov: SovRow[]
  applications: ApplicationRow[]
  costCodes: CostCodeOption[]
  revenueAccounts: AccountOption[]
  customers: CustomerOption[]
  retainageHeldCents: number
  defaultRetainageBp: number
}) {
  const [tab, setTab] = useState<'budget' | 'changes' | 'billing'>('budget')

  const tabs = [
    { key: 'budget' as const, label: 'Budget vs actual' },
    { key: 'changes' as const, label: `Change orders (${changeOrders.length})` },
    { key: 'billing' as const, label: `Billing (${applications.length})` },
  ]

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 overflow-x-auto">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            onClick={() => setTab(entry.key)}
            className={`chip whitespace-nowrap px-3 py-1.5 ${
              tab === entry.key ? 'bg-brand text-brand-ink' : 'bg-raised text-muted hover:text-ink'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'budget' && (
        <BudgetPanel
          projectId={projectId}
          rows={budget}
          costCodes={costCodes}
          canManage={canManage}
        />
      )}

      {tab === 'changes' && (
        <ChangeOrderPanel
          projectId={projectId}
          orders={changeOrders}
          costCodes={costCodes}
          canManage={canManage}
        />
      )}

      {tab === 'billing' && (
        <BillingPanel
          projectId={projectId}
          terms={terms}
          sov={sov}
          applications={applications}
          revenueAccounts={revenueAccounts}
          customers={customers}
          canManage={canManage}
          retainageHeldCents={retainageHeldCents}
          defaultRetainageBp={defaultRetainageBp}
        />
      )}
    </div>
  )
}

// --- Shared ----------------------------------------------------------------

function Notice({ message }: { message: { text: string; ok: boolean } | null }) {
  if (!message) return null
  return (
    <p className={`mt-2 text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}>
      {message.text}
    </p>
  )
}

function Panel({
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
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      {children}
    </section>
  )
}

/** Money entry that keeps the raw text so a half-typed amount is not mangled. */
function amountToCents(raw: string): number {
  if (!raw.trim()) return 0
  try {
    return parseAmountToCents(raw)
  } catch {
    return NaN
  }
}

// --- Budget ----------------------------------------------------------------

function BudgetPanel({
  projectId,
  rows,
  costCodes,
  canManage,
}: {
  projectId: string
  rows: BudgetRow[]
  costCodes: CostCodeOption[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [editing, setEditing] = useState(false)

  const [draft, setDraft] = useState<Array<{ costCodeId: string; amount: string }>>(() =>
    rows
      .filter((row) => row.costCodeId)
      .map((row) => ({ costCodeId: row.costCodeId!, amount: (row.originalBudgetCents / 100).toFixed(2) })),
  )

  const totals = rows.reduce(
    (sum, row) => ({
      original: sum.original + row.originalBudgetCents,
      change: sum.change + row.changeBudgetCents,
      revised: sum.revised + row.revisedBudgetCents,
      actual: sum.actual + row.actualCents,
    }),
    { original: 0, change: 0, revised: 0, actual: 0 },
  )

  function save() {
    const lines = draft
      .filter((line) => line.costCodeId)
      .map((line) => ({
        costCodeId: line.costCodeId,
        originalAmountCents: amountToCents(line.amount),
      }))

    if (lines.some((line) => Number.isNaN(line.originalAmountCents))) {
      setMessage({ text: 'One of those amounts is not a number.', ok: false })
      return
    }
    if (lines.length === 0) {
      setMessage({ text: 'Add at least one budget line.', ok: false })
      return
    }

    startTransition(async () => {
      const result = await setJobBudgetAction({ projectId, lines })
      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })
      if (result.ok) {
        setEditing(false)
        router.refresh()
      }
    })
  }

  return (
    <Panel
      title="Budget vs actual"
      subtitle="Actual is posted ledger cost carrying this job and cost code. Nothing here is a cached total."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Cost code</th>
              <th className="px-4 py-2 text-right font-medium">Original</th>
              <th className="px-4 py-2 text-right font-medium">Changes</th>
              <th className="px-4 py-2 text-right font-medium">Revised</th>
              <th className="px-4 py-2 text-right font-medium">Actual</th>
              <th className="px-4 py-2 text-right font-medium">Variance</th>
              <th className="px-4 py-2 text-right font-medium">Spent</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                  No budget and no cost posted yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.costCodeId ?? 'unassigned'} className="border-t border-line">
                <td className="px-4 py-1.5">
                  <span className="font-medium">{row.code}</span>{' '}
                  <span className="text-muted">{row.name}</span>
                </td>
                <td className="tnum px-4 py-1.5 text-right">
                  {formatCents(row.originalBudgetCents)}
                </td>
                <td className="tnum px-4 py-1.5 text-right">
                  {row.changeBudgetCents === 0 ? '—' : formatCents(row.changeBudgetCents)}
                </td>
                <td className="tnum px-4 py-1.5 text-right">
                  {formatCents(row.revisedBudgetCents)}
                </td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(row.actualCents)}</td>
                <td
                  className={`tnum px-4 py-1.5 text-right ${
                    row.varianceCents < 0 ? 'text-negative' : ''
                  }`}
                >
                  {formatCents(row.varianceCents)}
                </td>
                <td className="tnum px-4 py-1.5 text-right">
                  {row.spentBp === null ? '—' : formatBasisPoints(row.spentBp)}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-line font-medium">
                <td className="px-4 py-2">Total</td>
                <td className="tnum px-4 py-2 text-right">{formatCents(totals.original)}</td>
                <td className="tnum px-4 py-2 text-right">{formatCents(totals.change)}</td>
                <td className="tnum px-4 py-2 text-right">{formatCents(totals.revised)}</td>
                <td className="tnum px-4 py-2 text-right">{formatCents(totals.actual)}</td>
                <td className="tnum px-4 py-2 text-right">
                  {formatCents(totals.revised - totals.actual)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {canManage && (
        <div className="border-t border-line p-4">
          {!editing ? (
            <button className="btn text-xs" onClick={() => setEditing(true)}>
              Edit budget
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Editing the original estimate. Approved change orders are kept separately and are
                not affected.
              </p>
              {draft.map((line, index) => (
                <div key={index} className="flex flex-wrap gap-2">
                  <select
                    className="field flex-1"
                    value={line.costCodeId}
                    onChange={(event) =>
                      setDraft((current) =>
                        current.map((entry, i) =>
                          i === index ? { ...entry, costCodeId: event.target.value } : entry,
                        ),
                      )
                    }
                  >
                    <option value="">Choose a cost code…</option>
                    {costCodes.map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.code} — {code.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field w-32 text-right"
                    inputMode="decimal"
                    value={line.amount}
                    onChange={(event) =>
                      setDraft((current) =>
                        current.map((entry, i) =>
                          i === index ? { ...entry, amount: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                  <button
                    className="btn text-xs"
                    onClick={() =>
                      setDraft((current) => current.filter((_, i) => i !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  className="btn text-xs"
                  onClick={() => setDraft((current) => [...current, { costCodeId: '', amount: '' }])}
                >
                  Add line
                </button>
                <button className="btn btn-primary text-xs" onClick={save} disabled={pending}>
                  {pending ? 'Saving…' : 'Save budget'}
                </button>
                <button className="btn text-xs" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <Notice message={message} />
        </div>
      )}
    </Panel>
  )
}

// --- Change orders ---------------------------------------------------------

function ChangeOrderPanel({
  projectId,
  orders,
  costCodes,
  canManage,
}: {
  projectId: string
  orders: ChangeOrderRow[]
  costCodes: CostCodeOption[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [open, setOpen] = useState(false)

  const [title, setTitle] = useState('')
  const [contract, setContract] = useState('')
  const [lines, setLines] = useState<Array<{ costCodeId: string; amount: string }>>([
    { costCodeId: '', amount: '' },
  ])

  function create() {
    const contractAmountCents = amountToCents(contract)
    if (Number.isNaN(contractAmountCents)) {
      setMessage({ text: 'That contract amount is not a number.', ok: false })
      return
    }

    const costLines = lines
      .filter((line) => line.costCodeId && line.amount.trim())
      .map((line) => ({ costCodeId: line.costCodeId, amountCents: amountToCents(line.amount) }))

    if (costLines.some((line) => Number.isNaN(line.amountCents))) {
      setMessage({ text: 'One of those cost amounts is not a number.', ok: false })
      return
    }

    startTransition(async () => {
      const result = await createChangeOrderAction({
        projectId,
        title,
        contractAmountCents,
        lines: costLines,
      })
      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })
      if (result.ok) {
        setOpen(false)
        setTitle('')
        setContract('')
        setLines([{ costCodeId: '', amount: '' }])
        router.refresh()
      }
    })
  }

  function decide(id: string, approve: boolean) {
    startTransition(async () => {
      const result = approve
        ? await approveChangeOrderAction(id, projectId)
        : await rejectChangeOrderAction(id, projectId)
      setMessage({ text: result.ok ? (result.message ?? 'Done.') : result.error, ok: result.ok })
      if (result.ok) router.refresh()
    })
  }

  return (
    <Panel
      title="Change orders"
      subtitle="Approving one revises the contract value and the budget. It posts nothing to the ledger — the work has not happened yet."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">No.</th>
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-4 py-2 text-right font-medium">Contract</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
              <th className="px-4 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                  No change orders on this job.
                </td>
              </tr>
            )}
            {orders.map((order) => (
              <tr key={order.id} className="border-t border-line">
                <td className="px-4 py-1.5 font-medium">{order.number}</td>
                <td className="px-4 py-1.5">{order.title}</td>
                <td className="tnum px-4 py-1.5 text-right">
                  {formatCents(order.contractAmountCents)}
                </td>
                <td className="tnum px-4 py-1.5 text-right">
                  {formatCents(order.costAmountCents)}
                </td>
                <td className="px-4 py-1.5 text-right">
                  {order.status === 'approved' || order.status === 'rejected' ? (
                    <span
                      className={order.status === 'approved' ? 'text-positive' : 'text-muted'}
                    >
                      {order.status === 'approved' ? 'Approved' : 'Rejected'}
                    </span>
                  ) : canManage ? (
                    <span className="flex justify-end gap-1">
                      <button
                        className="btn px-2 py-1 text-xs"
                        onClick={() => decide(order.id, true)}
                        disabled={pending}
                      >
                        Approve
                      </button>
                      <button
                        className="btn px-2 py-1 text-xs"
                        onClick={() => decide(order.id, false)}
                        disabled={pending}
                      >
                        Reject
                      </button>
                    </span>
                  ) : (
                    <span className="text-muted">Pending</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="border-t border-line p-4">
          {!open ? (
            <button className="btn text-xs" onClick={() => setOpen(true)}>
              Raise a change order
            </button>
          ) : (
            <div className="space-y-2">
              <input
                className="field w-full"
                placeholder="What changed?"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <label className="block text-xs text-muted">
                Change to the contract value (negative for a credit)
                <input
                  className="field mt-1 w-full"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={contract}
                  onChange={(event) => setContract(event.target.value)}
                />
              </label>

              <p className="text-xs text-muted">Cost budget impact, by cost code:</p>
              {lines.map((line, index) => (
                <div key={index} className="flex flex-wrap gap-2">
                  <select
                    className="field flex-1"
                    value={line.costCodeId}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((entry, i) =>
                          i === index ? { ...entry, costCodeId: event.target.value } : entry,
                        ),
                      )
                    }
                  >
                    <option value="">Choose a cost code…</option>
                    {costCodes.map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.code} — {code.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field w-32 text-right"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((entry, i) =>
                          i === index ? { ...entry, amount: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                </div>
              ))}

              <div className="flex gap-2">
                <button
                  className="btn text-xs"
                  onClick={() => setLines((current) => [...current, { costCodeId: '', amount: '' }])}
                >
                  Add cost line
                </button>
                <button className="btn btn-primary text-xs" onClick={create} disabled={pending}>
                  {pending ? 'Saving…' : 'Raise change order'}
                </button>
                <button className="btn text-xs" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <Notice message={message} />
        </div>
      )}
    </Panel>
  )
}

// --- Billing ---------------------------------------------------------------

function BillingPanel({
  projectId,
  terms,
  sov,
  applications,
  revenueAccounts,
  customers,
  canManage,
  retainageHeldCents,
  defaultRetainageBp,
}: {
  projectId: string
  terms: { job: string; customer: string }
  sov: SovRow[]
  applications: ApplicationRow[]
  revenueAccounts: AccountOption[]
  customers: CustomerOption[]
  canManage: boolean
  retainageHeldCents: number
  defaultRetainageBp: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [mode, setMode] = useState<'none' | 'sov' | 'apply' | 'release'>('none')

  const today = new Date().toISOString().slice(0, 10)
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '')
  const [billingDate, setBillingDate] = useState(today)
  const [retainagePercent, setRetainagePercent] = useState(String(defaultRetainageBp / 100))
  const [progress, setProgress] = useState<Record<string, string>>({})

  const [sovDraft, setSovDraft] = useState(() =>
    sov.map((item) => ({
      itemNumber: item.itemNumber,
      description: item.description,
      amount: (item.scheduledValueCents / 100).toFixed(2),
      chartAccountId: item.chartAccountId,
    })),
  )

  const scheduledTotal = sov.reduce((sum, item) => sum + item.scheduledValueCents, 0)
  const billedTotal = sov.reduce((sum, item) => sum + item.billedCents, 0)

  /** What this application would bill, computed as the person types. */
  const preview = useMemo(() => {
    const thisPeriod = sov.reduce((sum, item) => {
      const raw = progress[item.id]
      if (raw === undefined || raw.trim() === '') return sum
      const bp = Math.round(Number(raw) * 100)
      if (!Number.isFinite(bp)) return sum
      const completed = Math.round((item.scheduledValueCents * bp) / 10_000)
      return sum + Math.max(0, completed - item.billedCents)
    }, 0)

    const bp = Math.round(Number(retainagePercent || '0') * 100)
    const retained = Math.round((thisPeriod * (Number.isFinite(bp) ? bp : 0)) / 10_000)
    return { thisPeriod, retained, net: thisPeriod - retained }
  }, [progress, retainagePercent, sov])

  function saveSov() {
    const lines = sovDraft
      .filter((line) => line.itemNumber.trim() && line.chartAccountId)
      .map((line) => ({
        itemNumber: line.itemNumber.trim(),
        description: line.description.trim() || line.itemNumber.trim(),
        scheduledValueCents: amountToCents(line.amount),
        chartAccountId: line.chartAccountId,
      }))

    if (lines.length === 0) {
      setMessage({ text: 'Add at least one contract item.', ok: false })
      return
    }
    if (lines.some((line) => Number.isNaN(line.scheduledValueCents))) {
      setMessage({ text: 'One of those values is not a number.', ok: false })
      return
    }

    startTransition(async () => {
      const result = await setScheduleOfValuesAction({ projectId, lines })
      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })
      if (result.ok) {
        setMode('none')
        router.refresh()
      }
    })
  }

  function issue() {
    const lines = Object.entries(progress)
      .filter(([, value]) => value.trim() !== '')
      .map(([scheduleOfValuesId, value]) => ({
        scheduleOfValuesId,
        percentCompleteBp: Math.round(Number(value) * 100),
      }))

    if (lines.length === 0) {
      setMessage({ text: 'Enter percent complete on at least one item.', ok: false })
      return
    }
    if (!customerId) {
      setMessage({ text: `Choose the ${terms.customer.toLowerCase()} to bill.`, ok: false })
      return
    }

    startTransition(async () => {
      const result = await createProgressBillingAction({
        projectId,
        customerId,
        periodEnd: billingDate,
        billingDate,
        retainagePercentBp: Math.round(Number(retainagePercent || '0') * 100),
        lines,
      })
      setMessage({ text: result.ok ? (result.message ?? 'Issued.') : result.error, ok: result.ok })
      if (result.ok) {
        setMode('none')
        setProgress({})
        router.refresh()
      }
    })
  }

  function release() {
    startTransition(async () => {
      const result = await releaseRetainageAction({ projectId, customerId, billingDate })
      setMessage({ text: result.ok ? (result.message ?? 'Released.') : result.error, ok: result.ok })
      if (result.ok) {
        setMode('none')
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Schedule of values"
        subtitle="The contract broken into billable items. Applications measure percent complete against these."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 text-right font-medium">Scheduled value</th>
                <th className="px-4 py-2 text-right font-medium">Billed to date</th>
                <th className="px-4 py-2 text-right font-medium">% complete</th>
              </tr>
            </thead>
            <tbody>
              {sov.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                    No schedule of values yet. Add one to start progress billing.
                  </td>
                </tr>
              )}
              {sov.map((item) => (
                <tr key={item.id} className="border-t border-line">
                  <td className="px-4 py-1.5 font-medium">{item.itemNumber}</td>
                  <td className="px-4 py-1.5">{item.description}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(item.scheduledValueCents)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(item.billedCents)}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {item.scheduledValueCents === 0
                      ? '—'
                      : formatBasisPoints(
                          Math.round((item.billedCents / item.scheduledValueCents) * 10_000),
                        )}
                  </td>
                </tr>
              ))}
            </tbody>
            {sov.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-line font-medium">
                  <td className="px-4 py-2" colSpan={2}>
                    Total
                  </td>
                  <td className="tnum px-4 py-2 text-right">{formatCents(scheduledTotal)}</td>
                  <td className="tnum px-4 py-2 text-right">{formatCents(billedTotal)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {canManage && (
          <div className="border-t border-line p-4">
            {mode !== 'sov' ? (
              <button className="btn text-xs" onClick={() => setMode('sov')}>
                {sov.length === 0 ? 'Add a schedule of values' : 'Edit schedule of values'}
              </button>
            ) : (
              <div className="space-y-2">
                {sovDraft.map((line, index) => (
                  <div key={index} className="flex flex-wrap gap-2">
                    <input
                      className="field w-20"
                      placeholder="1"
                      value={line.itemNumber}
                      onChange={(event) =>
                        setSovDraft((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, itemNumber: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <input
                      className="field flex-1"
                      placeholder="Description"
                      value={line.description}
                      onChange={(event) =>
                        setSovDraft((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, description: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <select
                      className="field w-52"
                      value={line.chartAccountId}
                      onChange={(event) =>
                        setSovDraft((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, chartAccountId: event.target.value } : entry,
                          ),
                        )
                      }
                    >
                      <option value="">Revenue account…</option>
                      {revenueAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.number} — {account.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="field w-32 text-right"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={line.amount}
                      onChange={(event) =>
                        setSovDraft((current) =>
                          current.map((entry, i) =>
                            i === index ? { ...entry, amount: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </div>
                ))}
                <div className="flex gap-2">
                  <button
                    className="btn text-xs"
                    onClick={() =>
                      setSovDraft((current) => [
                        ...current,
                        {
                          itemNumber: String(current.length + 1),
                          description: '',
                          amount: '',
                          chartAccountId: revenueAccounts[0]?.id ?? '',
                        },
                      ])
                    }
                  >
                    Add item
                  </button>
                  <button className="btn btn-primary text-xs" onClick={saveSov} disabled={pending}>
                    {pending ? 'Saving…' : 'Save schedule'}
                  </button>
                  <button className="btn text-xs" onClick={() => setMode('none')}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Applications for payment"
        subtitle="Each one is issued as an ordinary invoice. Retainage is debited to Retainage Receivable rather than left in AR."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">App.</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 text-right font-medium">This period</th>
                <th className="px-4 py-2 text-right font-medium">Retained</th>
                <th className="px-4 py-2 text-right font-medium">Net due</th>
                <th className="px-4 py-2 text-right font-medium">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {applications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                    Nothing billed on this {terms.job.toLowerCase()} yet.
                  </td>
                </tr>
              )}
              {applications.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-1.5 font-medium">
                    {row.applicationNumber}
                    {row.isRetainageRelease && (
                      <span className="ml-1 text-xs text-muted">(retainage)</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5">{row.billingDate}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(row.thisPeriodCents)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {row.retainedCents === 0 ? '—' : formatCents(row.retainedCents)}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(row.netDueCents)}</td>
                  <td className="px-4 py-1.5 text-right">{row.invoiceNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-line p-4">
          <p className="mb-3 text-xs text-muted">
            Retainage currently held on this {terms.job.toLowerCase()}:{' '}
            <span className="tnum font-medium text-ink">{formatCents(retainageHeldCents)}</span>
          </p>

          {canManage && mode !== 'apply' && mode !== 'release' && (
            <div className="flex flex-wrap gap-2">
              <button
                className="btn text-xs"
                onClick={() => setMode('apply')}
                disabled={sov.length === 0}
              >
                File an application
              </button>
              {retainageHeldCents > 0 && (
                <button className="btn text-xs" onClick={() => setMode('release')}>
                  Release retainage
                </button>
              )}
            </div>
          )}

          {mode === 'apply' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <select
                  className="field flex-1"
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  <option value="">Choose a {terms.customer.toLowerCase()}…</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
                <input
                  className="field w-40"
                  type="date"
                  value={billingDate}
                  onChange={(event) => setBillingDate(event.target.value)}
                />
                <label className="flex items-center gap-1 text-xs text-muted">
                  Retainage
                  <input
                    className="field w-16 text-right"
                    inputMode="decimal"
                    value={retainagePercent}
                    onChange={(event) => setRetainagePercent(event.target.value)}
                  />
                  %
                </label>
              </div>

              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-1 font-medium">Item</th>
                    <th className="py-1 text-right font-medium">Billed</th>
                    <th className="py-1 text-right font-medium">% complete now</th>
                  </tr>
                </thead>
                <tbody>
                  {sov.map((item) => (
                    <tr key={item.id} className="border-t border-line">
                      <td className="py-1">{item.description}</td>
                      <td className="tnum py-1 text-right">{formatCents(item.billedCents)}</td>
                      <td className="py-1 text-right">
                        <input
                          className="field w-20 text-right"
                          inputMode="decimal"
                          placeholder="0"
                          value={progress[item.id] ?? ''}
                          onChange={(event) =>
                            setProgress((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="rounded-lg bg-raised p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">This period</span>
                  <span className="tnum">{formatCents(preview.thisPeriod)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Less retainage</span>
                  <span className="tnum">({formatCents(preview.retained)})</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-line pt-1 font-medium">
                  <span>Net due this application</span>
                  <span className="tnum">{formatCents(preview.net)}</span>
                </div>
              </div>

              <div className="flex gap-2">
                <button className="btn btn-primary text-xs" onClick={issue} disabled={pending}>
                  {pending ? 'Issuing…' : 'Issue as invoice'}
                </button>
                <button className="btn text-xs" onClick={() => setMode('none')}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {mode === 'release' && (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Bills the full {formatCents(retainageHeldCents)} held. The invoice credits
                Retainage Receivable and debits AR — no revenue is recognized, because it already
                was when the work was billed.
              </p>
              <div className="flex flex-wrap gap-2">
                <select
                  className="field flex-1"
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  <option value="">Choose a {terms.customer.toLowerCase()}…</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
                <input
                  className="field w-40"
                  type="date"
                  value={billingDate}
                  onChange={(event) => setBillingDate(event.target.value)}
                />
                <button className="btn btn-primary text-xs" onClick={release} disabled={pending}>
                  {pending ? 'Billing…' : 'Bill retainage'}
                </button>
                <button className="btn text-xs" onClick={() => setMode('none')}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <Notice message={message} />
        </div>
      </Panel>
    </div>
  )
}
