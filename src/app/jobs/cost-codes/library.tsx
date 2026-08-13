'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createCostCodeAction,
  installCostCodesAction,
  setCostCodeActiveAction,
} from '@/app/actions/jobs'
import { COST_TYPE_LABELS, type CostType } from '@/modules/jobs/vocabulary'

type Code = {
  id: string
  code: string
  name: string
  division: string | null
  costType: string
  isActive: boolean
}

/**
 * The cost code library.
 *
 * A retired code stays visible rather than disappearing: historic job costs
 * still reference it, and a report whose row labels vanish when somebody
 * tidies the library is worse than a slightly longer list.
 */
export function CostCodeLibrary({
  codes,
  accounts,
  canManage,
}: {
  codes: Code[]
  accounts: Array<{ id: string; number: string; name: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [open, setOpen] = useState(false)

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [division, setDivision] = useState('')
  const [costType, setCostType] = useState<CostType>('other')
  const [accountId, setAccountId] = useState('')

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) router.refresh()
    })
  }

  const active = codes.filter((entry) => entry.isActive)
  const retired = codes.filter((entry) => !entry.isActive)

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Cost codes</h2>
            <p className="text-xs text-muted">
              A cost code says which part of the work money went to. The account still says what
              kind of expense it was — the two are separate on purpose, so the chart of accounts
              stays comparable with every other company on the platform.
            </p>
          </div>
          {canManage && (
            <div className="flex gap-2">
              {codes.length === 0 && (
                <button
                  className="btn text-xs"
                  disabled={pending}
                  onClick={() => act(() => installCostCodesAction())}
                >
                  Load the starter library
                </button>
              )}
              <button className="btn text-xs" onClick={() => setOpen((value) => !value)}>
                {open ? 'Cancel' : 'Add a cost code'}
              </button>
            </div>
          )}
        </header>

        {open && canManage && (
          <div className="space-y-2 border-b border-line p-4">
            <div className="flex flex-wrap gap-2">
              <input
                className="field w-32"
                placeholder="06-100"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <input
                className="field flex-1"
                placeholder="Rough carpentry"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <input
                className="field w-44"
                placeholder="Division (optional)"
                value={division}
                onChange={(event) => setDivision(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                className="field w-44"
                value={costType}
                onChange={(event) => setCostType(event.target.value as CostType)}
              >
                {Object.entries(COST_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className="field flex-1"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">Usual account (optional)…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.number} — {account.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary text-xs"
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    const result = await createCostCodeAction({
                      code,
                      name,
                      division: division || undefined,
                      costType,
                      defaultChartAccountId: accountId || null,
                    })
                    if (result.ok) {
                      setCode('')
                      setName('')
                      setDivision('')
                      setOpen(false)
                    }
                    return result
                  })
                }
              >
                {pending ? 'Saving…' : 'Add'}
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Division</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {codes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                    No cost codes yet. The starter library is a dozen common ones — your own will
                    replace them soon enough.
                  </td>
                </tr>
              )}
              {[...active, ...retired].map((entry) => (
                <tr
                  key={entry.id}
                  className={`border-t border-line ${entry.isActive ? '' : 'opacity-50'}`}
                >
                  <td className="px-4 py-1.5 font-medium">{entry.code}</td>
                  <td className="px-4 py-1.5">{entry.name}</td>
                  <td className="px-4 py-1.5 text-muted">{entry.division ?? ''}</td>
                  <td className="px-4 py-1.5 text-muted">
                    {COST_TYPE_LABELS[entry.costType as CostType] ?? entry.costType}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {canManage && (
                      <button
                        className="btn px-2 py-1 text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() => setCostCodeActiveAction(entry.id, !entry.isActive))
                        }
                      >
                        {entry.isActive ? 'Retire' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {message && (
          <p
            className={`border-t border-line px-4 py-2 text-xs ${
              message.ok ? 'text-positive' : 'text-negative'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>
    </div>
  )
}
