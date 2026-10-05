'use client'

import { useState, useTransition } from 'react'
import {
  adviseOnAccountAction,
  rejectSuggestionAction,
  type AccountAdviceResult,
} from '@/app/actions/ai'
import { formatCents } from '@/lib/money'

type Row = {
  organizationId: string
  name: string
  severity: 'high' | 'medium' | 'low'
  stakeCents: number
  silentDays: number | null
  findings: Array<{ ground: string; label: string; severity: string; detail: string }>
}

const SEVERITY_STYLES: Record<string, string> = {
  high: 'bg-warning/15 text-warning',
  medium: 'bg-action/10 text-action',
  low: 'bg-raised text-muted',
}

type Advice = Extract<AccountAdviceResult, { ok: true }>

/**
 * The attention list (spec §11).
 *
 * The list itself is **measured**, not generated: every figure on it comes from
 * `crm/attention.ts`, which has no database, no clock and no gateway in it. So
 * this panel renders with the AI module switched off, and the assistant button
 * is simply absent — §11 requires the core product to work without AI, and the
 * part of this capability that can be checked is the part that does.
 */
export function AttentionPanel({
  accounts,
  aiEnabled,
  canAdvise,
}: {
  accounts: Row[]
  aiEnabled: boolean
  /** Whether this role may act on a relationship, not merely read one. */
  canAdvise: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [advice, setAdvice] = useState<{ organizationId: string; advice: Advice } | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (accounts.length === 0) {
    return (
      <section className="card mt-4 p-4">
        <h2 className="text-sm font-semibold">Needs attention</h2>
        <p className="mt-1 text-xs text-muted">
          Nothing is outstanding. No account is past its contact cadence, no proposal is waiting,
          and every named account has an owner.
        </p>
      </section>
    )
  }

  return (
    <section className="card mt-4 overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Needs attention</h2>
        <p className="text-xs text-muted">
          Measured, not guessed: silence against each account&rsquo;s cadence, proposals still
          waiting, deals with no conversation behind them. Worst first, then by what is at stake.
        </p>
      </header>

      <ul className="divide-y divide-line">
        {accounts.map((account) => (
          <li key={account.organizationId} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="text-sm font-medium">{account.name}</p>
              <span className={`chip ${SEVERITY_STYLES[account.severity]}`}>
                {account.severity}
              </span>
              {account.stakeCents > 0 && (
                <span className="tnum text-xs text-muted">
                  {formatCents(account.stakeCents)} at stake
                </span>
              )}
              <span className="text-xs text-faint">
                {account.silentDays === null
                  ? 'never contacted'
                  : `${account.silentDays} days quiet`}
              </span>

              {aiEnabled && canAdvise && (
                <button
                  onClick={() =>
                    startTransition(async () => {
                      setError(null)
                      const result = await adviseOnAccountAction(account.organizationId)
                      if (!result.ok) {
                        setError(result.error)
                        return
                      }
                      setAdvice({ organizationId: account.organizationId, advice: result })
                    })
                  }
                  disabled={pending}
                  className="btn ml-auto text-xs"
                >
                  What should I do?
                </button>
              )}
            </div>

            <ul className="mt-1.5 space-y-0.5">
              {account.findings.map((finding) => (
                <li key={finding.ground} className="text-xs text-muted">
                  <span className="font-medium">{finding.label}:</span> {finding.detail}
                </li>
              ))}
            </ul>

            {advice?.organizationId === account.organizationId && (
              <div className="mt-3 rounded-lg border border-line bg-raised p-3">
                <p className="text-xs">{advice.advice.summary}</p>

                {advice.advice.nextActions.length > 0 && (
                  <ol className="mt-2 space-y-1.5">
                    {advice.advice.nextActions.map((action) => (
                      <li key={action.action} className="text-xs">
                        <p className="font-medium">{action.action}</p>
                        <p className="text-muted">
                          {action.because}{' '}
                          <span className="text-faint">
                            ({action.urgency.replace(/_/g, ' ')})
                          </span>
                        </p>
                      </li>
                    ))}
                  </ol>
                )}

                <div className="mt-3">
                  <p className="text-xs font-medium">Outreach draft</p>
                  <p className="mt-0.5 text-xs text-muted">{advice.advice.outreach.subject}</p>
                  {/*
                    `whitespace-pre-wrap`, because the draft has paragraphs and
                    a wall of text is a draft nobody sends.
                  */}
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted">
                    {advice.advice.outreach.body}
                  </p>
                </div>

                <p className="mt-3 text-xs text-faint">
                  A suggestion, not a message. Nothing has been sent and nothing on this account
                  has changed.
                </p>

                <button
                  onClick={() =>
                    startTransition(async () => {
                      /*
                        Dismissing records the rejection rather than closing the
                        box, so the §12 decision log is a log of decisions and
                        not only of acceptances.
                      */
                      await rejectSuggestionAction(advice.advice.suggestionId)
                      setAdvice(null)
                    })
                  }
                  disabled={pending}
                  className="btn mt-2 text-xs"
                >
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="border-t border-line px-4 py-2 text-xs text-warning">{error}</p>}
    </section>
  )
}
