'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  runStatementsNowAction,
  updateStatementPolicyAction,
  type ActionResult,
} from '@/app/actions/statement-runs'
import { formatCents } from '@/lib/money'

type Policy = {
  enabled: boolean
  dayOfMonth: number
  kind: 'open_item' | 'balance_forward'
  minimumBalanceCents: number
  quietDays: number
  maxPerRun: number
}

type DueRow = {
  id: string
  customerName: string
  email: string | null
  balanceCents: number
  heldCreditCents: number
}

type HeldRow = {
  id: string
  customerName: string
  balanceCents: number
  heldCreditCents: number
  reason: string
}

type SentRow = {
  id: string
  customerName: string
  asOfDate: string
  sentAt: string
  sentTo: string | null
  sendCount: number
}

/**
 * What the statement run would send this month, and why it would skip the rest.
 *
 * The preview is above the settings, for the reason Phase 43's chasing screen
 * puts it there: the decision somebody is making is not "what numbers do I
 * want", it is "do I trust this with my customers". The list answers that; the
 * numbers are how they adjust it afterwards.
 */
export function StatementRunBoard({
  policy,
  asOf,
  due,
  held,
  heldSummary,
  overCap,
  recent,
  canManage,
}: {
  policy: Policy
  asOf: string
  due: DueRow[]
  held: HeldRow[]
  heldSummary: Array<{ reason: string; count: number; label: string }>
  overCap: number
  recent: SentRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const [dayOfMonth, setDayOfMonth] = useState(String(policy.dayOfMonth))
  const [kind, setKind] = useState(policy.kind)
  const [minimum, setMinimum] = useState((policy.minimumBalanceCents / 100).toFixed(2))
  const [quietDays, setQuietDays] = useState(String(policy.quietDays))
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
      updateStatementPolicyAction({
        dayOfMonth,
        kind,
        minimumBalanceCents: Math.round(Number(minimum) * 100),
        quietDays,
        maxPerRun,
      }),
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Sending statements</h2>
        <p className="text-sm text-muted">
          A summary of the account, once a month, to every customer with something to be told.{' '}
          <span className="text-faint">
            Most late payment is not refusal — it is an invoice that fell behind a filing
            cabinet. A customer whose money you are holding gets one too, because only you know
            about it.
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
            {policy.enabled ? 'Statement runs are on.' : 'Statement runs are off.'}
          </p>
          <p className="text-sm text-muted">
            {policy.enabled
              ? `Sent on the ${ordinal(policy.dayOfMonth)} of each month, as ${
                  policy.kind === 'open_item' ? 'open-item' : 'balance-forward'
                } statements.`
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
                onClick={() => act(runStatementsNowAction)}
              >
                Run it now
              </button>
            )}
            <button
              type="button"
              className={`btn ${policy.enabled ? '' : 'btn-primary'}`}
              disabled={pending}
              onClick={() => act(() => updateStatementPolicyAction({ enabled: !policy.enabled }))}
            >
              {policy.enabled ? 'Switch off' : 'Switch on'}
            </button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">
            {policy.enabled ? 'Going out this month' : 'Would go out this month'}
          </h3>
          <p className="text-xs text-faint">as at {asOf}</p>
        </div>

        {due.length === 0 ? (
          <div className="card px-4 py-6 text-center text-sm text-muted">
            Nobody is due a statement.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">To</th>
                  <th className="px-4 py-2 text-right">Owed</th>
                  <th className="px-4 py-2 text-right">Held for them</th>
                </tr>
              </thead>
              <tbody>
                {due.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-1.5 font-medium">{row.customerName}</td>
                    <td className="px-4 py-1.5 text-muted">{row.email}</td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(row.balanceCents)}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {row.heldCreditCents > 0 ? (
                        <span className="text-success">{formatCents(row.heldCreditCents)}</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {overCap > 0 && (
          <p className="text-xs text-muted">
            {overCap} more are due but the per-run cap of {policy.maxPerRun} holds them back.
            They go out next month, or raise the cap.
          </p>
        )}
      </section>

      {/*
        The half somebody actually needs before switching this on: not what
        goes, but what does not, and why. Phase 43 learned that a preview
        without this reads as a black box.
      */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Not being sent one</h3>

        {heldSummary.length === 0 ? (
          <div className="card px-4 py-6 text-center text-sm text-muted">
            Everybody on the books is getting one.
          </div>
        ) : (
          <>
            <ul className="flex flex-wrap gap-2">
              {heldSummary.map((row) => (
                <li key={row.reason} className="chip text-xs">
                  {row.count} — {row.label}
                </li>
              ))}
            </ul>

            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2">Customer</th>
                    <th className="px-4 py-2 text-right">Owed</th>
                    <th className="px-4 py-2 text-right">Held</th>
                    <th className="px-4 py-2">Why not</th>
                  </tr>
                </thead>
                <tbody>
                  {held.map((row) => (
                    <tr key={row.id} className="border-t border-line">
                      <td className="px-4 py-1.5">{row.customerName}</td>
                      <td className="tnum px-4 py-1.5 text-right text-muted">
                        {formatCents(row.balanceCents)}
                      </td>
                      <td className="tnum px-4 py-1.5 text-right text-muted">
                        {row.heldCreditCents > 0 ? formatCents(row.heldCreditCents) : '—'}
                      </td>
                      <td className="px-4 py-1.5 text-muted">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {canManage && (
        <section className="card space-y-4 px-4 py-4">
          <h3 className="text-sm font-semibold">Change when, and to whom</h3>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Day of the month</span>
              <input
                className="field w-24 py-1.5 text-sm"
                value={dayOfMonth}
                inputMode="numeric"
                onChange={(event) => setDayOfMonth(event.target.value)}
              />
              <span className="mt-1 block text-faint">1–28</span>
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Kind</span>
              <select
                className="field w-44 py-1.5 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value as Policy['kind'])}
              >
                <option value="open_item">Open item</option>
                <option value="balance_forward">Balance forward</option>
              </select>
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Smallest balance</span>
              <input
                className="field w-28 py-1.5 text-right text-sm"
                value={minimum}
                inputMode="decimal"
                onChange={(event) => setMinimum(event.target.value)}
              />
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Quiet days</span>
              <input
                className="field w-24 py-1.5 text-sm"
                value={quietDays}
                inputMode="numeric"
                onChange={(event) => setQuietDays(event.target.value)}
              />
            </label>

            <label className="text-xs text-muted">
              <span className="mb-1 block">Most per run</span>
              <input
                className="field w-24 py-1.5 text-sm"
                value={maxPerRun}
                inputMode="numeric"
                onChange={(event) => setMaxPerRun(event.target.value)}
              />
            </label>

            <button className="btn btn-primary text-sm" disabled={pending} onClick={saveNumbers}>
              Save
            </button>
          </div>

          <p className="text-xs text-faint">
            The day is capped at the 28th, because later ones do not exist in every month and a
            run that silently skips February is worse than one on the 28th. Quiet days count
            from the last statement that actually went, including one you sent by hand. The
            smallest balance does not apply to credit you are holding — that is worth telling
            somebody however small it is.
          </p>
        </section>
      )}

      {recent.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Recently sent</h3>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">As of</th>
                  <th className="px-4 py-2">Sent</th>
                  <th className="px-4 py-2">To</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-1.5">{row.customerName}</td>
                    <td className="px-4 py-1.5 text-muted">{row.asOfDate}</td>
                    <td className="px-4 py-1.5 text-muted">
                      {row.sentAt}
                      {row.sendCount > 1 && (
                        <span className="text-faint"> · {row.sendCount} times</span>
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-faint">{row.sentTo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function ordinal(day: number): string {
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th'
  return `${day}${suffix}`
}
