'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createOrganizationAction, updateOrganizationAction } from '@/app/actions/crm'

/**
 * Adding a client, and correcting one (Phase 78).
 *
 * One component for both, because they are the same thirteen fields and a
 * second copy of them is how the two drift — which is the defect this phase is
 * about, one level up: the record had thirteen columns, the form offered five,
 * and there was no way to change any of them afterwards.
 */

export type ClientFields = {
  name: string
  email: string
  phone: string
  website: string
  addressLine1: string
  addressLine2: string
  city: string
  region: string
  postalCode: string
  country: string
  industry: string
  source: string
  isStrategicAccount: boolean
}

const EMPTY: ClientFields = {
  name: '',
  email: '',
  phone: '',
  website: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  industry: '',
  source: '',
  isStrategicAccount: false,
}

export function ClientForm({
  organizationId,
  initial,
  onDone,
}: {
  /** Absent when adding; present when correcting. */
  organizationId?: string
  initial?: Partial<ClientFields>
  /**
   * Called with the notice on success, so the caller can keep showing it after
   * this form unmounts. `describeChanges` names the fields that changed —
   * throwing that away on close would be the point of Phase 45's sentence lost.
   */
  onDone?: (notice: string) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [fields, setFields] = useState<ClientFields>({ ...EMPTY, ...initial })
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const set = <K extends keyof ClientFields>(key: K) => (value: ClientFields[K]) =>
    setFields((current) => ({ ...current, [key]: value }))

  function submit() {
    startTransition(async () => {
      const result = organizationId
        ? await updateOrganizationAction(organizationId, fields)
        : await createOrganizationAction(fields)

      setMessage({
        text: result.ok ? (result.message ?? 'Saved.') : result.error,
        ok: result.ok,
      })

      if (result.ok) {
        router.refresh()
        onDone?.(result.message ?? 'Saved.')
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name" value={fields.name} onChange={set('name')} />
        <Field label="Email" value={fields.email} onChange={set('email')} />
        <Field label="Phone" value={fields.phone} onChange={set('phone')} />
        <Field label="Website" value={fields.website} onChange={set('website')} />
        <Field label="Industry" value={fields.industry} onChange={set('industry')} />
        <Field label="Source" value={fields.source} onChange={set('source')} />
      </div>

      {/*
        The address. `organizations` has had all six of these columns since
        Phase 3 and the form offered "Region" — so a client's street and
        postcode could not be entered at all, and Phase 77 freezes whatever is
        here into every agreement they sign.
      */}
      <fieldset className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-xs font-medium text-muted">Address</legend>
        <Field label="Address" value={fields.addressLine1} onChange={set('addressLine1')} />
        <Field label="Address line 2" value={fields.addressLine2} onChange={set('addressLine2')} />
        <Field label="City" value={fields.city} onChange={set('city')} />
        <Field label="County or state" value={fields.region} onChange={set('region')} />
        <Field label="Postcode" value={fields.postalCode} onChange={set('postalCode')} />
        <Field label="Country" value={fields.country} onChange={set('country')} />
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={fields.isStrategicAccount}
            onChange={(event) => set('isStrategicAccount')(event.target.checked)}
            className="rounded border-line"
          />
          Strategic account
        </label>

        <button
          onClick={submit}
          disabled={!fields.name.trim() || pending}
          className="btn btn-primary text-xs"
        >
          {pending ? 'Saving…' : organizationId ? 'Save changes' : 'Add'}
        </button>
      </div>

      {message && (
        <p
          role="status"
          className={`text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field py-1.5 text-sm"
      />
    </label>
  )
}
