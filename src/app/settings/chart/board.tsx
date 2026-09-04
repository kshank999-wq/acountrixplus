'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addChartAccountAction,
  setChartAccountRetiredAction,
  type ActionResult,
} from '@/app/actions/chart'
import { NUMBER_RANGES, labelFor } from '@/modules/coa/proposal'
import { formatCents } from '@/lib/money'

type Account = {
  id: string
  number: string
  name: string
  type: string
  isSystem: boolean
  isActive: boolean
  /** How many journal lines have ever posted here. */
  postings: number
  balanceCents: number
}

/**
 * The chart of accounts (spec §5, Phase 118).
 *
 * There was no screen for this at all. The chart was read as a dropdown in
 * nine places and managed in none, so a business could not see the accounts its
 * own reports are built from, let alone add one — while `createAccount` sat in
 * the service layer with no caller for 117 phases.
 *
 * Grouped by type in number order, which is how an accountant reads a chart and
 * how every other system prints it.
 */
export function ChartBoard({
  accounts,
  currency,
  canManage,
}: {
  accounts: Account[]
  currency: string
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showRetired, setShowRetired] = useState(false)

  const [number, setNumber] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<string>('expense')

  const range = NUMBER_RANGES.find((row) => row.type === type)

  const groups = useMemo(() => {
    const visible = accounts.filter((row) => showRetired || row.isActive)
    return NUMBER_RANGES.map((band) => ({
      band,
      rows: visible
        .filter((row) => row.type === band.type)
        .sort((a, b) => a.number.localeCompare(b.number)),
    })).filter((group) => group.rows.length > 0)
  }, [accounts, showRetired])

  const retiredCount = accounts.filter((row) => !row.isActive).length

  function act(fn: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await fn()
      setNotice(result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error })
      if (result.ok) {
        onDone?.()
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Chart of accounts</h2>
        <p className="text-sm text-muted">
          Every account the books are kept in, in the order an accountant reads them.{' '}
          <span className="text-faint">
            The ones this application installs and posts into by number are marked, and stay.
          </span>
        </p>
      </header>

      {notice && (
        <p className={`text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}>{notice.text}</p>
      )}

      {canManage && (
        <section className="card px-4 py-4">
          <h3 className="text-sm font-semibold">Add an account</h3>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">What kind</span>
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
                className="field py-1.5 text-sm"
              >
                {NUMBER_RANGES.map((band) => (
                  <option key={band.type} value={band.type}>
                    {labelFor(band.type)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Number</span>
              <input
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                placeholder={range ? String(range.from + 210) : '6210'}
                className="field w-24 py-1.5 text-sm tnum"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Van hire"
                className="field w-56 py-1.5 text-sm"
              />
            </label>
            <button
              className="btn btn-primary text-sm"
              disabled={pending}
              onClick={() =>
                act(() => addChartAccountAction({ number, name, type }), () => {
                  setNumber('')
                  setName('')
                })
              }
            >
              Add it
            </button>
          </div>
          {range && (
            <p className="mt-2 text-xs text-muted">
              <span className="tnum text-ink">
                {range.from}–{range.to}
              </span>{' '}
              — {range.because}
            </p>
          )}
        </section>
      )}

      {retiredCount > 0 && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(event) => setShowRetired(event.target.checked)}
          />
          Show the {retiredCount} retired {retiredCount === 1 ? 'account' : 'accounts'}
        </label>
      )}

      {groups.map(({ band, rows }) => (
        <section key={band.type} className="card px-4 py-4">
          <h3 className="text-sm font-semibold">
            {labelFor(band.type)}{' '}
            <span className="tnum font-normal text-faint">
              {band.from}–{band.to}
            </span>
          </h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1 font-medium">Number</th>
                  <th className="py-1 font-medium">Name</th>
                  <th className="py-1 text-right font-medium">Entries</th>
                  <th className="py-1 text-right font-medium">Balance</th>
                  {canManage && <th className="py-1" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-t border-line/60 ${row.isActive ? '' : 'text-faint'}`}
                  >
                    <td className="tnum py-1.5">{row.number}</td>
                    <td className="py-1.5">
                      {row.name}
                      {row.isSystem && (
                        <span className="ml-2 text-xs text-faint">installed</span>
                      )}
                      {!row.isActive && <span className="ml-2 text-xs">retired</span>}
                    </td>
                    <td className="tnum py-1.5 text-right text-muted">{row.postings}</td>
                    <td className="tnum py-1.5 text-right">
                      {formatCents(row.balanceCents, currency)}
                    </td>
                    {canManage && (
                      <td className="py-1.5 text-right">
                        {row.isSystem ? (
                          <span className="text-xs text-faint">—</span>
                        ) : (
                          <button
                            className="btn btn-ghost text-xs"
                            disabled={pending}
                            onClick={() =>
                              act(() =>
                                setChartAccountRetiredAction({
                                  accountId: row.id,
                                  retired: row.isActive,
                                }),
                              )
                            }
                          >
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
