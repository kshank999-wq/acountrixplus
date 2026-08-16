'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createDimensionAction,
  createDimensionValueAction,
  reclassifyAction,
  retireDimensionValueAction,
  updateDimensionAction,
  type ActionResult,
} from '@/app/actions/dimensions'
import { REQUIREMENT_LABELS } from '@/modules/dimensions/vocabulary'
import { formatCents } from '@/lib/money'

type Dimension = {
  id: string
  name: string
  code: string
  description: string | null
  requirement: 'optional' | 'expected'
  isActive: boolean
}

type Value = {
  id: string
  dimensionId: string
  code: string
  name: string
  isActive: boolean
}

type Row = {
  chartAccountId: string
  number: string
  name: string
  amountsCents: number[]
  totalCents: number
}

type Report = {
  dimension: { id: string; name: string; code: string }
  columns: Array<{ valueId: string | null; code: string; name: string }>
  revenue: Row[]
  costOfSales: Row[]
  operatingExpenses: Row[]
  otherIncome: Row[]
  otherExpenses: Row[]
  netIncomeCents: number[]
  netIncomeTotalCents: number
  totalsAgree: boolean
  coverage: {
    assignedCents: number
    unassignedCents: number
    basisPointsAssigned: number | null
  }
}

type UnassignedLine = {
  journalLineId: string
  entryNumber: number
  entryDate: string
  accountLabel: string
  memo: string | null
  amountCents: number
}

/**
 * Dimensions, the report they produce, and the work list for catching up.
 *
 * The coverage figure leads, because a dimensional report read without it is a
 * report about whatever fraction of the business happened to be tagged.
 */
