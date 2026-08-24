'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { registerAction, type FormState } from '@/app/actions/auth'
import { PasswordField } from '@/components/password-field'

function SubmitButton({ blocked }: { blocked: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending || blocked}>
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
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')

  /*
   * Checked here and nowhere else, matching the reset and invitation forms: a
   * confirmation guards against a typo, not against an attacker, so it belongs
   * where the typo happens. The length rule is enforced on the server, because
   * that is the rule.
   *
   * It matters more on this form than on the others. This is the only password
   * nobody can recover: it creates the first account, and until a real mail
   * provider is configured a reset link is generated and delivered nowhere.
   */
  const mismatch = again.length > 0 && again !== password
  const blocked = password.length < 8 || mismatch

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

      <PasswordField
        id="password"
        name="password"
        label="Password"
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

      {state?.error && (
        <p role="alert" className="text-sm text-negative">
          {state.error}
        </p>
      )}

      <SubmitButton blocked={blocked} />
    </form>
  )
}
