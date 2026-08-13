'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import { postEntryAction } from '@/app/actions/accounting'

type Line = { chartAccountId: string; debit: string; credit: string; memo: string }

const BLANK: Line = { chartAccountId: '', debit: '', credit: '', memo: '' }

/** Parses a typed amount to cents for the running total. Invalid input reads as zero. */
function toCents(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, '').trim()
  if (!cleaned) return 0
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
}

/**
 * Manual journal entry form (spec §13).
 *
 * The running debit and credit totals sit under the lines and submission stays
 * disabled until they agree, so the balance rule is visible while typing
 * instead of arriving as an error afterwards.
 */
export function JournalForm({
  accounts,
}: {
  accounts: Array<{ id: string; number: string; name: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10))
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState<Line[]>([{ ...BLANK }, { ...BLANK }])
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const debitTotal = lines.reduce((sum, line) => sum + toCents(line.debit), 0)
  const creditTotal = lines.reduce((sum, line) => sum + toCents(line.credit), 0)
  const difference = debitTotal - creditTotal
  const usable = lines.filter(
    (line) => line.chartAccountId && (toCents(line.debit) !== 0 || toCents(line.credit) !== 0),
  )
  const canSubmit = difference === 0 && debitTotal > 0 && usable.length >= 2

  function update(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  function submit() {
    startTransition(async () => {
      const result = await postEntryAction({ entryDate, memo, lines: usable })
      setMessage({
        text: result.ok ? (result.message ?? 'Posted.') : result.error,
        ok: result.ok,
      })
      if (result.ok) {
        setLines([{ ...BLANK }, { ...BLANK }])
        setMemo('')
        router.refresh()
      }
    })
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-primary text-xs">
        New journal entry
      </button>
    )
  }

  return (
    <section className="card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">New journal entry</h2>
        <button onClick={() => setOpen(false)} className="btn px-2 py-1 text-xs">
          Close
        </button>
      </header>

      <div className="mb-3 flex flex-wrap gap-2">
        <label className="text-xs text-muted">
          <span className="mb-1 block">Date</span>
          <input
            type="date"
            value={entryDate}
            onChange={(event) => setEntryDate(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>
        <label className="flex-1 text-xs text-muted">
          <span className="mb-1 block">Memo</span>
          <input
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            placeholder="What is this entry for?"
            className="field py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="pb-1 font-medium">Account</th>
              <th className="pb-1 text-right font-medium">Debit</th>
              <th className="pb-1 text-right font-medium">Credit</th>
              <th className="pb-1 font-medium">Memo</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="py-1 pr-2">
                  <select
                    value={line.chartAccountId}
                    onChange={(event) => update(index, { chartAccountId: event.target.value })}
                    className="field py-1.5 text-xs"
                    aria-label={`Line ${index + 1} account`}
                  >
                    <option value="">Choose an account…</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.number} · {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={line.debit}
                    // A line is one side or the other, so typing here clears the other.
                    onChange={(event) => update(index, { debit: event.target.value, credit: '' })}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="field w-28 py-1.5 text-right text-xs"
                    aria-label={`Line ${index + 1} debit`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={line.credit}
                    onChange={(event) => update(index, { credit: event.target.value, debit: '' })}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="field w-28 py-1.5 text-right text-xs"
                    aria-label={`Line ${index + 1} credit`}
                  />
                </td>
                <td className="py-1">
                  <input
                    value={line.memo}
                    onChange={(event) => update(index, { memo: event.target.value })}
                    className="field py-1.5 text-xs"
                    aria-label={`Line ${index + 1} memo`}
                  />
                </td>
              </tr>
            ))}
            <tr className="border-t border-line font-medium">
              <td className="py-2">Totals</td>
              <td className="tnum py-2 pr-2 text-right">{formatCents(debitTotal)}</td>
              <td className="tnum py-2 pr-2 text-right">{formatCents(creditTotal)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setLines((current) => [...current, { ...BLANK }])}
          className="btn px-2 py-1 text-xs"
        >
          Add line
        </button>

        <span className={`tnum text-xs ${difference === 0 ? 'text-positive' : 'text-warning'}`}>
          {difference === 0
            ? debitTotal > 0
              ? 'Balanced'
              : 'Enter amounts'
            : `Out of balance by ${formatCents(Math.abs(difference))}`}
        </span>

        <button
          onClick={submit}
          disabled={!canSubmit || pending}
          className="btn btn-primary ml-auto px-3 py-1 text-xs"
        >
          {pending ? 'Posting…' : 'Post entry'}
        </button>
      </div>

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
