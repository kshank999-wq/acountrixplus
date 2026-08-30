'use client'

import { useState } from 'react'
import { ClientForm, type ClientFields } from './client-form'

/**
 * Add a client, or correct one (Phase 78).
 *
 * Both use `ClientForm` — the fields are the same and the only difference is
 * whether an id is being edited.
 */
export function NewOrganization() {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(true)} className="btn btn-primary text-xs">
          Add a client
        </button>
        {notice && (
          <p role="status" className="text-xs text-positive">
            {notice}
          </p>
        )}
      </div>
    )
  }

  return (
    <section className="card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Add a client</h2>
        <button onClick={() => setOpen(false)} className="btn px-2 py-1 text-xs">
          Close
        </button>
      </header>

      <ClientForm
        onDone={(message) => {
          setNotice(message)
          setOpen(false)
        }}
      />
    </section>
  )
}

/**
 * The correction panel on a client's row.
 *
 * Until Phase 78 there was none: an organisation created with a typo at lead
 * intake kept it for ever, and the only escape was a second record — which
 * splits its opportunities, its proposals and its timeline in two.
 */
export function EditOrganization({
  organizationId,
  initial,
}: {
  organizationId: string
  initial: Partial<ClientFields>
}) {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  if (!open) {
    return (
      <span className="flex items-center gap-2">
        {notice && (
          <span role="status" className="text-xs text-positive">
            {notice}
          </span>
        )}
        <button onClick={() => setOpen(true)} className="text-xs text-action hover:underline">
          Correct
        </button>
      </span>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-line bg-raised p-3">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold">Correcting {initial.name}</h3>
        <button onClick={() => setOpen(false)} className="btn px-2 py-1 text-xs">
          Never mind
        </button>
      </header>

      <ClientForm
        organizationId={organizationId}
        initial={initial}
        onDone={(message) => {
          setNotice(message)
          setOpen(false)
        }}
      />
    </div>
  )
}
