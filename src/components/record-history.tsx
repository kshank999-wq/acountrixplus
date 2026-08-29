'use client'

import { useEffect, useState, useTransition } from 'react'
import { recordHistoryAction, type HistoryLine } from '@/app/actions/history'
import { formatCents } from '@/lib/money'

/**
 * What happened to this record (Phase 71).
 *
 * The panel the audit log never had. Opened from a row, fetched when opened
 * rather than with the page — a history nobody asks for is a query nobody
 * needed, and every row on a busy screen would run one.
 *
 * The three things it shows are the three that were written and never read:
 * **who and when** (recorded since Phase 3), **what changed** (before and
 * after, recorded since Phase 45 precisely so that a supplier's details
 * changing could be traced), and **why** (recorded since Phase 70, for the
 * five corrections that must say so).
 */

export function RecordHistory({
  entityType,
  entityId,
  /**
   * The currency to read money in. A payload carries integer cents and not
   * what they are denominated in, so the screen that knows says — and where
   * it does not, the company's own is the honest default, said out loud by
   * `formatCents` itself.
   */
  currency,
}: {
  entityType: string
  entityId: string
  currency?: string
}) {
  const [lines, setLines] = useState<HistoryLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    startTransition(async () => {
      const result = await recordHistoryAction({ entityType, entityId })
      if (result.ok) setLines(result.lines)
      else setError(result.error)
    })
  }, [entityType, entityId])

  if (error) return <p className="text-xs text-negative">{error}</p>
  if (pending && lines === null) return <p className="text-xs text-faint">Reading the record…</p>

  if (lines !== null && lines.length === 0) {
    return (
      <p className="text-xs text-muted">
        Nothing has been recorded against this one yet. Every change from here on will be.
      </p>
    )
  }

  return (
    /* Inside tables that scroll sideways on a phone, like the correction
       panels this sits beside. */
    <ol className="sticky left-0 max-w-[calc(100vw-3rem)] space-y-2.5">
      {(lines ?? []).map((line) => (
        <li key={line.id} className="border-l-2 border-line pl-3">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {/*
              A phrase somebody decided reads as a sentence; an action nobody
              has named reads as the code it is. The difference is deliberate
              — this module refuses to machine-write English for 219 actions,
              and pretending otherwise would be the more dishonest of the two.
            */}
            {line.named ? (
              <span className="text-sm font-semibold tracking-tight">{line.label}</span>
            ) : (
              <code className="rounded bg-raised px-1.5 py-0.5 text-xs font-medium">
                {line.label}
              </code>
            )}
            {line.isUndo && <span className="text-xs text-muted">(an undo)</span>}
            <span className="text-xs text-faint">
              {line.actorName ?? 'somebody no longer on these books'} ·{' '}
              <time dateTime={line.at}>{new Date(line.at).toLocaleString()}</time>
            </span>
          </div>

          {line.reason && (
            /* The whole point of Phase 70, given a reader at last. It leads,
               above the field list, because it is what somebody opened this
               panel to find. */
            <p className="mt-1 text-sm">
              <span className="text-faint">Why: </span>
              {line.reason}
            </p>
          )}

          {line.changes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {line.changes.map((change) => (
                <li key={change.key}>
                  <span className="text-faint">{change.label}</span>{' '}
                  <Value change={change} currency={currency} which="from" /> →{' '}
                  <Value change={change} currency={currency} which="to" />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}

function Value({
  change,
  currency,
  which,
}: {
  change: HistoryLine['changes'][number]
  currency?: string
  which: 'from' | 'to'
}) {
  const raw = change[which]
  if (raw === null) return <span className="text-faint italic">nothing</span>

  // A value the log keeps and this panel may never print (Phase 72). "set"
  // rather than a row of asterisks: a mask shaped like the value tells
  // somebody how long it was.
  if (change.kind === 'secret') return <span className="italic text-muted">{raw}</span>

  if (change.kind === 'money') {
    const cents = Number(raw)
    // A `*Cents` key whose value is not a number is not money after all, and
    // formatting it would print "NaN" where a figure should be.
    if (Number.isFinite(cents)) {
      return <span className="tnum">{formatCents(cents, currency)}</span>
    }
  }

  return <span>{raw}</span>
}
