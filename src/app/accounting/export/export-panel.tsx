'use client'

import { useState, useTransition } from 'react'
import {
  exportAccountantPackageAction,
  exportReadinessAction,
  setTaxProfileAction,
} from '@/app/actions/exporting'

/**
 * The accountant's export screen (Exporter spec §9).
 *
 * Two buttons and they are deliberately separate. §9's workflow checks the books
 * *before* generating anything — *"Accountrix checks that the books balance.
 * Accountrix checks for unmapped accounts and missing tax codes. The accountant
 * resolves any exceptions"* — and a screen whose only action is "export" turns
 * that into a failed download.
 */

type Destination = { key: string; product: string; vendor: string; use: string }

type Refused = { key: string; product: string; why: string }

export function ExportPanel({
  destinations,
  planned,
  classifications,
  classification,
  defaultStart,
  defaultEnd,
}: {
  destinations: Destination[]
  planned: Refused[]
  classifications: Array<{ key: string; label: string; filesAs: string }>
  classification: string | null
  defaultStart: string
  defaultEnd: string
}) {
  const [destinationKey, setDestinationKey] = useState(destinations[0]?.key ?? '')
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [status, setStatus] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const request = { destinationKey, startDate, endDate }

  function check() {
    start(async () => {
      setError(null)
      const result = await exportReadinessAction(request)
      if (!result.ok) {
        setError(result.error)
        setStatus(null)
        setReport(null)
        return
      }
      setStatus(result.status)
      setReport(result.report)
    })
  }

  function run() {
    start(async () => {
      setError(null)
      const result = await exportAccountantPackageAction(request)
      if (!result.ok) {
        // The exception report is the error. §11 holds the export and the
        // sentences explaining why are what the person needs to act on.
        setError(result.error)
        setStatus('red')
        setReport(null)
        return
      }

      setStatus(result.status)
      setReport(result.report)

      // One file at a time, because there is no archive writer here — see the
      // note on the server action.
      for (const file of result.files) {
        const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain' }))
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        link.click()
        URL.revokeObjectURL(url)
      }
    })
  }

  function saveClassification(value: string) {
    start(async () => {
      const result = await setTaxProfileAction({ classification: value || null })
      setSaved(result.ok ? (result.message ?? 'Saved.') : result.error)
    })
  }

  const tone =
    status === 'green'
      ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
      : status === 'yellow'
        ? 'bg-amber-50 text-amber-900 border-amber-200'
        : 'bg-rose-50 text-rose-900 border-rose-200'

  return (
    <div className="space-y-6">
      <section className="rounded border bg-white p-4">
        <h2 className="text-sm font-semibold">Which return do these books feed?</h2>
        <p className="mt-1 text-xs text-slate-600">
          The entity type decides which return the figures belong to and the fiscal year decides
          which year they land in. Neither can be worked out from the ledger, so an export is held
          until this is recorded.
        </p>
        <select
          className="mt-2 rounded border px-2 py-1 text-sm"
          value={classification ?? ''}
          onChange={(event) => saveClassification(event.target.value)}
          disabled={pending}
        >
          <option value="">Not recorded</option>
          {classifications.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label} — {option.filesAs}
            </option>
          ))}
        </select>
        {saved && <p className="mt-2 text-xs text-slate-600">{saved}</p>}
      </section>

      <section className="rounded border bg-white p-4">
        <h2 className="text-sm font-semibold">Export to professional software</h2>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="block text-slate-600">Destination</span>
            <select
              className="mt-1 rounded border px-2 py-1 text-sm"
              value={destinationKey}
              onChange={(event) => setDestinationKey(event.target.value)}
            >
              {destinations.map((destination) => (
                <option key={destination.key} value={destination.key}>
                  {destination.product}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs">
            <span className="block text-slate-600">From</span>
            <input
              type="date"
              className="mt-1 rounded border px-2 py-1 text-sm"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>

          <label className="text-xs">
            <span className="block text-slate-600">To</span>
            <input
              type="date"
              className="mt-1 rounded border px-2 py-1 text-sm"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>

          <button
            type="button"
            onClick={check}
            disabled={pending || !destinationKey}
            className="rounded border px-3 py-1.5 text-sm"
          >
            Check the books
          </button>

          <button
            type="button"
            onClick={run}
            disabled={pending || !destinationKey}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Export
          </button>
        </div>

        {status && (
          <div className={`mt-4 rounded border p-3 text-xs ${tone}`}>
            <p className="font-semibold uppercase">{status}</p>
            {report && <pre className="mt-2 whitespace-pre-wrap font-sans">{report}</pre>}
            {error && <pre className="mt-2 whitespace-pre-wrap font-sans">{error}</pre>}
          </div>
        )}

        {error && !status && (
          <p className="mt-4 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            {error}
          </p>
        )}
      </section>

      <section className="rounded border bg-white p-4">
        <h2 className="text-sm font-semibold">Not yet available</h2>
        <p className="mt-1 text-xs text-slate-600">
          These are the professional systems the exporter is being built for. Each one waits on a
          worked-out integration path — professional tax and workpaper products import through
          vendor files, desktop bridges and partner programmes as often as through an API, and
          guessing at a format produces a file that is rejected without saying why.
        </p>
        <ul className="mt-3 grid gap-1 text-xs text-slate-700 sm:grid-cols-2">
          {planned.map((destination) => (
            <li key={destination.key}>
              {destination.product} <span className="text-slate-500">— waiting on research</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
