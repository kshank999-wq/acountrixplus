'use client'

import { useState } from 'react'

type State = 'ready' | 'pending' | 'done' | 'failed'

/**
 * The unsubscribe confirmation (spec §10, §19).
 *
 * One button and no fields: someone who wants out should not be asked to fill
 * anything in, log in, or explain themselves. The optional reason is offered
 * only *after* the unsubscribe has already taken effect.
 */
export function UnsubscribePanel({
  token,
  email,
  firstName,
}: {
  token: string
  email: string | null
  firstName: string | null
}) {
  const [state, setState] = useState<State>('ready')
  const [alreadyDone, setAlreadyDone] = useState(false)

  async function confirm() {
    setState('pending')

    try {
      const response = await fetch(`/api/unsubscribe/${token}`, { method: 'POST' })
      const payload = (await response.json()) as { ok: boolean; alreadyUnsubscribed?: boolean }

      if (payload.ok) {
        setAlreadyDone(Boolean(payload.alreadyUnsubscribed))
        setState('done')
      } else {
        setState('failed')
      }
    } catch {
      setState('failed')
    }
  }

  if (state === 'done') {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {alreadyDone ? 'You were already unsubscribed' : 'You have been unsubscribed'}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {email ? (
            <>
              <span className="font-medium text-ink">{email}</span> will not receive
              further marketing email from us.
            </>
          ) : (
            'That address will not receive further marketing email from us.'
          )}
        </p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">
        {firstName ? `${firstName}, unsubscribe?` : 'Unsubscribe?'}
      </h1>

      <p className="mt-2 text-sm text-muted">
        {email ? (
          <>
            Confirm to stop marketing email to{' '}
            <span className="font-medium text-ink">{email}</span>.
          </>
        ) : (
          'Confirm to stop marketing email to this address.'
        )}
      </p>

      {state === 'failed' && (
        <p role="alert" className="mt-3 text-sm text-danger">
          That did not go through. This link may have expired — reply to the email and
          we will remove you by hand.
        </p>
      )}

      <button
        type="button"
        onClick={confirm}
        disabled={state === 'pending'}
        className="btn btn-primary mt-5 w-full"
      >
        {state === 'pending' ? 'Unsubscribing…' : 'Unsubscribe me'}
      </button>
    </div>
  )
}
