'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { completeResetAction } from '@/app/actions/notify'

/**
 * Choose a new password.
 *
 * The confirmation field is checked here and nowhere else, deliberately: it
 * guards against a typo, not against an attacker, so it belongs where the typo
 * happens. The length rule is enforced on the server, because that is the rule.
 */
export function ResetForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (done) {
    return (
      <div className="space-y-4 text-sm">
        <p className="font-medium text-success">{done}</p>
        <Link href="/login" className="btn btn-primary w-full">
          Sign in
        </Link>
      </div>
    )
  }

  const mismatch = again.length > 0 && again !== password

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        startTransition(async () => {
          const result = await completeResetAction({ token, password })
          if (result.ok) setDone(result.message ?? 'Password changed.')
          else setError(result.error)
        })
      }}
    >
      <p className="text-sm text-muted">
        Setting a new password for <span className="text-fg">{email}</span>.
      </p>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          New password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="field"
        />
        <p className="mt-1 text-xs text-faint">At least 8 characters.</p>
      </div>

      <div>
        <label htmlFor="again" className="mb-1.5 block text-sm font-medium">
          Again
        </label>
        <input
          id="again"
          type="password"
          autoComplete="new-password"
          required
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          className="field"
        />
        {mismatch && <p className="mt-1 text-xs text-danger">Those two do not match.</p>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        className="btn btn-primary w-full"
        disabled={pending || mismatch || password.length < 8}
      >
        {pending ? 'Changing…' : 'Change my password'}
      </button>

      <p className="text-xs text-faint">
        Every session signed in as this account is ended, on every device. If somebody else had
        your password, this is the moment they lose it.
      </p>
    </form>
  )
}
