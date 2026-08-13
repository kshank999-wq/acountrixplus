'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { startReconciliationAction } from '@/app/actions/accounting'

/**
 * Starts a reconciliation session (spec §4).
 *
 * The beginning balance is not asked for: it chains from the previous
 * completed reconciliation on the same account, which is both less to type and
 * impossible to get wrong.
 */
export function StartReconciliation({
  accounts,
}: {
  accounts: Array<{ id: string; name: string; mask: string | null }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [financialAccountId, setAccount] = useState(accounts[0]?.id ?? '')
  const [statementStartDate, setStart] = useState('')
  const [statementEndDate, setEnd] = useState('')
  const [statementEndingBalance, setBalance] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    startTransition(async () => {
      const result = await startReconciliationAction({
        financialAccountId,
        statementStartDate,
        statementEndDate,
        statementEndingBalance,
      })

      if (result.ok && result.reconciliationId) {
        router.push(`/accounting/reconcile/${result.reconciliationId}`)
      } else if (!result.ok) {
        setError(result.error)
      }
    })
  }

  if (accounts.length === 0) {
    return (
      <section className="card p-4">
        <p className="text-sm text-muted">
          Connect a bank account first — there is nothing to reconcile yet.
        </p>
      </section>
    )
  }

  const ready =
    financialAccountId && statementStartDate && statementEndDate && statementEndingBalance

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Start a reconciliation</h2>
      <p className="mt-0.5 text-xs text-muted">
        Enter the statement period and its ending balance. The opening balance carries over from
        the last completed reconciliation on this account.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          <span className="mb-1 block">Account</span>
          <select
            value={financialAccountId}
            onChange={(event) => setAccount(event.target.value)}
            className="field py-1.5 text-sm"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {account.mask ? ` ····${account.mask}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-muted">
          <span className="mb-1 block">Statement start</span>
          <input
            type="date"
            value={statementStartDate}
            onChange={(event) => setStart(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>

        <label className="text-xs text-muted">
          <span className="mb-1 block">Statement end</span>
          <input
            type="date"
            value={statementEndDate}
            onChange={(event) => setEnd(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>

        <label className="text-xs text-muted">
          <span className="mb-1 block">Ending balance</span>
          <input
            value={statementEndingBalance}
            onChange={(event) => setBalance(event.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className="field w-32 py-1.5 text-right text-sm"
          />
        </label>

        <button onClick={submit} disabled={!ready || pending} className="btn btn-primary text-xs">
          {pending ? 'Starting…' : 'Start'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-negative">
          {error}
        </p>
      )}
    </section>
  )
}
