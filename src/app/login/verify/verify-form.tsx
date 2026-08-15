'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { verifyMfaAction, type FormState } from '@/app/actions/auth'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? 'Checking…' : 'Verify'}
    </button>
  )
}

export function VerifyForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(verifyMfaAction, null)

  return (
    <form action={formAction} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}

      <div>
        <label htmlFor="code" className="mb-1.5 block text-sm font-medium">
          Authentication code
        </label>
        <input
          id="code"
          name="code"
          // `one-time-code` is what lets iOS and Android offer the code from
          // the notification, which is the difference between this being a
          // one-tap step and a switch-apps-and-memorise-six-digits step.
          autoComplete="one-time-code"
          inputMode="text"
          autoFocus
          required
          className="field tnum text-lg tracking-widest"
          placeholder="000000"
        />
        <p className="mt-1.5 text-xs text-muted">
          Or a recovery code, if you no longer have your phone.
        </p>
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
