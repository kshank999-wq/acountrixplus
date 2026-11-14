'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setJobStatusAction } from '@/app/actions/jobs'
import type { JobStatus as JobStatusValue } from '@/modules/jobs/lifecycle'

export type JobStateOption = {
  status: JobStatusValue
  label: string
  terminal: boolean
  /** Why this entry exists, straight from `JOB_STATES`. */
  because: string
  /** The refusal sentence for this move from where the job is now, or null. */
  refusal: string | null
}

/**
 * Where a job is, and the ways out of it (Phase 212).
 *
 * The options and their refusals are computed on the server from `JOB_STATES`
 * and handed down, rather than being decided again here. A dropdown that knows
 * which moves are legal is a second copy of the transition table, and the
 * refusal a person reads when they try anyway would then be written twice — the
 * shape this phase's register exists to remove. So the control offers every
 * state and renders the refusal for the ones that cannot be reached, which also
 * means somebody reads *why* rather than finding an option greyed out.
 */
export function JobStatus({
  projectId,
  jobCode,
  current,
  options,
  endDate,
  notes,
  canManage,
}: {
  projectId: string
  jobCode: string
  current: JobStateOption
  options: JobStateOption[]
  endDate: string | null
  notes: string | null
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [note, setNote] = useState(notes ?? '')
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const target = options.find((option) => option.status === choice) ?? null

  function submit() {
    if (!target) return

    start(async () => {
      const result = await setJobStatusAction({
        projectId,
        status: target.status,
        effectiveDate: target.terminal && effectiveDate ? effectiveDate : undefined,
        note: note.trim() === (notes ?? '').trim() ? undefined : note.trim() || null,
      })

      setMessage(
        result.ok
          ? { text: result.message ?? 'Saved.', ok: true }
          : { text: result.error, ok: false },
      )

      if (result.ok) {
        setOpen(false)
        setChoice('')
        router.refresh()
      }
    })
  }

  return (
    <section className="card mb-4 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">
            This job is {current.label}
            {endDate ? <span className="font-normal text-muted"> · {endDate}</span> : null}
          </p>
          <p className="mt-0.5 max-w-prose text-xs text-muted">{current.because}</p>
          {notes ? <p className="mt-1 max-w-prose text-xs">{notes}</p> : null}
        </div>

        {canManage && (
          <button className="btn text-xs" onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Change'}
          </button>
        )}
      </div>

      {open && canManage && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="text-muted">Move {jobCode} to</span>
              <select
                className="input mt-1"
                value={choice}
                onChange={(event) => {
                  setChoice(event.target.value)
                  setMessage(null)
                }}
              >
                <option value="">Choose a state…</option>
                {options.map((option) => (
                  <option key={option.status} value={option.status}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {target?.terminal && (
              <label className="block text-xs">
                <span className="text-muted">The day it happened</span>
                <input
                  type="date"
                  className="input mt-1"
                  value={effectiveDate}
                  onChange={(event) => setEffectiveDate(event.target.value)}
                />
                <span className="mt-1 block text-muted">Today, if you leave this empty.</span>
              </label>
            )}
          </div>

          <label className="mt-3 block text-xs">
            <span className="text-muted">Note on the job</span>
            <textarea
              className="input mt-1"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why, for whoever opens this next."
            />
          </label>

          {target && (
            <p className="mt-2 max-w-prose text-xs text-muted">
              {target.refusal ?? target.because}
            </p>
          )}

          <div className="mt-3">
            <button
              className="btn-primary text-xs"
              disabled={pending || !target || target.refusal !== null}
              onClick={submit}
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className={`mt-2 max-w-prose text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </p>
      )}
    </section>
  )
}
