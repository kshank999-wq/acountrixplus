'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  reviewAnomaliesAction,
  summarizeInboxAction,
  type AnomalyResult,
} from '@/app/actions/ai'

/**
 * The bookkeeping assistant, above the inbox (spec §11).
 *
 * Rendered only when the module is switched on — the page does not render a
 * greyed-out panel for a company that has declined AI. Spec §23 calls AI
 * additive, and an affordance that is permanently disabled is not additive.
 *
 * Nothing here changes anything. It reads, it explains, and the actions it
 * offers navigate to the transaction so the person can decide there.
 */
export function AssistantPanel() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [summary, setSummary] = useState<{ summary: string; nextStep: string } | null>(null)
  const [anomalies, setAnomalies] = useState<AnomalyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function runSummary() {
    setError(null)
    startTransition(async () => {
      const result = await summarizeInboxAction()
      if (result.ok) {
        setSummary({ summary: result.summary, nextStep: result.suggestedNextStep })
      } else {
        setError(result.error)
      }
    })
  }

  function runAnomalies() {
    setError(null)
    startTransition(async () => {
      setAnomalies(await reviewAnomaliesAction())
    })
  }

  return (
    <section className="card mb-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Assistant</h2>
          <p className="text-xs text-muted">
            Suggestions only. Nothing is categorized until you say so.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={runSummary} disabled={pending} className="btn text-xs">
            {pending ? 'Thinking…' : 'Summarize the inbox'}
          </button>
          <button onClick={runAnomalies} disabled={pending} className="btn text-xs">
            Check for duplicates
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-negative">
          {error}
        </p>
      )}

      {summary && (
        <div className="mt-3 rounded-lg border border-line bg-raised/40 p-3">
          <p className="text-sm">{summary.summary}</p>
          <p className="mt-1.5 text-xs text-muted">
            <span className="font-medium text-ink">Next:</span> {summary.nextStep}
          </p>
        </div>
      )}

      {anomalies?.ok && (
        <div className="mt-3">
          {anomalies.findings.length === 0 ? (
            <p className="text-xs text-muted">
              {anomalies.message ?? 'Nothing unusual in the recent activity.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {anomalies.findings.map((finding, index) => (
                <li
                  key={index}
                  className={`rounded-lg border p-3 ${
                    finding.severity === 'high' ? 'border-warning/40' : 'border-line'
                  }`}
                >
                  <p className="text-sm">{finding.explanation}</p>
                  <ul className="mt-1.5 space-y-0.5">
                    {finding.transactions.map((row) => (
                      <li key={row.id} className="text-xs text-muted">
                        <span className="tnum">{row.postedDate}</span> · {row.description} ·{' '}
                        <span className="tnum">{formatCents(row.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => {
                      const first = finding.transactions[0]
                      if (first) router.push(`/bookkeeping?q=${encodeURIComponent(first.description)}`)
                    }}
                    className="btn mt-2 px-2 py-1 text-xs"
                  >
                    Find these
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {anomalies && !anomalies.ok && (
        <p role="alert" className="mt-3 text-xs text-negative">
          {anomalies.error}
        </p>
      )}
    </section>
  )
}
