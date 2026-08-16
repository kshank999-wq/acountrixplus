'use client'

import { useState, useTransition } from 'react'
import { requestResetAction } from '@/app/actions/notify'

/**
 * The form says the same thing whichever address you type.
 *
 * On success the form is replaced entirely rather than left standing with a
 * green message under it. Leaving it there invites a second and third attempt,
 * and each one supersedes the link from the last — somebody who clicks the
 * first email after asking three times finds a dead link and no explanation.
 */
export function ForgotForm() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (sent) {
    return (
      <div className="space-y-3 text-sm">
        <p className="font-medium text-success">Check that inbox.</p>
        <p className="text-muted">
          If <span className="text-fg">{email}</span> has an account, a link is on its way. It
          works once and expires in an hour.
        </p>
        <p className="text-xs text-faint">
          Nothing has changed yet. Your old password still works until you use the link.
        </p>
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(async () => {
          const result = await requestResetAction(email)
          if (result.ok) setSent(true)
          else setError(result.error)
        })
      }}
    >
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="field"
          placeholder="you@company.com"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? 'Sending…' : 'Send me a link'}
      </button>
    </form>
  )
}
