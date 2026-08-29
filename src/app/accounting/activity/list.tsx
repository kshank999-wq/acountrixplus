'use client'

import { useMemo, useState } from 'react'
import { formatCents } from '@/lib/money'
import type { ChangeKind, Told } from '@/modules/audit/story'

/**
 * The activity feed (Phase 71).
 *
 * A client component only so that it can be filtered. The rows themselves are
 * rendered on the server and handed over whole — this reads a log, and a log
 * that fetches is a log somebody can watch change under them.
 */

export type ActivityLine = Told & {
  id: string
  at: string
  /** Who, durably. Two colleagues can share a display name. */
  userId: string | null
  actorName: string | null
  entityType: string
  isUndo: boolean
}

export function ActivityList({
  lines,
  homeCurrency,
}: {
  lines: ActivityLine[]
  homeCurrency: string
}) {
  const [only, setOnly] = useState<'all' | 'corrections' | 'reasons'>('all')
  const [who, setWho] = useState('')

  /**
   * Keyed on the user id, shown by name. Filtering on the name would put two
   * colleagues called Dana behind one option, and a log that quietly merges
   * two people is worse than one with no filter at all.
   */
  const people = useMemo(() => {
    const byId = new Map<string, string>()
    for (const line of lines) {
      if (line.userId) byId.set(line.userId, line.actorName ?? line.userId)
    }
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]))
  }, [lines])

  const shown = lines.filter((line) => {
    if (who && line.userId !== who) return false
    if (only === 'corrections') return line.named
    if (only === 'reasons') return line.reason !== null
    return true
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['all', 'Everything'],
            // The five Phase 70 corrections — the acts somebody comes to this
            // screen looking for, because they are the ones that undid
            // something.
            ['corrections', 'Corrections'],
            ['reasons', 'With a reason'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setOnly(key)}
            className={`chip px-3 py-1.5 transition ${
              only === key ? 'bg-ink text-surface' : 'bg-raised text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}

        {people.length > 1 && (
          <select
            value={who}
            onChange={(event) => setWho(event.target.value)}
            className="field ml-auto w-auto py-1.5 text-sm"
            aria-label="Whose changes"
          >
            <option value="">Anybody</option>
            {people.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-muted">
          {lines.length === 0
            ? 'Nothing has happened on these books yet.'
            : 'Nothing matches that. Every entry is still here — try "Everything".'}
        </p>
      ) : (
        <ol className="card divide-y divide-line">
          {shown.map((line) => (
            <li key={line.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {line.named ? (
                  <span className="text-sm font-semibold tracking-tight">{line.label}</span>
                ) : (
                  <code className="rounded bg-raised px-1.5 py-0.5 text-xs font-medium">
                    {line.label}
                  </code>
                )}
                <span className="text-xs text-faint">
                  {line.entityType.replace(/_/g, ' ')}
                </span>
                {line.isUndo && <span className="text-xs text-muted">(an undo)</span>}
                <span className="ml-auto text-xs text-faint">
                  {line.actorName ?? 'somebody no longer on these books'} ·{' '}
                  <time dateTime={line.at}>{new Date(line.at).toLocaleString()}</time>
                </span>
              </div>

              {line.reason && (
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
                      {render(change.from, change.kind, homeCurrency)} →{' '}
                      {render(change.to, change.kind, homeCurrency)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function render(value: string | null, kind: ChangeKind, currency: string) {
  if (value === null) return <span className="text-faint italic">nothing</span>

  // A value the log keeps and this screen may never print (Phase 72). It reads
  // as "set" rather than as a row of asterisks: a mask shaped like the value
  // tells somebody how long it was, and one shown `••••` reasonably assumes
  // the real thing is a click away.
  if (kind === 'secret') return <span className="italic text-muted">{value}</span>

  if (kind === 'money') {
    const cents = Number(value)
    // A `*Cents` key holding something that is not a number is not money after
    // all, and formatting it would print "NaN" where a figure should be.
    if (Number.isFinite(cents)) return <span className="tnum">{formatCents(cents, currency)}</span>
  }

  return <span>{value}</span>
}
