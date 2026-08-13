'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { closePeriodAction, reopenPeriodAction } from '@/app/actions/accounting'

type Period = {
  id: string
  periodStart: string
  periodEnd: string
  status: 'closed' | 'reopened'
  closedAt: Date | null
}

/**
 * Period close controls (spec §13, §14).
 *
 * Closing blocks any entry dated inside the range, including changes to bank
 * transactions that would post there. Reopening is recorded rather than
 * erasing the close.
 */
export function PeriodControls({ periods }: { periods: Period[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
        ok: result.ok,
      })
      if (result.ok) router.refresh()
    })
  }

  const closed = periods.filter((period) => period.status === 'closed')

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Period close</h2>
      <p className="mt-0.5 text-xs text-muted">
        A closed period rejects new entries, edits, and voids dated inside it — including
        recategorizing a bank transaction that would post there.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          <span className="mb-1 block">From</span>
          <input
            type="date"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          <span className="mb-1 block">To</span>
          <input
            type="date"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>
        <button
          onClick={() => act(() => closePeriodAction(start, end))}
          disabled={!start || !end || pending}
          className="btn text-xs"
        >
          Close period
        </button>
      </div>

      {closed.length > 0 && (
        <ul className="mt-3 space-y-1">
          {closed.map((period) => (
            <li
              key={period.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-1.5 text-xs"
            >
              <span className="tnum">
                {period.periodStart} → {period.periodEnd}
              </span>
              <button
                onClick={() => act(() => reopenPeriodAction(period.id))}
                disabled={pending}
                className="btn px-2 py-0.5 text-xs"
              >
                Reopen
              </button>
            </li>
          ))}
        </ul>
      )}

      {message && (
        <p
          role="status"
          className={`mt-2 text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}
