'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { loginAction, type FormState } from '@/app/actions/auth'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

export function LoginForm() {
  const [state, formAction] = useActionState<FormState, FormData>(loginAction, null)

  return (
    <form action={formAction} className="space-y-4">
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
          className="field"
          placeholder="you@company.com"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="field"
        />
      </div>

      {state?.error && (
        <p role="alert" className="text-sm text-negative">
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  )
}
