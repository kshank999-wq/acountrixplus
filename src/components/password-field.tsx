'use client'

import { useId, useState } from 'react'

/**
 * A password input you can read back.
 *
 * ## Why a shared component
 *
 * Five screens ask for a password — sign in, register, reset, accept an
 * invitation, change it in settings — and every one of them hid what was being
 * typed with no way to check it. That is the wrong trade in both directions: a
 * mistyped password on the way *in* is a lockout, and on the way *out* of a
 * setup form it is an account whose password nobody knows, on a deployment
 * where password reset does not send mail.
 *
 * Revealing is the user's choice and defaults to off, so the shoulder-surfing
 * case is unchanged for anybody who does not ask.
 *
 * `autoComplete` is required rather than defaulted, because getting it wrong is
 * how a password manager saves the wrong thing: `new-password` on a form that
 * sets one, `current-password` on a form that checks one.
 */
export function PasswordField({
  name,
  label,
  autoComplete,
  value,
  onChange,
  minLength,
  hint,
  error,
  required = true,
  id: providedId,
}: {
  name?: string
  label: string
  autoComplete: 'new-password' | 'current-password'
  value?: string
  onChange?: (value: string) => void
  minLength?: number
  hint?: string
  error?: string
  required?: boolean
  id?: string
}) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  const [revealed, setRevealed] = useState(false)

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <button
          type="button"
          onClick={() => setRevealed((shown) => !shown)}
          className="text-xs text-muted underline underline-offset-2 hover:text-fg"
          /*
           * Not a checkbox and not inside the input: it changes nothing about
           * the value, only who can read it, and a form control here would be
           * submitted and tabbed through as if it mattered.
           */
          aria-controls={id}
          aria-pressed={revealed}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>

      <input
        id={id}
        name={name}
        type={revealed ? 'text' : 'password'}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        className="field"
      />

      {(error || hint) && (
        <p id={`${id}-note`} className={`mt-1 text-xs ${error ? 'text-danger' : 'text-faint'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
}
