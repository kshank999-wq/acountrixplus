'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  importPayoutsAction,
  updatePaymentSettingsAction,
  type ActionResult,
} from '@/app/actions/payments'
import { formatCents } from '@/lib/money'

type Settings = {
  enabled: boolean
  feePercentBp: number
  feeFixedCents: number
  payoutFinancialAccountId: string | null
}

type Account = {
  id: string
  name: string
  mask: string | null
  chartAccountNumber: string
}

type CheckoutRow = {
  id: string
  status: string
  grossCents: number
  feeCents: number
  currency: string
  invoiceNumber: string
  customerName: string
  failureReason: string | null
  paidOut: boolean
  on: string
}

type PayoutRow = {
  id: string
  arrivalDate: string
  amountCents: number
  currency: string
  differenceCents: number
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'not completed',
  succeeded: 'paid',
  failed: 'declined',
  expired: 'expired',
}

/**
 * Where the money is, and how it gets here.
 *
 * The position sits at the top because it is the question a business has after
 * their first card payment — "so where is it" — and for two working days the
 * honest answer is "at the processor", which is precisely what a ledger
 * posting straight to the bank could never say.
 */
export function PaymentsBoard({
  settings,
  feeDescription,
  health,
  position,
  accounts,
  checkouts,
  payouts,
  canManage,
}: {
  settings: Settings
  feeDescription: string
  health: { selected: string; effective: string; fellBack: boolean }
  position: { agrees: boolean; owedCents: number; ledgerCents: number; differenceCents: number }
  accounts: Account[]
  checkouts: CheckoutRow[]
  payouts: PayoutRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showSettings, setShowSettings] = useState(!settings.enabled)

  const [percent, setPercent] = useState((settings.feePercentBp / 100).toString())
  const [fixed, setFixed] = useState((settings.feeFixedCents / 100).toFixed(2))
  const [payoutAccount, setPayoutAccount] = useState(settings.payoutFinancialAccountId ?? '')

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  function save(over: Record<string, unknown> = {}) {
    act(() =>
      updatePaymentSettingsAction({
        feePercentBp: Math.round(Number(percent) * 100),
        feeFixedCents: Math.round(Number(fixed) * 100),
        payoutFinancialAccountId: payoutAccount || null,
        ...over,
      }),
    )
  }

  const held = checkouts.filter((row) => row.status === 'succeeded' && !row.paidOut).length

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Card payments</h2>
        <p className="text-sm text-muted">
          A Pay button on every invoice you share.{' '}
          <span className="text-faint">
            The money reaches your bank in a batch a couple of days later, net of the
            processor’s fee — so it sits in <strong>1250 Payments in Transit</strong> until it
            arrives, and the deposit posts as the single line your statement shows.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          <p className="whitespace-pre-line">{notice.text}</p>
        </div>
      )}

      <section className="card flex flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div>
          <p className="text-sm font-medium">
            {settings.enabled ? 'Card payments are on.' : 'Card payments are off.'}
          </p>
          <p className="text-sm text-muted">
            {settings.enabled
              ? `${feeDescription}, taken by the processor before the money arrives.`
              : 'Customers who open a shared invoice have no way to pay it.'}
          </p>
          {health.fellBack && (
            <p className="mt-1 text-sm text-danger">
              “{health.selected}” has no credentials, so the demonstration processor is running.
              No card is ever charged.
            </p>
          )}
        </div>

        {canManage && (
          <div className="flex gap-2">
            {settings.enabled && (
              <button
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => act(importPayoutsAction)}
              >
                Check for deposits
              </button>
            )}
            <button
              type="button"
              className={`btn ${settings.enabled ? '' : 'btn-primary'}`}
              disabled={pending || (!settings.enabled && !payoutAccount)}
              onClick={() => save({ enabled: !settings.enabled })}
            >
              {settings.enabled ? 'Switch off' : 'Switch on'}
            </button>
          </div>
        )}
      </section>

      <section className="card px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">At the processor</p>
            <p className="tnum text-2xl font-semibold">{formatCents(position.owedCents)}</p>
            <p className="text-sm text-muted">
              {held === 0
                ? 'Nothing is waiting to be deposited.'
                : `${held} payment${held === 1 ? '' : 's'} waiting to be deposited.`}
            </p>
          </div>

          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted">1250 Payments in Transit</p>
            <p className="tnum text-lg">{formatCents(position.ledgerCents)}</p>
            <p className={`text-sm ${position.agrees ? 'text-success' : 'text-danger'}`}>
              {position.agrees
                ? 'Agrees with the ledger.'
                : `Out by ${formatCents(position.differenceCents)} — checked nightly.`}
            </p>
          </div>
        </div>
      </section>

      {checkouts.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Payments taken</h3>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2 text-right">Charged</th>
                  <th className="px-4 py-2 text-right">Fee</th>
                  <th className="px-4 py-2 text-right">You get</th>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Where it is</th>
                </tr>
              </thead>
              <tbody>
                {checkouts.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-2 font-medium">{row.invoiceNumber}</td>
                    <td className="px-4 py-2">{row.customerName}</td>
                    <td className="tnum px-4 py-2 text-right">
                      {formatCents(row.grossCents, row.currency)}
                    </td>
                    <td className="tnum px-4 py-2 text-right text-muted">
                      {row.feeCents > 0 ? `−${formatCents(row.feeCents, row.currency)}` : '—'}
                    </td>
                    <td className="tnum px-4 py-2 text-right">
                      {row.status === 'succeeded'
                        ? formatCents(row.grossCents - row.feeCents, row.currency)
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted">{row.on}</td>
                    <td className="px-4 py-2">
                      {row.status !== 'succeeded' ? (
                        <span className="text-muted">
                          {STATUS_LABELS[row.status] ?? row.status}
                          {row.failureReason ? ` — ${row.failureReason}` : ''}
                        </span>
                      ) : row.paidOut ? (
                        <span className="text-success">in your bank</span>
                      ) : (
                        <span className="text-muted">at the processor</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {payouts.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Deposits</h3>
          <p className="text-sm text-faint">
            One row each, matching the one line your bank statement shows.
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Arrived</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2">Against its own payments</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-2">{row.arrivalDate}</td>
                    <td className="tnum px-4 py-2 text-right font-medium">
                      {formatCents(row.amountCents, row.currency)}
                    </td>
                    <td className="px-4 py-2">
                      {row.differenceCents === 0 ? (
                        <span className="text-success">agrees</span>
                      ) : (
                        <span className="text-danger">
                          out by {formatCents(row.differenceCents, row.currency)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {canManage && (
        <section className="card px-4 py-4">
          <button
            type="button"
            className="text-sm font-medium"
            onClick={() => setShowSettings((open) => !open)}
          >
            {showSettings ? 'Hide the settings' : 'Change the fee and the payout account'}
          </button>

          {showSettings && (
            <div className="mt-4 space-y-4">
              <label className="block text-sm">
                <span className="font-medium">The processor pays into</span>
                <select
                  className="field mt-1 w-full max-w-sm"
                  value={payoutAccount}
                  onChange={(event) => setPayoutAccount(event.target.value)}
                >
                  <option value="">Choose an account…</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                      {account.mask ? ` ••${account.mask}` : ''} — {account.chartAccountNumber}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-faint">
                  Where the batch deposit posts. Card payments cannot be switched on without
                  one — taking money with nowhere to record it arriving is not something to
                  guess at.
                </span>
              </label>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <label className="block text-sm">
                  <span className="font-medium">Fee percentage</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step="0.01"
                    className="field mt-1 w-full"
                    value={percent}
                    onChange={(event) => setPercent(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    What your processor charges. 2.9 is the usual rack rate.
                  </span>
                </label>

                <label className="block text-sm">
                  <span className="font-medium">Plus, per payment</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="field mt-1 w-full"
                    value={fixed}
                    onChange={(event) => setFixed(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    Used until the processor reports the real fee, which then wins.
                  </span>
                </label>
              </div>

              <button type="button" className="btn btn-primary" disabled={pending} onClick={() => save()}>
                Save
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