export function DimensionBoard({
  dimensions,
  values,
  selectedId,
  startDate,
  endDate,
  report,
  unassigned,
  canManage,
}: {
  dimensions: Dimension[]
  values: Value[]
  selectedId: string | null
  startDate: string
  endDate: string
  report: Report | null
  unassigned: UnassignedLine[]
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set())
  const [assignTo, setAssignTo] = useState('')
  const [showSetup, setShowSetup] = useState(dimensions.length === 0)

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) {
        setSelectedLines(new Set())
        router.refresh()
      }
    })
  }

  const active = dimensions.filter((dimension) => dimension.isActive)
  const selected = active.find((dimension) => dimension.id === selectedId) ?? null
  const selectedValues = values.filter(
    (value) => value.dimensionId === selectedId && value.isActive,
  )

  function toggle(id: string) {
    setSelectedLines((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function go(next: Record<string, string>) {
    const params = new URLSearchParams({ d: selectedId ?? '', from: startDate, to: endDate, ...next })
    router.push(`/accounting/dimensions?${params.toString()}`)
  }

  const coveragePercent =
    report?.coverage.basisPointsAssigned === null || report === null
      ? null
      : Math.round(report.coverage.basisPointsAssigned / 100)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Dimensions</h2>
        <p className="text-sm text-muted">
          Slice the books by location, department, class, or fund.{' '}
          <span className="text-faint">
            The columns always add up to the ordinary profit and loss — what carries no value is a
            column called Unassigned, not an omission.
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

      {active.length > 0 && (
        <div className="card flex flex-wrap items-end gap-3 px-4 py-3">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Dimension</span>
            <select
              value={selectedId ?? ''}
              onChange={(event) => go({ d: event.target.value })}
              className="field py-1.5 text-sm"
            >
              {active.map((dimension) => (
                <option key={dimension.id} value={dimension.id}>
                  {dimension.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">From</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => go({ from: event.target.value })}
              className="field py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">To</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => go({ to: event.target.value })}
              className="field py-1.5 text-sm"
            />
          </label>
          {coveragePercent !== null && (
            <p className="ml-auto text-sm">
              <span
                className={`tnum text-xl font-semibold ${
                  coveragePercent < 90 ? 'text-warning' : 'text-success'
                }`}
              >
                {coveragePercent}%
              </span>{' '}
              <span className="text-muted">of activity carries a {selected?.name}</span>
            </p>
          )}
        </div>
      )}

      {report && !report.totalsAgree && (
        <div className="card border-danger px-4 py-3 text-sm text-danger">
          The columns do not sum to the account totals. A line is carrying two values for one
          dimension, which the database is meant to prevent — this report cannot be trusted.
        </div>
      )}

      {report && report.columns.length > 0 && (
        <Card
          title={`Profit and loss by ${report.dimension.name}`}
          subtitle="Accrual basis. Cash basis restates entries through payment applications, and a restated figure has no single line to take a dimension from."
        >
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Account</th>
                {report.columns.map((column) => (
                  <th
                    key={column.valueId ?? 'none'}
                    className={`px-4 py-2 text-right font-medium ${
                      column.valueId === null ? 'text-warning' : ''
                    }`}
                  >
                    {column.name}
                  </th>
                ))}
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              <Group title="Revenue" rows={report.revenue} columns={report.columns.length} />
              <Group title="Cost of sales" rows={report.costOfSales} columns={report.columns.length} />
              <Group
                title="Operating expenses"
                rows={report.operatingExpenses}
                columns={report.columns.length}
              />
              <Group title="Other income" rows={report.otherIncome} columns={report.columns.length} />
              <Group
                title="Other expense"
                rows={report.otherExpenses}
                columns={report.columns.length}
              />
              <tr className="border-t-2 border-line font-semibold">
                <td className="px-4 py-2">Net income</td>
                {report.netIncomeCents.map((amount, i) => (
                  <td key={i} className="tnum px-4 py-2 text-right">
                    {formatCents(amount)}
                  </td>
                ))}
                <td className="tnum px-4 py-2 text-right">
                  {formatCents(report.netIncomeTotalCents)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="border-t border-line px-4 py-2 text-xs text-faint">
            There is no balance sheet by {report.dimension.name.toLowerCase()}. Assets can be
            tagged; equity cannot — a site has no share capital of its own — so one would have to be
            balanced with a figure the business never transacted.
          </p>
        </Card>
      )}

      {selected && unassigned.length > 0 && (
        <Card
          title={`Not yet given a ${selected.name}`}
          subtitle="Reclassifying moves no money. The trial balance is identical before and after, which is why it is allowed inside a closed period."
        >
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium" />
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Entry</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Memo</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {unassigned.map((line) => (
                <tr key={line.journalLineId} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    {canManage && (
                      <input
                        type="checkbox"
                        checked={selectedLines.has(line.journalLineId)}
                        onChange={() => toggle(line.journalLineId)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{line.entryDate}</td>
                  <td className="px-4 py-1.5 text-muted">#{line.entryNumber}</td>
                  <td className="px-4 py-1.5">{line.accountLabel}</td>
                  <td className="px-4 py-1.5 text-muted">{line.memo ?? '—'}</td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(line.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {canManage && selectedLines.size > 0 && selectedValues.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
              <span className="text-sm">
                {selectedLines.size} {selectedLines.size === 1 ? 'line' : 'lines'} →
              </span>
              <select
                value={assignTo}
                onChange={(event) => setAssignTo(event.target.value)}
                className="field py-1.5 text-sm"
              >
                <option value="">Choose a {selected.name.toLowerCase()}</option>
                {selectedValues.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary"
                disabled={pending || !assignTo}
                onClick={() =>
                  act(() =>
                    reclassifyAction({
                      journalLineIds: [...selectedLines],
                      dimensionId: selected.id,
                      dimensionValueId: assignTo,
                    }),
                  )
                }
              >
                Assign
              </button>
            </div>
          )}
        </Card>
      )}

      {canManage && (
        <Card title="Set up" subtitle="A dimension is a way of slicing the books that is not an account and not a job.">
          <button
            className="btn btn-ghost m-4 text-xs"
            onClick={() => setShowSetup((open) => !open)}
          >
            {showSetup ? 'Hide' : 'Show'}
          </button>

          {showSetup && (
            <div className="space-y-4 border-t border-line px-4 py-3">
              <NewDimension act={act} pending={pending} />

              {dimensions.map((dimension) => (
                <div key={dimension.id} className="rounded border border-line p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">
                      {dimension.name}{' '}
                      <span className="text-faint">{dimension.code}</span>
                      {!dimension.isActive && (
                        <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">
                          retired
                        </span>
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <select
                        value={dimension.requirement}
                        disabled={pending || !dimension.isActive}
                        onChange={(event) =>
                          act(() =>
                            updateDimensionAction(dimension.id, {
                              requirement: event.target.value,
                            }),
                          )
                        }
                        className="field py-1 text-xs"
                      >
                        {Object.entries(REQUIREMENT_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {dimension.isActive && (
                        <button
                          className="btn btn-ghost text-xs text-danger"
                          disabled={pending}
                          onClick={() =>
                            act(() => updateDimensionAction(dimension.id, { isActive: false }))
                          }
                        >
                          Retire
                        </button>
                      )}
                    </div>
                  </div>

                  <ul className="mt-2 flex flex-wrap gap-2">
                    {values
                      .filter((value) => value.dimensionId === dimension.id)
                      .map((value) => (
                        <li
                          key={value.id}
                          className={`flex items-center gap-1 rounded bg-raised px-2 py-1 text-xs ${
                            value.isActive ? '' : 'text-faint line-through'
                          }`}
                        >
                          {value.name}
                          {value.isActive && (
                            <button
                              className="text-muted hover:text-danger"
                              disabled={pending}
                              aria-label={`Retire ${value.name}`}
                              onClick={() => act(() => retireDimensionValueAction(value.id))}
                            >
                              ×
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>

                  {dimension.isActive && (
                    <NewValue dimensionId={dimension.id} act={act} pending={pending} />
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function Group({ title, rows, columns }: { title: string; rows: Row[]; columns: number }) {
  if (rows.length === 0) return null

  const totals = Array.from({ length: columns }, (_, i) =>
    rows.reduce((sum, row) => sum + row.amountsCents[i], 0),
  )

  return (
    <>
      <tr className="bg-raised/40">
        <td className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted" colSpan={columns + 2}>
          {title}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.chartAccountId} className="border-t border-line">
          <td className="px-4 py-1.5">
            <span className="text-faint">{row.number}</span> {row.name}
          </td>
          {row.amountsCents.map((amount, i) => (
            <td key={i} className="tnum px-4 py-1.5 text-right">
              {formatCents(amount)}
            </td>
          ))}
          <td className="tnum px-4 py-1.5 text-right font-medium">{formatCents(row.totalCents)}</td>
        </tr>
      ))}
      <tr className="border-t border-line text-muted">
        <td className="px-4 py-1.5 text-xs">Total {title.toLowerCase()}</td>
        {totals.map((amount, i) => (
          <td key={i} className="tnum px-4 py-1.5 text-right text-xs">
            {formatCents(amount)}
          </td>
        ))}
        <td className="tnum px-4 py-1.5 text-right text-xs">
          {formatCents(totals.reduce((sum, amount) => sum + amount, 0))}
        </td>
      </tr>
    </>
  )
}

function NewDimension({
  act,
  pending,
}: {
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-muted">
        <span className="mb-1 block">New dimension</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Location"
          className="field py-1.5 text-sm"
        />
      </label>
      <label className="text-xs text-muted">
        <span className="mb-1 block">Code</span>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="LOC"
          className="field w-24 py-1.5 text-sm"
        />
      </label>
      <button
        className="btn btn-ghost text-xs"
        disabled={pending || !name.trim() || !code.trim()}
        onClick={() => {
          act(() => createDimensionAction({ name, code }))
          setName('')
          setCode('')
        }}
      >
        Add
      </button>
    </div>
  )
}

function NewValue({
  dimensionId,
  act,
  pending,
}: {
  dimensionId: string
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Downtown"
        className="field w-40 py-1 text-xs"
      />
      <input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="DT"
        className="field w-20 py-1 text-xs"
      />
      <button
        className="btn btn-ghost text-xs"
        disabled={pending || !name.trim() || !code.trim()}
        onClick={() => {
          act(() => createDimensionValueAction({ dimensionId, name, code }))
          setName('')
          setCode('')
        }}
      >
        Add value
      </button>
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
