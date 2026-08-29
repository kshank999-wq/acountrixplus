'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { businessInsightsAction, type InsightsResult } from '@/app/actions/ai'

const SEVERITY_STYLES: Record<string, string> = {
  high: 'border-warning/40',
  medium: 'border-line',
  low: 'border-line',
}

const SEVERITY_LABELS: Record<string, string> = {
  high: 'Worth acting on',
  medium: 'Worth knowing',
  low: 'For information',
}

/** Runs the insights assistant on demand and renders what it found. */
export function InsightsPanel({ enabled }: { enabled: boolean }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<InsightsResult | null>(null)

  if (!enabled) {
    return (
      <section className="card p-6">
        <h1 className="text-base font-semibold">Business insights</h1>
        <p className="mt-2 text-sm text-muted">
          The AI module is switched off. Every figure these insights are drawn from is already on
          the{' '}
          <Link href="/accounting/reports" className="text-action hover:underline">
            reports page
          </Link>{' '}
          — this only explains them in plain language.
        </p>
        <Link href="/ai" className="btn mt-4 text-xs">
          Module settings
        </Link>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Business insights</h1>
            <p className="text-xs text-muted">
              Drawn from your cash, receivables, payables, and pipeline. Nothing here changes
              anything.
            </p>
          </div>
          <button
            onClick={() =>
              startTransition(async () => {
                setResult(await businessInsightsAction())
              })
            }
            disabled={pending}
            className="btn btn-primary ml-auto text-xs"
          >
            {pending ? 'Reading the figures…' : result ? 'Run again' : 'Explain my figures'}
          </button>
        </div>
      </section>

      {result && !result.ok && (
        <p role="alert" className="card p-4 text-sm text-negative">
          {result.error}
        </p>
      )}

      {result?.ok && (
        <ul className="space-y-3">
          {result.insights.map((insight, index) => (
            <li
              key={index}
              className={`card border p-4 ${SEVERITY_STYLES[insight.severity] ?? 'border-line'}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-sm font-semibold">{insight.title}</h2>
                <span className="chip bg-raised text-xs text-muted">
                  {SEVERITY_LABELS[insight.severity] ?? insight.severity}
                </span>
                <span className="ml-auto text-xs text-faint">
                  {insight.metric.replace(/_/g, ' ')}
                </span>
              </div>
              <p className="mt-1.5 text-sm text-muted">{insight.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
