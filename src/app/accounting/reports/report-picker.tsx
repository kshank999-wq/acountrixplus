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
  basis,
  canSeeStatements,
}: {
  report: string
  start: string
  end: string
  basis: string
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

  // Only the statements have a basis. A trial balance is a statement about the
  // journal, and the journal is kept on one basis — offering a switch there
  // would imply a choice that does not exist.
  const hasBasis = report === 'profit_loss' || report === 'balance_sheet'

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

        {hasBasis && (
          <div className="text-xs text-muted">
            <span className="mb-1 block">Basis</span>
            <div className="flex gap-1">
              {(['accrual', 'cash'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setParam('basis', option)}
                  title={
                    option === 'accrual'
                      ? 'Revenue when earned and expenses when incurred, whether or not money has moved.'
                      : 'Revenue when the money arrives and expenses when it leaves.'
                  }
                  className={`chip px-3 py-1.5 ${
                    basis === option
                      ? 'bg-brand text-brand-ink'
                      : 'bg-raised text-muted hover:text-ink'
                  }`}
                >
                  {option === 'accrual' ? 'Accrual' : 'Cash'}
                </button>
              ))}
            </div>
          </div>
        )}

        {!canSeeStatements && (
          <p className="text-xs text-faint">
            Financial statements need the <code>reports:financial</code> permission.
          </p>
        )}
      </div>

      {hasBasis && basis === 'cash' && (
        <p className="mt-2 text-xs text-warning">
          Cash basis: revenue when the money arrives, expenses when it leaves. Receivables and
          payables do not appear at all — that is what cash basis means, not a figure gone missing.
        </p>
      )}
    </div>
  )
}
