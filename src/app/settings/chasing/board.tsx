'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  runChasesNowAction,
  updateChasePolicyAction,
  type ActionResult,
} from '@/app/actions/chasing'
import { formatCents } from '@/lib/money'

type Policy = {
  enabled: boolean
  firstAfterDays: number
  everyDays: number
  maxChases: number
  minimumBalanceCents: number
  quietDaysAfterPayment: number
  maxPerRun: number
}

type DueRow = {
  id: string
  number: string
  customerName: string
  balanceCents: number
  currency: string
  daysOverdue: number
  stage: number
  nextAfter: string | null
}

type HeldRow = {
  id: string
  number: string
  customerName: string
  balanceCents: number
  currency: string
  dueDate: string
  reason: string
  nextChase: string | null
}

/**
 * What chasing would send today, and why it would not send the rest.
 *
 * The preview is above the settings rather than below them, because the
 * decision somebody is making here is not "what numbers do I want" — it is
 * "do I trust this with my customers". That question is answered by the list,
 * and the numbers are how they adjust it afterwards.
 */
export function ChasingBoard({
  policy,
  asOf,
  due,
  held,
  heldTotal,
  heldSummary,
  overCap,
  canManage,
}: {
  policy: Policy
  asOf: string
  due: DueRow[]
  held: HeldRow[]
  heldTotal: number
  heldSummary: Array<{ reason: string; count: number; label: string }>
  overCap: number
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showSettings, setShowSettings] = useState(false)

  const [firstAfterDays, setFirstAfterDays] = useState(String(policy.firstAfterDays))
  const [everyDays, setEveryDays] = useState(String(policy.everyDays))
  const [maxChases, setMaxChases] = useState(String(policy.maxChases))
  const [minimum, setMinimum] = useState((policy.minimumBalanceCents / 100).toFixed(2))
  const [quietDays, setQuietDays] = useState(String(policy.quietDaysAfterPayment))
  const [maxPerRun, setMaxPerRun] = useState(String(policy.maxPerRun))

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  function saveNumbers() {
    act(() =>
      updateChasePolicyAction({
        firstAfterDays,
        everyDays,
        maxChases,
        minimumBalanceCents: Math.round(Number(minimum) * 100),
        quietDaysAfterPayment: quietDays,
        maxPerRun,
      }),
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Chasing overdue invoices</h2>
        <p className="text-sm text-muted">
          A reminder to the customer, on your behalf, when an invoice goes past its due date.{' '}
          <span className="text-faint">
            Nothing settled is ever chased — an invoice that has been paid, written off, voided
            or never sent is never included.
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
            {policy.enabled ? 'Chasing is on.' : 'Chasing is off.'}
          </p>
          <p className="text-sm text-muted">
            {policy.enabled
              ? `First reminder ${policy.firstAfterDays} days after an invoice is due, then every ${policy.everyDays} days, up to ${policy.maxChases} times.`
              : 'Nothing is sent to anybody until you switch this on. The list below is what would go out if you did.'}
          </p>
        </div>

        {canManage && (
          <div className="flex gap-2">
            {policy.enabled && (
              <button
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => act(runChasesNowAction)}
              >
                Send today’s now
              </button>
            )}
            <button
              type="button"
              className={`btn ${policy.enabled ? '' : 'btn-primary'}`}
              disabled={pending}
              onClick={() => act(() => updateChasePolicyAction({ enabled: !policy.enabled }))}
            >
              {policy.enabled ? 'Switch off' : 'Switch on'}
            </button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">
            {policy.enabled ? 'Going out today' : 'Would go out today'}
          </h3>
          <p className="text-xs text-faint">as at {asOf}</p>
        </div>

        {due.length === 0 ? (
          <div className="card px-4 py-6 text-center text-sm text-muted">
            Nothing is due a reminder today.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2 text-right">Outstanding</th>
                  <th className="px-4 py-2 text-right">Overdue</th>
                  <th className="px-4 py-2">Reminder</th>
                  <th className="px-4 py-2">Then</th>
                </tr>
              </thead>
              <tbody>
                {due.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-2 font-medium">{row.number}</td>
                    <td className="px-4 py-2">{row.customerName}</td>
                    <td className="tnum px-4 py-2 text-right">
                      {formatCents(row.balanceCents, row.currency)}
                    </td>
                    <td className="tnum px-4 py-2 text-right">{row.daysOverdue} days</td>
                    <td className="px-4 py-2">
                      {row.stage === 1 ? 'first' : `number ${row.stage}`} of {policy.maxChases}
                    </td>
                    <td className="px-4 py-2 text-faint">
                      {row.nextAfter ?? 'the last one'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {overCap > 0 && (
          <p className="text-sm text-muted">
            {overCap} more are due but will wait: a run sends at most {policy.maxPerRun}.
          </p>
        )}
      </section>

      {heldTotal > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Not being chased</h3>
          <div className="flex flex-wrap gap-2">
            {heldSummary.map((row) => (
              <span key={row.reason} className="chip bg-raised/60 text-muted">
                {row.count} — {row.label}
              </span>
            ))}
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2 text-right">Outstanding</th>
                  <th className="px-4 py-2">Due</th>
                  <th className="px-4 py-2">Why not</th>
                  <th className="px-4 py-2">Next</th>
                </tr>
              </thead>
              <tbody>
                {held.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-2 font-medium">{row.number}</td>
                    <td className="px-4 py-2">{row.customerName}</td>
                    <td className="tnum px-4 py-2 text-right">
                      {formatCents(row.balanceCents, row.currency)}
                    </td>
                    <td className="px-4 py-2">{row.dueDate}</td>
                    <td className="px-4 py-2 text-muted">{row.reason}</td>
                    <td className="px-4 py-2 text-faint">{row.nextChase ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {heldTotal > held.length && (
            <p className="text-xs text-faint">
              Showing the {held.length} oldest of {heldTotal}.
            </p>
          )}
        </section>
      )}

      {canManage && (
        <section className="card px-4 py-4">
          <button
            type="button"
            className="text-sm font-medium"
            onClick={() => setShowSettings((open) => !open)}
          >
            {showSettings ? 'Hide the settings' : 'Change how often, and how many'}
          </button>

          {showSettings && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <label className="block text-sm">
                  <span className="font-medium">First reminder after</span>
                  <input
                    type="number"
                    min={0}
                    className="field mt-1 w-full"
                    value={firstAfterDays}
                    onChange={(event) => setFirstAfterDays(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    Days past the due date. Zero is the day it falls due.
                  </span>
                </label>

                <label className="block text-sm">
                  <span className="font-medium">Then every</span>
                  <input
                    type="number"
                    min={1}
                    className="field mt-1 w-full"
                    value={everyDays}
                    onChange={(event) => setEveryDays(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    Days between reminders. Weekly is about as often as anybody welcomes.
                  </span>
                </label>

                <label className="block text-sm">
                  <span className="font-medium">At most</span>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    className="field mt-1 w-full"
                    value={maxChases}
                    onChange={(event) => setMaxChases(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    Reminders per invoice. After that it is a phone call, not an email.
                  </span>
                </label>

                <label className="block text-sm">
                  <span className="font-medium">Ignore anything under</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="field mt-1 w-full"
                    value={minimum}
                    onChange={(event) => setMinimum(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    A rounding difference is not worth chasing.
                  </span>
                </label>

                <label className="block text-sm">
                  <span className="font-medium">Quiet after a payment</span>
                  <input
                    type="number"
                    min={0}
                    className="field mt-1 w-full"
                    value={quietDays}
                    onChange={(event) => setQuietDays(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    Days. Somebody who part-paid has engaged; chasing them next morning reads as
                    not having noticed.
                  </span>
                </label>

                <label className="block text-sm">
                  <span className="font-medium">Most in one day</span>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    className="field mt-1 w-full"
                    value={maxPerRun}
                    onChange={(event) => setMaxPerRun(event.target.value)}
                  />
                  <span className="text-xs text-faint">
                    A ceiling for the first run, when years of unpaid invoices are all due at
                    once. The oldest go first.
                  </span>
                </label>
              </div>

              <button type="button" className="btn btn-primary" disabled={pending} onClick={saveNumbers}>
                Save
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
