'use client'

import { useState, useTransition } from 'react'
import { acceptInvitationAction } from '@/app/actions/notify'
import { PasswordField } from '@/components/password-field'

/**
 * Accept an invitation.
 *
 * Somebody who already has an account sees no password field at all. Asking a
 * returning user to type their password on a page they reached from an email is
 * the exact shape of the thing everyone is told never to do, and doing it in
 * our own product teaches them the habit that gets them phished elsewhere.
 */
export function InviteForm({
  token,
  email,
  invitedName,
  hasAccount,
}: {
  token: string
  email: string
  invitedName: string | null
  hasAccount: boolean
}) {
  const [name, setName] = useState(invitedName ?? '')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const mismatch = !hasAccount && again.length > 0 && again !== password
  const blocked = !hasAccount && (password.length < 8 || mismatch)

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        startTransition(async () => {
          // On success this redirects and never returns.
          const result = await acceptInvitationAction({
            token,
            password: hasAccount ? undefined : password,
            name: name.trim() || undefined,
          })
          if (result && !result.ok) setError(result.error)
        })
      }}
    >
      <p className="text-sm text-muted">
        Joining as <span className="text-fg">{email}</span>.
      </p>

      {hasAccount ? (
        <p className="text-sm text-muted">
          You already have an account with this address, so there is nothing to set up — accept and
          you are in.
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
              Your name
            </label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="field"
              placeholder="Dana Chen"
            />
          </div>

          <PasswordField
            id="password"
            label="Choose a password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={setPassword}
            hint="At least 8 characters. Nobody who invited you will ever see it."
          />

          <PasswordField
            id="again"
            label="Again"
            autoComplete="new-password"
            value={again}
            onChange={setAgain}
            error={mismatch ? 'Those two do not match.' : undefined}
          />
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending || blocked}>
        {pending ? 'Joining…' : hasAccount ? 'Accept' : 'Create my account'}
      </button>
    </form>
  )
}
