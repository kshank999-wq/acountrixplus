'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { completeResetAction } from '@/app/actions/notify'
import { PasswordField } from '@/components/password-field'

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

      <PasswordField
        id="password"
        label="New password"
        autoComplete="new-password"
        minLength={8}
        value={password}
        onChange={setPassword}
        hint="At least 8 characters."
      />

      <PasswordField
        id="again"
        label="Again"
        autoComplete="new-password"
        value={again}
        onChange={setAgain}
        error={mismatch ? 'Those two do not match.' : undefined}
      />

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
