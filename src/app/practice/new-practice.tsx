'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createPracticeAction } from '@/app/actions/practice'

/** Shown to somebody who does not work at a firm yet. */
export function NewPracticeForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <section className="card mx-auto max-w-lg overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Set up a practice</h2>
        <p className="text-xs text-muted">
          A practice is a firm that works on other companies’ books. It is not part of any one
          company, which is why this page has no company’s name on it.
        </p>
      </header>

      <div className="space-y-3 px-4 py-3">
        {error && <p className="text-sm text-danger">{error}</p>}

        <label className="block text-xs text-muted">
          <span className="mb-1 block">Practice name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Hartley &amp; Co"
            className="field w-full"
          />
        </label>

        <label className="block text-xs text-muted">
          <span className="mb-1 block">Contact email</span>
          <input
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
            placeholder="hello@hartley.test"
            className="field w-full"
          />
          <span className="mt-1 block text-faint">
            Shown to a client deciding whether to let you in.
          </span>
        </label>

        <button
          className="btn btn-primary"
          disabled={pending || !name.trim()}
          onClick={() =>
            startTransition(async () => {
              const result = await createPracticeAction({ name, contactEmail })
              if (result.ok) router.refresh()
              else setError(result.error)
            })
          }
        >
          Create it
        </button>

        <p className="text-xs text-faint">
          Creating a practice grants access to nothing. Every client decides separately, and can
          end it whenever they like without asking you.
        </p>
      </div>
    </section>
  )
}
