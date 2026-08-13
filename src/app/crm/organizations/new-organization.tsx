'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createOrganizationAction } from '@/app/actions/crm'

export function NewOrganization() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [industry, setIndustry] = useState('')
  const [region, setRegion] = useState('')
  const [source, setSource] = useState('')
  const [isStrategicAccount, setStrategic] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-primary text-xs">
        Add a client
      </button>
    )
  }

  function submit() {
    startTransition(async () => {
      const result = await createOrganizationAction({
        name,
        email,
        industry,
        region,
        source,
        isStrategicAccount,
      })

      setMessage({
        text: result.ok ? (result.message ?? 'Added.') : result.error,
        ok: result.ok,
      })

      if (result.ok) {
        setName('')
        setEmail('')
        setOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <section className="card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Add a client</h2>
        <button onClick={() => setOpen(false)} className="btn px-2 py-1 text-xs">
          Close
        </button>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Name" value={name} onChange={setName} className="flex-1" />
        <Field label="Email" value={email} onChange={setEmail} />
        <Field label="Industry" value={industry} onChange={setIndustry} />
        <Field label="Region" value={region} onChange={setRegion} />
        <Field label="Source" value={source} onChange={setSource} />

        <label className="flex items-center gap-1.5 pb-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={isStrategicAccount}
            onChange={(event) => setStrategic(event.target.checked)}
            className="rounded border-line"
          />
          Strategic account
        </label>

        <button onClick={submit} disabled={!name || pending} className="btn btn-primary text-xs">
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {message && (
        <p
          role="status"
          className={`mt-2 text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <label className={`text-xs text-muted ${className ?? ''}`}>
      <span className="mb-1 block">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field py-1.5 text-sm"
      />
    </label>
  )
}
