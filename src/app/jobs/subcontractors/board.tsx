'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import { formatBasisPoints } from '@/lib/ratio'
import {
  COMPLIANCE_LABELS,
  type ComplianceKind,
  type DocumentStatus,
} from '@/modules/jobs/vocabulary'
// Type-only, so the service module (and the database driver it imports) is
// erased at compile time rather than pulled into the browser bundle.
import type { SubcontractorSummary } from '@/modules/jobs/compliance'
import {
  createSubcontractorAction,
  recordComplianceDocumentAction,
  setPaymentHoldAction,
} from '@/app/actions/jobs'

/**
 * Subcontractor compliance.
 *
 * Sorted problems-first, because the list exists to answer "who should I not
 * be paying today" and an alphabetical list buries that answer.
 */
export function ComplianceBoard({
  subcontractors,
  vendors,
  canManage,
  today,
}: {
  subcontractors: SubcontractorSummary[]
  vendors: Array<{ id: string; name: string }>
  canManage: boolean
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [addingSub, setAddingSub] = useState(false)
  const [documentFor, setDocumentFor] = useState<string | null>(null)

  const [vendorId, setVendorId] = useState('')
  const [trade, setTrade] = useState('')
  const [retainage, setRetainage] = useState('10')

  const [kind, setKind] = useState<ComplianceKind>('general_liability')
  const [carrier, setCarrier] = useState('')
  const [reference, setReference] = useState('')
  const [expiresOn, setExpiresOn] = useState('')

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      setMessage({
        text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
        ok: result.ok,
      })
      if (result.ok) router.refresh()
    })
  }

  const sorted = [...subcontractors].sort((a, b) => {
    if (a.hasProblem !== b.hasProblem) return a.hasProblem ? -1 : 1
    return a.vendorName.localeCompare(b.vendorName)
  })

  const problems = sorted.filter((sub) => sub.hasProblem).length

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Subcontractor compliance</h2>
            <p className="text-xs text-muted">
              {problems === 0
                ? 'Every tracked subcontractor has current insurance and a W-9 on file.'
                : `${problems} ${problems === 1 ? 'subcontractor needs' : 'subcontractors need'} attention before their next payment.`}
            </p>
          </div>
          {canManage && vendors.length > 0 && (
            <button className="btn text-xs" onClick={() => setAddingSub((value) => !value)}>
              {addingSub ? 'Cancel' : 'Track a vendor as a subcontractor'}
            </button>
          )}
        </header>

        {addingSub && canManage && (
          <div className="flex flex-wrap gap-2 border-b border-line p-4">
            <select
              className="field flex-1"
              value={vendorId}
              onChange={(event) => setVendorId(event.target.value)}
            >
              <option value="">Choose a vendor…</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
            </select>
            <input
              className="field w-44"
              placeholder="Trade (e.g. Electrical)"
              value={trade}
              onChange={(event) => setTrade(event.target.value)}
            />
            <label className="flex items-center gap-1 text-xs text-muted">
              Retainage
              <input
                className="field w-16 text-right"
                inputMode="decimal"
                value={retainage}
                onChange={(event) => setRetainage(event.target.value)}
              />
              %
            </label>
            <button
              className="btn btn-primary text-xs"
              disabled={pending || !vendorId}
              onClick={() =>
                act(async () => {
                  const result = await createSubcontractorAction({
                    vendorId,
                    trade: trade || undefined,
                    defaultRetainageBp: Math.round(Number(retainage || '0') * 100),
                  })
                  if (result.ok) {
                    setVendorId('')
                    setTrade('')
                    setAddingSub(false)
                  }
                  return result
                })
              }
            >
              {pending ? 'Saving…' : 'Add'}
            </button>
          </div>
        )}

        {sorted.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No subcontractors tracked. Add one from your vendor list to start collecting insurance
            certificates and W-9s.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {sorted.map((sub) => (
              <li key={sub.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {sub.vendorName}
                      {sub.trade && <span className="ml-2 text-xs text-muted">{sub.trade}</span>}
                      {sub.holdPayments && (
                        <span className="ml-2 chip bg-negative/10 text-negative">
                          Payments on hold
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      Default retainage {formatBasisPoints(sub.defaultRetainageBp)}
                      {sub.licenseNumber ? ` · licence ${sub.licenseNumber}` : ''}
                    </p>
                  </div>

                  {canManage && (
                    <div className="flex gap-2">
                      <button
                        className="btn px-2 py-1 text-xs"
                        onClick={() =>
                          setDocumentFor((current) => (current === sub.id ? null : sub.id))
                        }
                      >
                        Record a document
                      </button>
                      <button
                        className="btn px-2 py-1 text-xs"
                        disabled={pending}
                        onClick={() => act(() => setPaymentHoldAction(sub.id, !sub.holdPayments))}
                      >
                        {sub.holdPayments ? 'Lift hold' : 'Hold payments'}
                      </button>
                    </div>
                  )}
                </div>

                {sub.missingKinds.length > 0 && (
                  <p className="mt-2 text-xs text-negative">
                    Missing:{' '}
                    {sub.missingKinds.map((entry) => COMPLIANCE_LABELS[entry]).join(', ')}
                  </p>
                )}

                {sub.documents.length > 0 && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {sub.documents.map((document) => (
                          <tr key={document.id} className="border-t border-line">
                            <td className="py-1 pr-3">{COMPLIANCE_LABELS[document.kind]}</td>
                            <td className="py-1 pr-3 text-muted">{document.carrier ?? ''}</td>
                            <td className="py-1 pr-3 text-muted">{document.reference ?? ''}</td>
                            <td className="tnum py-1 pr-3 text-right text-muted">
                              {document.coverageAmountCents
                                ? formatCents(document.coverageAmountCents)
                                : ''}
                            </td>
                            <td className="py-1 text-right">
                              <StatusChip status={document.status} expiresOn={document.expiresOn} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {documentFor === sub.id && canManage && (
                  <div className="mt-3 flex flex-wrap gap-2 rounded-lg bg-raised p-3">
                    <select
                      className="field w-52"
                      value={kind}
                      onChange={(event) => setKind(event.target.value as ComplianceKind)}
                    >
                      {Object.entries(COMPLIANCE_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="field flex-1"
                      placeholder="Carrier or issuer"
                      value={carrier}
                      onChange={(event) => setCarrier(event.target.value)}
                    />
                    <input
                      className="field w-40"
                      placeholder="Policy number"
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                    />
                    <label className="flex items-center gap-1 text-xs text-muted">
                      Expires
                      <input
                        className="field w-40"
                        type="date"
                        value={expiresOn}
                        onChange={(event) => setExpiresOn(event.target.value)}
                      />
                    </label>
                    <button
                      className="btn btn-primary text-xs"
                      disabled={pending}
                      onClick={() =>
                        act(async () => {
                          const result = await recordComplianceDocumentAction({
                            subcontractorId: sub.id,
                            kind,
                            carrier: carrier || undefined,
                            reference: reference || undefined,
                            issuedOn: today,
                            expiresOn: expiresOn || null,
                          })
                          if (result.ok) {
                            setCarrier('')
                            setReference('')
                            setExpiresOn('')
                            setDocumentFor(null)
                          }
                          return result
                        })
                      }
                    >
                      {pending ? 'Saving…' : 'Record'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {message && (
          <p
            className={`border-t border-line px-4 py-2 text-xs ${
              message.ok ? 'text-positive' : 'text-negative'
            }`}
          >
            {message.text}
          </p>
        )}
      </section>
    </div>
  )
}

function StatusChip({
  status,
  expiresOn,
}: {
  status: DocumentStatus
  expiresOn: string | null
}) {
  if (status === 'no_expiry') return <span className="text-xs text-muted">on file</span>

  const tone =
    status === 'expired'
      ? 'bg-negative/10 text-negative'
      : status === 'expiring'
        ? 'bg-warning/10 text-warning'
        : 'bg-positive/10 text-positive'

  const label =
    status === 'expired'
      ? `expired ${expiresOn}`
      : status === 'expiring'
        ? `expires ${expiresOn}`
        : `valid to ${expiresOn}`

  return <span className={`chip ${tone}`}>{label}</span>
}
