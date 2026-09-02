'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createTaskAction,
  logCommunicationAction,
  organizationTimelineAction,
  type ActionResult,
  type TimelineView,
} from '@/app/actions/engagement'

const TONE_STYLES: Record<string, string> = {
  inbound: 'text-action',
  outbound: 'text-fg',
  internal: 'text-muted',
  system: 'text-faint',
  open: 'text-warning',
  closed: 'text-success',
}

const KIND_LABELS: Record<string, string> = {
  communication: 'said',
  task: 'follow-up',
  activity: 'system',
}

/**
 * What has happened with one client, and the two things somebody does next.
 *
 * Loaded when opened rather than with the list: a page of forty clients would
 * otherwise run forty timelines to render forty collapsed rows.
 */
export function ClientTimeline({
  organizationId,
  organizationName,
  lastContacted,
}: {
  organizationId: string
  organizationName: string
  lastContacted: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<TimelineView[] | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const [summary, setSummary] = useState('')
  const [channel, setChannel] = useState('call')
  const [direction, setDirection] = useState('outbound')
  const [followUp, setFollowUp] = useState('')
  const [followUpDue, setFollowUpDue] = useState('')

  function load() {
    startTransition(async () => {
      setEntries(await organizationTimelineAction(organizationId))
    })
  }

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) {
        setEntries(await organizationTimelineAction(organizationId))
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-2">
      <button
        className="text-xs text-action hover:underline"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next && entries === null) load()
        }}
      >
        {open ? 'Hide history' : 'History and follow-ups'}
      </button>
      {lastContacted ? (
        <span className="ml-2 text-xs text-faint">last spoken to {lastContacted}</span>
      ) : (
        <span className="ml-2 text-xs text-warning">never spoken to</span>
      )}

      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-raised/40 p-3">
          {notice && (
            <p className={`text-xs ${notice.ok ? 'text-success' : 'text-danger'}`} role="status">
              {notice.text}
            </p>
          )}

          {entries === null ? (
            <p className="text-xs text-muted">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted">
              Nothing recorded with {organizationName} yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {entries.map((entry, index) => (
                <li key={`${entry.kind}-${index}`} className="text-sm">
                  <span className="text-xs text-faint">{entry.at}</span>{' '}
                  <span className={`text-xs ${TONE_STYLES[entry.tone] ?? 'text-muted'}`}>
                    [{KIND_LABELS[entry.kind]}]
                  </span>{' '}
                  <span className={entry.tone === 'open' ? 'text-warning' : ''}>{entry.title}</span>
                  {entry.who && <span className="text-xs text-faint"> · {entry.who}</span>}
                  {/*
                    Phase 92. A communication resolves to labelled parts rather
                    than one block of body text, because a note somebody typed
                    and a letter this company sent are different kinds of
                    evidence — and in a dispute only one of them is something
                    the other side also holds a copy of.

                    Tasks and activities have no parts and keep `detail`.
                  */}
                  {entry.parts.length > 0
                    ? entry.parts.map((part) => (
                        <span key={part.source} className="block pl-14 text-xs">
                          <span className="text-faint">{part.label}:</span>{' '}
                          <span className="whitespace-pre-wrap text-muted">{part.text}</span>
                        </span>
                      ))
                    : entry.detail && (
                        <span className="block pl-14 text-xs text-muted">{entry.detail}</span>
                      )}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap gap-2">
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                className="field w-28 py-1 text-xs"
              >
                <option value="call">Call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
                <option value="message">Message</option>
                <option value="letter">Letter</option>
                <option value="note">Note</option>
              </select>
              <select
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
                className="field w-32 py-1 text-xs"
              >
                <option value="outbound">We contacted them</option>
                <option value="inbound">They contacted us</option>
                <option value="internal">Internal note</option>
              </select>
              <input
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                placeholder="What was said, in one line"
                className="field min-w-48 flex-1 py-1 text-xs"
              />
              <button
                className="btn btn-ghost text-xs"
                disabled={pending || summary.trim().length === 0}
                onClick={() => {
                  act(() =>
                    logCommunicationAction({ organizationId, channel, direction, summary }),
                  )
                  setSummary('')
                }}
              >
                Log it
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                value={followUp}
                onChange={(event) => setFollowUp(event.target.value)}
                placeholder="Raise a follow-up…"
                className="field min-w-48 flex-1 py-1 text-xs"
              />
              <input
                type="date"
                value={followUpDue}
                onChange={(event) => setFollowUpDue(event.target.value)}
                className="field w-36 py-1 text-xs"
              />
              <button
                className="btn btn-ghost text-xs"
                disabled={pending || followUp.trim().length === 0}
                onClick={() => {
                  act(() =>
                    createTaskAction({
                      title: followUp,
                      dueOn: followUpDue || undefined,
                      organizationId,
                    }),
                  )
                  setFollowUp('')
                  setFollowUpDue('')
                }}
              >
                Raise it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
