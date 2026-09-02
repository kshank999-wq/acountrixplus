'use client'

import { useEffect, useState, useTransition } from 'react'
import { partyPostAction, type TimelineView } from '@/app/actions/engagement'

/**
 * What we have sent one customer or supplier (Phase 93).
 *
 * Deliberately a second panel beside `RecordHistory` rather than more rows
 * inside it. That one answers *what changed about this record*, from the audit
 * log; this answers *what did we send this party*, from the communications log
 * — the same distinction Phase 22 drew when it refused to merge the two, for
 * the same reason: merging them means the three sentences that matter scroll
 * out of sight behind forty automatic entries.
 *
 * Fetched when opened, for the reason `RecordHistory` gives: a history nobody
 * asks for is a query nobody needed, and every row on a busy screen runs one.
 */
export function PartyPost({
  kind,
  partyId,
}: {
  kind: 'customer' | 'vendor'
  partyId: string
}) {
  const [entries, setEntries] = useState<TimelineView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    startTransition(async () => {
      try {
        setEntries(await partyPostAction(kind, partyId))
      } catch {
        setError('That could not be loaded.')
      }
    })
  }, [kind, partyId])

  if (error) return <p className="text-xs text-danger">{error}</p>
  if (pending && !entries) return <p className="text-xs text-faint">Looking…</p>

  if (!entries || entries.length === 0) {
    return (
      <p className="text-xs text-muted">
        Nothing has been sent to them from here yet. Invoices, statements and reminders appear
        as they go.
      </p>
    )
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="text-xs">
          <span className="text-faint">{entry.at}</span>{' '}
          <span>{entry.title}</span>
          {entry.who && <span className="text-faint"> · {entry.who}</span>}

          {/*
            Labelled parts rather than one block (Phase 92): a note somebody
            typed and a letter this company sent are different kinds of
            evidence, and only one of them is something the other side also
            holds a copy of.
          */}
          {entry.parts.map((part) => (
            <span key={part.source} className="mt-1 block pl-6">
              <span className="text-faint">{part.label}:</span>{' '}
              <span className="whitespace-pre-wrap text-muted">{part.text}</span>
            </span>
          ))}
        </li>
      ))}
    </ul>
  )
}
