'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

type Entry = {
  id: string
  direction: 'inbound' | 'outbound' | 'internal'
  body: string | null
  summary: string
  occurredAt: string
}

/**
 * The client-facing question box (spec §7, Phase 174).
 *
 * §7 asks the client link for *"comments/questions"*. Before this, a client
 * reading a proposal had the choice of accepting it or finding somebody's email
 * address — and the second option loses the question, because an email reply
 * does not land on the proposal or the client's timeline.
 *
 * Shown only on a proposal that has been sent, and only when it has not been
 * decided: a question on a signed contract belongs in a conversation, not on
 * the document.
 */
export function QuestionPanel({
  token,
  thread,
  askable,
}: {
  token: string
  thread: Entry[]
  /** False once the proposal is decided, which hides the box but keeps the thread. */
  askable: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [body, setBody] = useState('')
  const [name, setName] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit() {
    startTransition(async () => {
      setError(null)
      const response = await fetch(`/api/proposals/${token}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, askerName: name || null }),
      })
      const result = (await response.json()) as { ok: boolean; message?: string }

      if (!result.ok) {
        setError(result.message ?? 'That did not send.')
        return
      }

      setBody('')
      setSent(true)
      router.refresh()
    })
  }

  if (thread.length === 0 && !askable) return null

  return (
    <section className="mx-auto mt-6 max-w-3xl px-4 print:hidden">
      <div className="card p-4">
        <h2 className="text-sm font-semibold">Questions</h2>

        {thread.length > 0 && (
          <ul className="mt-3 space-y-3">
            {thread.map((entry) => (
              <li
                key={entry.id}
                className={
                  entry.direction === 'inbound'
                    ? 'rounded-lg border border-line p-3'
                    : 'rounded-lg border border-action/30 bg-action/5 p-3'
                }
              >
                <p className="text-xs font-medium">
                  {entry.direction === 'inbound' ? 'You asked' : 'Answer'}
                  <span className="ml-1.5 font-normal text-faint">{entry.occurredAt}</span>
                </p>
                {/* Paragraphs survive, because a question typed in a box has them. */}
                <p className="mt-1 whitespace-pre-wrap text-sm">{entry.body ?? entry.summary}</p>
              </li>
            ))}
          </ul>
        )}

        {askable ? (
          <div className="mt-4">
            {sent && (
              <p className="mb-2 text-xs text-positive">
                Sent. It is on the file with your proposal, so nothing gets lost.
              </p>
            )}

            <label className="block text-xs text-muted">
              <span className="mb-1 block">Your question</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="Anything that would help you decide."
                className="field w-full text-sm"
              />
            </label>

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">
                <span className="mb-1 block">Your name (optional)</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  className="field py-1.5 text-sm"
                />
              </label>

              <button
                onClick={submit}
                disabled={pending || body.trim().length === 0}
                className="btn btn-primary ml-auto text-xs"
              >
                {pending ? 'Sending…' : 'Send question'}
              </button>
            </div>

            {error && <p className="mt-2 text-xs text-warning">{error}</p>}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">
            This proposal has been decided, so the question box is closed. The thread is kept.
          </p>
        )}
      </div>
    </section>
  )
}
