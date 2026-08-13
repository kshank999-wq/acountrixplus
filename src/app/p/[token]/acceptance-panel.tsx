'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'

type Item = {
  id: string
  description: string
  amountCents: number
  isOptional: boolean
  isSelected: boolean
}

/**
 * The client-facing acceptance form (spec §7).
 *
 * Optional items are chosen here and the running total updates live, but the
 * figure that gets recorded is recomputed on the server — this component's
 * total is a preview, never the source of truth.
 */
export function AcceptancePanel({
  token,
  items,
  discountCents,
  taxCents,
  acceptable,
  accepted,
  expired,
}: {
  token: string
  items: Item[]
  discountCents: number
  taxCents: number
  acceptable: boolean
  accepted: { signerName: string; acceptedAt: string; totalCents: number } | null
  expired: boolean
}) {
  const router = useRouter()
  const optional = useMemo(() => items.filter((item) => item.isOptional), [items])

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(optional.filter((item) => item.isSelected).map((item) => item.id)),
  )
  const [signerName, setSignerName] = useState('')
  const [signerEmail, setSignerEmail] = useState('')
  const [signerTitle, setSignerTitle] = useState('')
  const [signatureText, setSignatureText] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = useMemo(() => {
    const base = items
      .filter((item) => !item.isOptional || selected.has(item.id))
      .reduce((sum, item) => sum + item.amountCents, 0)
    return base - discountCents + taxCents
  }, [items, selected, discountCents, taxCents])

  if (accepted) {
    return (
      <div className="doc-accepted">
        <p className="doc-accepted-mark">Accepted</p>
        <p>
          Signed by <strong>{accepted.signerName}</strong> on {accepted.acceptedAt} for{' '}
          <strong>{formatCents(accepted.totalCents)}</strong>.
        </p>
      </div>
    )
  }

  if (expired) {
    return (
      <p className="doc-agreement">
        This proposal has expired. Please contact us for an updated copy.
      </p>
    )
  }

  if (!acceptable) {
    return (
      <p className="doc-agreement">This proposal is not currently open for acceptance.</p>
    )
  }

  const signatureMatches =
    signatureText.trim().length > 0 &&
    signatureText.trim().toLowerCase() === signerName.trim().toLowerCase()
  const ready = signerName.trim() && signatureMatches && agreed && !pending

  async function submit() {
    setPending(true)
    setError(null)

    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerName,
          signerEmail,
          signerTitle,
          signatureText,
          selectedItemIds: [...selected],
          agreed: true,
        }),
      })

      const result = (await response.json()) as { ok: boolean; message?: string }
      if (result.ok) {
        router.refresh()
      } else {
        setError(result.message ?? 'Something went wrong. Please try again.')
      }
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="doc-accept-form doc-screen-only">
      {optional.length > 0 && (
        <fieldset className="doc-optional-picker">
          <legend>Optional additions</legend>
          {optional.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={(event) => {
                  setSelected((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })
                }}
              />
              <span>{item.description}</span>
              <span className="doc-num">{formatCents(item.amountCents)}</span>
            </label>
          ))}
        </fieldset>
      )}

      <p className="doc-running-total">
        Total if accepted <strong>{formatCents(total)}</strong>
      </p>

      <div className="doc-accept-fields">
        <label>
          <span>Your name</span>
          <input
            value={signerName}
            onChange={(event) => setSignerName(event.target.value)}
            autoComplete="name"
          />
        </label>
        <label>
          <span>Title</span>
          <input
            value={signerTitle}
            onChange={(event) => setSignerTitle(event.target.value)}
            autoComplete="organization-title"
          />
        </label>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={signerEmail}
            onChange={(event) => setSignerEmail(event.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          <span>Type your name to sign</span>
          <input
            value={signatureText}
            onChange={(event) => setSignatureText(event.target.value)}
            className="doc-signature-input"
            aria-describedby="signature-help"
          />
        </label>
      </div>

      <p id="signature-help" className="doc-signature-help">
        {signatureText.trim() && !signatureMatches
          ? 'The signature must match the name entered above.'
          : 'Typing your name here counts as your signature.'}
      </p>

      <label className="doc-agree">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        <span>I have read and agree to this proposal and its terms.</span>
      </label>

      {error && (
        <p role="alert" className="doc-accept-error">
          {error}
        </p>
      )}

      <button onClick={submit} disabled={!ready} className="doc-accept-button">
        {pending ? 'Submitting…' : 'Accept proposal'}
      </button>
    </div>
  )
}
