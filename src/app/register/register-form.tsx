'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { registerAction, type FormState } from '@/app/actions/auth'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? 'Creating…' : 'Create company'}
    </button>
  )
}

export function RegisterForm({
  industries,
}: {
  industries: Array<{ key: string; label: string }>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(registerAction, null)

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="companyName" className="mb-1.5 block text-sm font-medium">
          Company name
        </label>
        <input id="companyName" name="companyName" required className="field" />
      </div>

      <div>
        <label htmlFor="industry" className="mb-1.5 block text-sm font-medium">
          Industry
        </label>
        <select id="industry" name="industry" required className="field" defaultValue="general">
          {industries.map((industry) => (
            <option key={industry.key} value={industry.key}>
              {industry.label}
            </option>
          ))}
        </select>
      </div>

      <hr className="border-line" />

      <div>
        <label htmlFor="userName" className="mb-1.5 block text-sm font-medium">
          Your name
        </label>
        <input id="userName" name="userName" required className="field" />
      </div>

      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input id="email" name="email" type="email" required className="field" />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          className="field"
        />
        <p className="mt-1 text-xs text-faint">At least 8 characters.</p>
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
