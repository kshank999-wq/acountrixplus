'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { createDepositAction, voidDepositAction } from '@/app/actions/accounting-core'
import { formatCents, parseAmountToCents } from '@/lib/money'
import { CorrectionButton, CorrectionPanel } from '@/components/correction-panel'

type Receipt = {
  id: string
  paymentDate: string
  amountCents: number
  customerName: string | null
  reference: string | null
}

type Deposit = {
  id: string
  number: string
  depositDate: string
  totalCents: number
  receiptsCents: number
  accountName: string
  voided: boolean
}

type Named = { id: string; name: string }
type Account = { id: string; number: string; name: string }

/**
 * The deposit slip.
 *
 * Laid out as one: tick what is going in the envelope and watch the total,
 * because the total is the whole point — it is the figure the bank statement
 * will carry and the one reconciliation has to match.
 */
export function DepositBoard({
  waiting,
  deposits,
  accounts,
  lineAccounts,
  canRecord,
}: {
  waiting: Receipt[]
  deposits: Deposit[]
  accounts: Named[]
  lineAccounts: Account[]
  canRecord: boolean
}) {
  const today = new Date().toISOString().slice(0, 10)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [depositDate, setDepositDate] = useState(today)
  const [feeAccountId, setFeeAccountId] = useState('')
  const [fee, setFee] = useState('')
  const [memo, setMemo] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  /** Which deposit has its unbank confirmation open (Phase 70). */
  const [unbanking, setUnbanking] = useState<string | null>(null)

  const grossCents = useMemo(
    () => waiting.filter((r) => selected.has(r.id)).reduce((sum, r) => sum + r.amountCents, 0),
    [waiting, selected],
  )
  const feeCents = fee.trim() ? parseAmountToCents(fee) : 0
  const netCents = grossCents - (feeCents ?? 0)

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function record() {
    startTransition(async () => {
      const result = await createDepositAction({
        financialAccountId: accountId,
        depositDate,
        paymentIds: [...selected],
        feeAccountId: feeCents ? feeAccountId || undefined : undefined,
        feeCents: feeCents || undefined,
        memo: memo.trim() || undefined,
      })
      setNotice({ ok: result.ok, text: result.ok ? (result.message ?? 'Recorded.') : result.error })
      if (result.ok) {
        setSelected(new Set())
        setFee('')
        setMemo('')
      }
    })
  }

  function unbank(deposit: Deposit, reason: string | null) {
    startTransition(async () => {
      const result = await voidDepositAction(deposit.id, today, reason)
      setNotice({ ok: result.ok, text: result.ok ? (result.message ?? 'Unbanked.') : result.error })
      if (result.ok) setUnbanking(null)
    })
  }

  return (
    <div className="mt-4 space-y-4">
      {notice && (
        <p
          className={`card p-3 text-sm ${notice.ok ? 'text-success' : 'border-danger/40 text-danger'}`}
        >
          {notice.text}
        </p>
      )}

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Waiting to be deposited</h2>
          <p className="text-xs text-muted">
            Money that has arrived and not been banked. Tick what went in the envelope — the bank
            will show one line for the total, and this is what makes it match.
          </p>
        </header>

        {waiting.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            Nothing is waiting. A receipt lands here when it is recorded without a bank account.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium" />
                <th className="px-4 py-2 font-medium">Received</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">Reference</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((receipt) => (
                <tr key={receipt.id} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(receipt.id)}
                      onChange={() => toggle(receipt.id)}
                      disabled={!canRecord}
                      aria-label={`Include ${receipt.customerName ?? 'receipt'}`}
                    />
                  </td>
                  <td className="tnum px-4 py-1.5 text-muted">{receipt.paymentDate}</td>
                  <td className="px-4 py-1.5">{receipt.customerName ?? '—'}</td>
                  <td className="px-4 py-1.5 text-muted">{receipt.reference ?? '—'}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(receipt.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canRecord && selected.size > 0 && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Deposit slip</h2>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Into</span>
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="field w-full py-1.5 text-sm"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Date</span>
              <input
                type="date"
                value={depositDate}
                onChange={(event) => setDepositDate(event.target.value)}
                className="field w-full py-1.5 text-sm"
              />
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Fee deducted</span>
              <input
                value={fee}
                onChange={(event) => setFee(event.target.value)}
                placeholder="0.00"
                className="field w-full py-1.5 text-sm"
              />
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Fee account</span>
              <select
                value={feeAccountId}
                onChange={(event) => setFeeAccountId(event.target.value)}
                className="field w-full py-1.5 text-sm"
              >
                <option value="">Choose…</option>
                {lineAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.number} {account.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-3 block text-xs text-muted">
            <span className="mb-1 block">Memo</span>
            <input
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              className="field w-full py-1.5 text-sm"
            />
          </label>

          <dl className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">
                {selected.size} receipt{selected.size === 1 ? '' : 's'}
              </dt>
              <dd className="tnum">{formatCents(grossCents)}</dd>
            </div>
            {feeCents ? (
              <div className="flex justify-between">
                <dt className="text-muted">Fee</dt>
                <dd className="tnum text-danger">−{formatCents(feeCents)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between font-semibold">
              <dt>What the bank will show</dt>
              <dd className="tnum">{formatCents(netCents)}</dd>
            </div>
          </dl>

          <button
            onClick={record}
            disabled={pending || !accountId || netCents <= 0 || (!!feeCents && !feeAccountId)}
            className="btn btn-primary mt-3"
          >
            {pending ? 'Recording…' : 'Record deposit'}
          </button>

          {!!feeCents && !feeAccountId && (
            <p className="mt-2 text-xs text-warning">
              A fee needs an account to land on, or the expense would have nowhere to go.
            </p>
          )}
        </section>
      )}

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Deposit history</h2>
        </header>

        {deposits.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No deposits recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Into</th>
                <th className="px-4 py-2 text-right font-medium">Receipts</th>
                <th className="px-4 py-2 text-right font-medium">Banked</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {deposits.map((deposit) => (
                <Fragment key={deposit.id}>
                  <tr className="border-t border-line">
                    <td className="px-4 py-1.5">
                      {deposit.number}
                      {deposit.voided && (
                        /* "unbanked", the vocabulary's word — the receipts on
                           it went back to waiting, which is what "reversed"
                           never quite said (Phase 70). */
                        <span className="ml-2 chip bg-raised px-2 py-0.5 text-xs text-muted">
                          unbanked
                        </span>
                      )}
                    </td>
                    <td className="tnum px-4 py-1.5 text-muted">{deposit.depositDate}</td>
                    <td className="px-4 py-1.5">{deposit.accountName}</td>
                    <td className="tnum px-4 py-1.5 text-right text-muted">
                      {formatCents(deposit.receiptsCents)}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(deposit.totalCents)}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      {canRecord && !deposit.voided && (
                        <CorrectionButton
                          kind="deposit.void"
                          open={unbanking === deposit.id}
                          disabled={pending}
                          onClick={() =>
                            setUnbanking((current) =>
                              current === deposit.id ? null : deposit.id,
                            )
                          }
                        />
                      )}
                    </td>
                  </tr>

                  {unbanking === deposit.id && (
                    <tr className="border-t border-line bg-raised/40">
                      <td colSpan={6} className="px-4 py-3">
                        <CorrectionPanel
                          kind="deposit.void"
                          pending={pending}
                          confirmSuffix={deposit.number}
                          onConfirm={(reason) => unbank(deposit, reason)}
                        >
                          The {formatCents(deposit.totalCents)} comes back out of{' '}
                          {deposit.accountName}, and the receipts that made it go back to waiting
                          to be deposited. Nothing left the business, so a reason is welcome rather
                          than required.
                        </CorrectionPanel>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
