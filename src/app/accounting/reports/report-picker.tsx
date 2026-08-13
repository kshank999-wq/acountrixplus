'use client'

import { useRouter, useSearchParams } from 'next/navigation'

const REPORTS = [
  { key: 'trial_balance', label: 'Trial balance', financial: false },
  { key: 'profit_loss', label: 'Profit & loss', financial: true },
  { key: 'balance_sheet', label: 'Balance sheet', financial: true },
  { key: 'ar_aging', label: 'A/R aging', financial: false },
  { key: 'ap_aging', label: 'A/P aging', financial: false },
]

/** Report selector and date range. Balance-sheet style reports use only the end date. */
export function ReportPicker({
  report,
  start,
  end,
  canSeeStatements,
}: {
  report: string
  start: string
  end: string
  canSeeStatements: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    router.push(`/accounting/reports?${next.toString()}`)
  }

  const available = REPORTS.filter((item) => canSeeStatements || !item.financial)
  const asOfOnly = report === 'balance_sheet' || report.endsWith('_aging')

  return (
    <div className="card p-3">
      <div className="flex gap-1 overflow-x-auto">
        {available.map((item) => (
          <button
            key={item.key}
            onClick={() => setParam('report', item.key)}
            className={`chip whitespace-nowrap px-3 py-1.5 ${
              report === item.key
                ? 'bg-brand text-brand-ink'
                : 'bg-raised text-muted hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {!asOfOnly && (
          <label className="text-xs text-muted">
            <span className="mb-1 block">From</span>
            <input
              type="date"
              value={start}
              onChange={(event) => setParam('start', event.target.value)}
              className="field py-1.5 text-sm"
            />
          </label>
        )}
        <label className="text-xs text-muted">
          <span className="mb-1 block">{asOfOnly ? 'As of' : 'To'}</span>
          <input
            type="date"
            value={end}
            onChange={(event) => setParam('end', event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>

        {!canSeeStatements && (
          <p className="text-xs text-faint">
            Financial statements need the <code>reports:financial</code> permission.
          </p>
        )}
      </div>
    </div>
  )
}
