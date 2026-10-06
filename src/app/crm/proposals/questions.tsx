'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { answerQuestionAction } from '@/app/actions/crm'

type Waiting = {
  id: string
  proposalNumber: string | null
  summary: string
  body: string | null
  occurredAt: string
  /** Whole days since it was asked, computed on the server. */
  waitingDays: number
}

/**
 * Questions a client asked and nobody has answered (spec §7, Phase 174).
 *
 * Oldest first, because the one that has been waiting longest is the one
 * costing the deal — and the wait is shown in days rather than as a date,
 * since "9 days" is the fact somebody acts on and "2026-09-27" is a fact they
 * have to do arithmetic on first.
 *
 * Absent entirely when the list is empty. §23 makes affordances additive, and a
 * permanently empty panel on the busiest screen in the CRM is the clutter that
 * rule is against.
 */
export function UnansweredQuestions({ waiting }: { waiting: Waiting[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  if (waiting.length === 0) return null

  return (
    <section className="card mt-4 overflow-hidden border-warning/40">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">
          {waiting.length === 1 ? 'A client is waiting' : `${waiting.length} clients are waiting`}
        </h2>
        <p className="text-xs text-muted">
          Asked through the proposal link. An answer appears on their copy, and the exchange is on
          the client&rsquo;s timeline either way.
        </p>
      </header>

      <ul className="divide-y divide-line">
        {waiting.map((question) => (
          <li key={question.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              {question.proposalNumber && (
                <span className="tnum text-xs text-faint">{question.proposalNumber}</span>
              )}
              <p className="text-sm">{question.summary}</p>
              <span
                className={`chip ml-auto ${
                  question.waitingDays >= 3 ? 'bg-warning/15 text-warning' : 'text-muted'
                }`}
              >
                {question.waitingDays === 0
                  ? 'today'
                  : `${question.waitingDays} day${question.waitingDays === 1 ? '' : 's'}`}
              </span>
            </div>

            {question.body && question.body !== question.summary && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{question.body}</p>
            )}

            {open === question.id ? (
              <div className="mt-2">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={3}
                  maxLength={4000}
                  placeholder="What they need to know."
                  className="field w-full text-sm"
                  autoFocus
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() =>
                      startTransition(async () => {
                        const result = await answerQuestionAction(question.id, draft)
                        setNotice({
                          ok: result.ok,
                          text: result.ok ? (result.message ?? 'Answered.') : result.error,
                        })
                        if (result.ok) {
                          setOpen(null)
                          setDraft('')
                          router.refresh()
                        }
                      })
                    }
                    disabled={pending || draft.trim().length === 0}
                    className="btn btn-primary text-xs"
                  >
                    {pending ? 'Sending…' : 'Answer'}
                  </button>
                  <button
                    onClick={() => {
                      setOpen(null)
                      setDraft('')
                    }}
                    className="btn text-xs"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => {
                  setOpen(question.id)
                  setDraft('')
                  setNotice(null)
                }}
                className="btn mt-2 text-xs"
              >
                Answer
              </button>
            )}
          </li>
        ))}
      </ul>

      {notice && (
        <p
          className={`border-t border-line px-4 py-2 text-xs ${
            notice.ok ? 'text-positive' : 'text-warning'
          }`}
        >
          {notice.text}
        </p>
      )}
    </section>
  )
}
