'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatCents } from '@/lib/money'
import {
  createProposalAction,
  decideProposalAction,
  sendProposalAction,
} from '@/app/actions/crm'

type Proposal = {
  id: string
  number: string
  title: string
  status: string
  totalCents: number
  organizationName: string
  sentAt: string | null
  viewCount: number
  expiresOn: string | null
  publicToken: string
  versions: Array<{ id: string; versionNumber: number; sentAt: string; hasPdf: boolean }>
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-raised text-muted',
  sent: 'bg-warning/15 text-warning',
  viewed: 'bg-action/10 text-action',
  won: 'bg-positive/15 text-positive',
  lost: 'bg-negative/15 text-negative',
  expired: 'bg-raised text-faint',
  no_decision: 'bg-raised text-faint',
}

type Line = { description: string; quantity: string; unitPrice: string; isOptional: boolean; chartAccountId: string }

const BLANK: Line = {
  description: '',
  quantity: '1',
  unitPrice: '',
  isOptional: false,
  chartAccountId: '',
}

export function ProposalList({
  proposals,
  opportunities,
  revenueAccounts,
  canManage,
}: {
  proposals: Proposal[]
  opportunities: Array<{ id: string; title: string; organizationName: string }>
  revenueAccounts: Array<{ id: string; number: string; name: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)
  const [showNew, setShowNew] = useState(false)

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setToast({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    setTimeout(() => setToast(null), 6000)
  }

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await fn()
      notify(result)
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <button onClick={() => setShowNew((v) => !v)} className="btn btn-primary text-xs">
          {showNew ? 'Close' : 'New proposal'}
        </button>
      )}

      {showNew && canManage && (
        <NewProposalForm
          opportunities={opportunities}
          revenueAccounts={revenueAccounts}
          onDone={(result) => {
            notify(result)
            if (result.ok) {
              setShowNew(false)
              router.refresh()
            }
          }}
        />
      )}

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Proposals</h2>
          <p className="text-xs text-muted">
            Sending snapshots the proposal, so editing afterwards never changes what a client was
            already shown.
          </p>
        </header>

        {proposals.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">No proposals yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <span className="tnum text-faint">{proposal.number}</span>{' '}
                      {proposal.title}
                    </p>
                    <p className="truncate text-xs text-faint">
                      {proposal.organizationName}
                      {proposal.sentAt && ` · sent ${proposal.sentAt}`}
                      {proposal.viewCount > 0 &&
                        ` · viewed ${proposal.viewCount}×`}
                      {proposal.expiresOn && ` · expires ${proposal.expiresOn}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tnum text-sm font-medium">
                      {formatCents(proposal.totalCents)}
                    </span>
                    <span
                      className={`chip ${STATUS_STYLES[proposal.status] ?? 'bg-raised text-muted'}`}
                    >
                      {proposal.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Link
                    href={`/crm/proposals/${proposal.id}/design`}
                    className="btn px-2 py-1 text-xs"
                  >
                    {canManage && proposal.status === 'draft' ? 'Design' : 'View document'}
                  </Link>
                  <Link
                    href={`/p/${proposal.publicToken}`}
                    target="_blank"
                    className="btn px-2 py-1 text-xs"
                  >
                    Client link
                  </Link>
                </div>

                {proposal.versions.length > 0 && (
                  <p className="mt-1.5 text-xs text-muted">
                    Sent:{' '}
                    {proposal.versions.map((version, index) => (
                      <span key={version.id}>
                        {index > 0 && ' · '}
                        {version.hasPdf ? (
                          <a
                            href={`/api/pdf/version/${version.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-action hover:underline"
                            title={`Exactly what the client received on ${version.sentAt}`}
                          >
                            v{version.versionNumber}
                          </a>
                        ) : (
                          <span className="text-faint" title="Sent before this proposal had a document">
                            v{version.versionNumber}
                          </span>
                        )}{' '}
                        <span className="text-faint">{version.sentAt}</span>
                      </span>
                    ))}
                  </p>
                )}

                {canManage && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => act(() => sendProposalAction(proposal.id))}
                      disabled={pending}
                      className="btn px-2 py-1 text-xs"
                    >
                      {proposal.status === 'draft' ? 'Send' : 'Resend as new version'}
                    </button>

                    {proposal.status !== 'draft' && (
                      <>
                        <button
                          onClick={() => act(() => decideProposalAction(proposal.id, 'won'))}
                          disabled={pending}
                          className="btn px-2 py-1 text-xs"
                        >
                          Won
                        </button>
                        <button
                          onClick={() => act(() => decideProposalAction(proposal.id, 'lost'))}
                          disabled={pending}
                          className="btn px-2 py-1 text-xs"
                        >
                          Lost
                        </button>
                        <button
                          onClick={() =>
                            act(() => decideProposalAction(proposal.id, 'no_decision'))
                          }
                          disabled={pending}
                          className="btn px-2 py-1 text-xs"
                        >
                          No decision
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {toast && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg ${
            toast.ok
              ? 'border-positive/40 bg-surface text-positive'
              : 'border-negative/40 bg-surface text-negative'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

function NewProposalForm({
  opportunities,
  revenueAccounts,
  onDone,
}: {
  opportunities: Array<{ id: string; title: string; organizationName: string }>
  revenueAccounts: Array<{ id: string; number: string; name: string }>
  onDone: (result: { ok: boolean; message?: string; error?: string }) => void
}) {
  const [pending, startTransition] = useTransition()
  const [opportunityId, setOpportunityId] = useState(opportunities[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [scope, setScope] = useState('')
  const [lines, setLines] = useState<Line[]>([{ ...BLANK }])

  if (opportunities.length === 0) {
    return (
      <div className="card p-4 text-sm text-muted">
        Add an open opportunity first — a proposal belongs to one.
      </div>
    )
  }

  const total = lines.reduce((sum, line) => {
    if (line.isOptional) return sum
    const quantity = Number(line.quantity) || 0
    const price = Number(line.unitPrice.replace(/[$,\s]/g, '')) || 0
    return sum + Math.round(quantity * price * 100)
  }, 0)

  function update(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const usable = lines.filter((line) => line.description.trim() && line.unitPrice.trim())

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">New proposal</h2>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          <span className="mb-1 block">Opportunity</span>
          <select
            value={opportunityId}
            onChange={(event) => setOpportunityId(event.target.value)}
            className="field py-1.5 text-sm"
          >
            {opportunities.map((opportunity) => (
              <option key={opportunity.id} value={opportunity.id}>
                {opportunity.organizationName} — {opportunity.title}
              </option>
            ))}
          </select>
        </label>

        <label className="flex-1 text-xs text-muted">
          <span className="mb-1 block">Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="field py-1.5 text-sm"
            placeholder="Foundation proposal"
          />
        </label>

        <label className="text-xs text-muted">
          <span className="mb-1 block">Expires</span>
          <input
            type="date"
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>
      </div>

      <label className="mt-3 block text-xs text-muted">
        <span className="mb-1 block">Scope of work</span>
        <textarea
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          rows={3}
          className="field text-sm"
          placeholder="What is included."
        />
      </label>

      <div className="mt-3 space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="flex flex-wrap gap-2">
            <input
              value={line.description}
              onChange={(event) => update(index, { description: event.target.value })}
              placeholder="Line description"
              className="field flex-1 py-1.5 text-xs"
              aria-label={`Line ${index + 1} description`}
            />
            <input
              value={line.quantity}
              onChange={(event) => update(index, { quantity: event.target.value })}
              inputMode="decimal"
              className="field w-20 py-1.5 text-right text-xs"
              aria-label={`Line ${index + 1} quantity`}
            />
            <input
              value={line.unitPrice}
              onChange={(event) => update(index, { unitPrice: event.target.value })}
              inputMode="decimal"
              placeholder="0.00"
              className="field w-28 py-1.5 text-right text-xs"
              aria-label={`Line ${index + 1} unit price`}
            />
            <select
              value={line.chartAccountId}
              onChange={(event) => update(index, { chartAccountId: event.target.value })}
              className="field w-44 py-1.5 text-xs"
              aria-label={`Line ${index + 1} revenue account`}
            >
              <option value="">Revenue account…</option>
              {revenueAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.number} · {account.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={line.isOptional}
                onChange={(event) => update(index, { isOptional: event.target.checked })}
              />
              Optional
            </label>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setLines((current) => [...current, { ...BLANK }])}
          className="btn px-2 py-1 text-xs"
        >
          Add line
        </button>
        <span className="tnum text-xs text-muted">Total {formatCents(total)}</span>

        <button
          onClick={() =>
            startTransition(async () => {
              onDone(
                await createProposalAction({
                  opportunityId,
                  title,
                  expiresOn,
                  scope,
                  items: usable.map((line) => ({
                    description: line.description,
                    quantity: line.quantity,
                    unitPrice: line.unitPrice,
                    isOptional: line.isOptional,
                    chartAccountId: line.chartAccountId || undefined,
                  })),
                }),
              )
            })
          }
          disabled={!title || usable.length === 0 || pending}
          className="btn btn-primary ml-auto px-3 py-1 text-xs"
        >
          {pending ? 'Creating…' : 'Create draft'}
        </button>
      </div>
    </section>
  )
}
