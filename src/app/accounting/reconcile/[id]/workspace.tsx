'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  completeReconciliationAction,
  reopenReconciliationAction,
  setClearedAction,
} from '@/app/actions/accounting'

type Summary = {
  id: string
  statementStartDate: string
  statementEndDate: string
  statementEndingBalanceCents: number
  beginningBalanceCents: number
  clearedBalanceCents: number
  clearedCount: number
  unclearedCount: number
  differenceCents: number
  isBalanced: boolean
  status: 'in_progress' | 'completed' | 'reopened'
}

type Row = {
  id: string
  postedDate: string
  description: string
  merchantName: string | null
  amountCents: number
  cleared: boolean
}

/**
 * The reconciliation workspace (spec §4).
 *
 * Clearing a transaction updates the difference immediately — the figure is
 * recomputed from local state on every toggle rather than waiting for the
 * server round trip, so ticking through a statement stays responsive.
 */
export function ReconcileWorkspace({
  summary,
  accountName,
  transactions,
  canPerform,
  canReopen,
}: {
  summary: Summary
  accountName: string
  transactions: Row[]
  canPerform: boolean
  canReopen: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState(transactions)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const locked = summary.status === 'completed'
  const editable = canPerform && !locked

  // Recomputed locally so the difference tracks each tick without a round trip.
  const live = useMemo(() => {
    const clearedTotal = rows
      .filter((row) => row.cleared)
      .reduce((sum, row) => sum + row.amountCents, 0)
    const clearedBalanceCents = summary.beginningBalanceCents + clearedTotal

    return {
      clearedBalanceCents,
      clearedCount: rows.filter((row) => row.cleared).length,
      differenceCents: summary.statementEndingBalanceCents - clearedBalanceCents,
    }
  }, [rows, summary.beginningBalanceCents, summary.statementEndingBalanceCents])

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setMessage({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    setTimeout(() => setMessage(null), 6000)
  }

  function toggle(row: Row) {
    if (!editable) return
    const next = !row.cleared

    // Optimistic: flip locally, then persist.
    setRows((current) => current.map((r) => (r.id === row.id ? { ...r, cleared: next } : r)))

    startTransition(async () => {
      const result = await setClearedAction(summary.id, [row.id], next)
      if (!result.ok) {
        // Roll back the optimistic flip.
        setRows((current) => current.map((r) => (r.id === row.id ? { ...r, cleared: !next } : r)))
        notify(result)
      }
    })
  }

  function complete() {
    startTransition(async () => {
      const result = await completeReconciliationAction(summary.id)
      notify(result)
      if (result.ok) router.refresh()
    })
  }

  function reopen() {
    startTransition(async () => {
      const result = await reopenReconciliationAction(summary.id)
      notify(result)
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{accountName}</h2>
            <p className="tnum text-xs text-muted">
              Statement {summary.statementStartDate} → {summary.statementEndDate}
            </p>
          </div>

          {locked && (
            <span className="chip bg-positive/15 text-positive">Completed and locked</span>
          )}
          {summary.status === 'reopened' && (
            <span className="chip bg-warning/15 text-warning">Reopened</span>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Opening balance" cents={summary.beginningBalanceCents} />
          <Figure label="Statement ending" cents={summary.statementEndingBalanceCents} />
          <Figure label="Cleared balance" cents={live.clearedBalanceCents} />
          <Figure
            label="Difference"
            cents={live.differenceCents}
            tone={live.differenceCents === 0 ? 'good' : 'warn'}
          />
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted">
            {live.clearedCount} cleared · {rows.length - live.clearedCount} remaining
          </p>

          {editable && (
            <button
              onClick={complete}
              disabled={live.differenceCents !== 0 || pending}
              className="btn btn-primary ml-auto text-xs"
              title={
                live.differenceCents !== 0
                  ? 'The difference must be zero before completing.'
                  : undefined
              }
            >
              Complete reconciliation
            </button>
          )}

          {locked && canReopen && (
            <button onClick={reopen} disabled={pending} className="btn ml-auto text-xs">
              Reopen
            </button>
          )}
          {locked && !canReopen && (
            <p className="ml-auto text-xs text-faint">
              Only an accountant or owner can reopen this.
            </p>
          )}
        </div>

        {live.differenceCents !== 0 && editable && (
          <p className="mt-2 text-xs text-warning">
            Tick every transaction that appears on the statement. The difference must reach zero
            before this can be completed.
          </p>
        )}
      </section>

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Transactions through {summary.statementEndDate}</h2>
        </header>

        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No transactions in this statement period.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id}>
                <label
                  className={`flex items-center gap-3 px-4 py-2.5 ${
                    editable ? 'cursor-pointer hover:bg-raised/40' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={row.cleared}
                    onChange={() => toggle(row)}
                    disabled={!editable}
                    className="h-5 w-5 rounded border-line"
                    aria-label={`Clear ${row.description}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {row.merchantName ?? row.description}
                    </p>
                    <p className="tnum truncate text-xs text-faint">{row.postedDate}</p>
                  </div>
                  <span
                    className={`tnum shrink-0 text-sm font-medium ${
                      row.amountCents >= 0 ? 'text-positive' : ''
                    }`}
                  >
                    {formatCents(row.amountCents)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {message && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg ${
            message.ok
              ? 'border-positive/40 bg-surface text-positive'
              : 'border-negative/40 bg-surface text-negative'
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  )
}

function Figure({
  label,
  cents,
  tone,
}: {
  label: string
  cents: number
  tone?: 'good' | 'warn'
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`tnum mt-0.5 text-lg font-semibold ${
          tone === 'good' ? 'text-positive' : tone === 'warn' ? 'text-warning' : ''
        }`}
      >
        {formatCents(cents)}
      </dd>
    </div>
  )
}
