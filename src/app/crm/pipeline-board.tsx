'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  changeStageAction,
  convertAction,
  createOpportunityAction,
  reopenOpportunityAction,
} from '@/app/actions/crm'
import { PIPELINE_STAGES, weightedValueCents, type Stage } from '@/modules/crm/pipeline'

type Opportunity = {
  id: string
  title: string
  stage: string
  expectedValueCents: number
  probability: number
  organizationName: string
  source: string | null
  lossReason: string | null
}

const LOSS_REASONS = [
  { key: 'price', label: 'Price' },
  { key: 'timing', label: 'Timing' },
  { key: 'competitor', label: 'Competitor' },
  { key: 'no_response', label: 'No response' },
  { key: 'scope', label: 'Scope' },
  { key: 'internal_cancellation', label: 'Cancelled internally' },
  { key: 'other', label: 'Other' },
]

/**
 * The pipeline board (spec §6).
 *
 * Columns follow the stage order from the spec. Closing as lost or dormant
 * opens a reason prompt rather than silently accepting the move, because
 * spec §9 reports on loss reasons and a blank one would not aggregate.
 */
export function PipelineBoard({
  opportunities,
  counts,
  organizations,
  canManage,
}: {
  opportunities: Opportunity[]
  counts: Record<string, { count: number; valueCents: number }>
  organizations: Array<{ id: string; name: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)
  const [closing, setClosing] = useState<{ id: string; stage: Stage } | null>(null)
  const [showNew, setShowNew] = useState(false)

  const byStage = useMemo(() => {
    const map = new Map<string, Opportunity[]>()
    for (const stage of PIPELINE_STAGES) map.set(stage.key, [])
    for (const opportunity of opportunities) {
      map.get(opportunity.stage)?.push(opportunity)
    }
    return map
  }, [opportunities])

  const openForecast = useMemo(
    () =>
      opportunities
        .filter((o) => !['won', 'lost', 'dormant'].includes(o.stage))
        .reduce((sum, o) => sum + weightedValueCents(o.expectedValueCents, o.probability), 0),
    [opportunities],
  )

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setToast({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    setTimeout(() => setToast(null), 5000)
  }

  function move(id: string, stage: Stage) {
    if (stage === 'lost' || stage === 'dormant') {
      setClosing({ id, stage })
      return
    }

    startTransition(async () => {
      const result = await changeStageAction(id, stage)
      notify(result)
      router.refresh()
    })
  }

  function confirmClose(reason: string) {
    if (!closing) return
    startTransition(async () => {
      const result = await changeStageAction(closing.id, closing.stage, reason)
      notify(result)
      setClosing(null)
      router.refresh()
    })
  }

  function reopen(id: string) {
    startTransition(async () => {
      const result = await reopenOpportunityAction(id, 'follow_up')
      notify(result)
      router.refresh()
    })
  }

  function convert(id: string) {
    startTransition(async () => {
      const result = await convertAction(id, false)
      notify(result)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Stat label="Open deals" value={String(countOpen(counts))} />
        <Stat label="Weighted forecast" value={formatCents(openForecast)} accent />
        {canManage && (
          <button
            onClick={() => setShowNew((v) => !v)}
            className="btn btn-primary ml-auto text-xs"
          >
            {showNew ? 'Close' : 'New opportunity'}
          </button>
        )}
      </div>

      {showNew && canManage && (
        <NewOpportunityForm
          organizations={organizations}
          onDone={(result) => {
            notify(result)
            if (result.ok) {
              setShowNew(false)
              router.refresh()
            }
          }}
        />
      )}

      {/* Horizontal board on desktop; stacked sections on a phone. */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-3">
          {PIPELINE_STAGES.map((stage) => {
            const items = byStage.get(stage.key) ?? []
            const summary = counts[stage.key]

            return (
              <section key={stage.key} className="w-64 shrink-0">
                <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {stage.label}
                  </h2>
                  <span className="tnum text-xs text-faint">{items.length}</span>
                </header>

                {summary && summary.valueCents > 0 && (
                  <p className="tnum mb-2 px-1 text-xs text-faint">
                    {formatCents(summary.valueCents)}
                  </p>
                )}

                <ul className="space-y-2">
                  {items.map((opportunity) => (
                    <li key={opportunity.id} className="card p-3">
                      <p className="text-sm font-medium leading-snug">{opportunity.title}</p>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {opportunity.organizationName}
                      </p>

                      <div className="mt-2 flex items-baseline justify-between gap-2">
                        <span className="tnum text-sm font-medium">
                          {formatCents(opportunity.expectedValueCents)}
                        </span>
                        {!stage.isTerminal && (
                          <span className="tnum text-xs text-faint">
                            {opportunity.probability}%
                          </span>
                        )}
                      </div>

                      {opportunity.lossReason && (
                        <p className="mt-1 text-xs text-warning">
                          {LOSS_REASONS.find((r) => r.key === opportunity.lossReason)?.label ??
                            opportunity.lossReason}
                        </p>
                      )}

                      {canManage && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {stage.isTerminal ? (
                            <>
                              {stage.key === 'won' && (
                                <button
                                  onClick={() => convert(opportunity.id)}
                                  disabled={pending}
                                  className="btn px-2 py-1 text-xs"
                                >
                                  Create client &amp; job
                                </button>
                              )}
                              <button
                                onClick={() => reopen(opportunity.id)}
                                disabled={pending}
                                className="btn px-2 py-1 text-xs"
                              >
                                Reopen
                              </button>
                            </>
                          ) : (
                            <select
                              value=""
                              onChange={(event) =>
                                move(opportunity.id, event.target.value as Stage)
                              }
                              disabled={pending}
                              className="field py-1 text-xs"
                              aria-label={`Move ${opportunity.title}`}
                            >
                              <option value="">Move to…</option>
                              {PIPELINE_STAGES.filter((s) => s.key !== stage.key).map((s) => (
                                <option key={s.key} value={s.key}>
                                  {s.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </li>
                  ))}

                  {items.length === 0 && (
                    <li className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-faint">
                      Empty
                    </li>
                  )}
                </ul>
              </section>
            )
          })}
        </div>
      </div>

      {closing && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="card w-full max-w-sm p-4">
            <h2 className="text-sm font-semibold">Why was this lost?</h2>
            <p className="mt-0.5 text-xs text-muted">
              Recorded so it can be reported on later.
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2">
              {LOSS_REASONS.map((reason) => (
                <button
                  key={reason.key}
                  onClick={() => confirmClose(reason.key)}
                  disabled={pending}
                  className="btn text-xs"
                >
                  {reason.label}
                </button>
              ))}
            </div>

            <button onClick={() => setClosing(null)} className="btn mt-3 w-full text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

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

function countOpen(counts: Record<string, { count: number }>): number {
  return PIPELINE_STAGES.filter((s) => !s.isTerminal).reduce(
    (sum, stage) => sum + (counts[stage.key]?.count ?? 0),
    0,
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum text-lg font-semibold ${accent ? 'text-brand' : ''}`}>{value}</p>
    </div>
  )
}

function NewOpportunityForm({
  organizations,
  onDone,
}: {
  organizations: Array<{ id: string; name: string }>
  onDone: (result: { ok: boolean; message?: string; error?: string }) => void
}) {
  const [pending, startTransition] = useTransition()
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [expectedValue, setExpectedValue] = useState('')
  const [source, setSource] = useState('')

  if (organizations.length === 0) {
    return (
      <div className="card p-4 text-sm text-muted">
        Add a client first — an opportunity belongs to one.
      </div>
    )
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          <span className="mb-1 block">Client</span>
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="field py-1.5 text-sm"
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex-1 text-xs text-muted">
          <span className="mb-1 block">What is the work?</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="field py-1.5 text-sm"
            placeholder="Foundation package"
          />
        </label>

        <label className="text-xs text-muted">
          <span className="mb-1 block">Expected value</span>
          <input
            value={expectedValue}
            onChange={(event) => setExpectedValue(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="field w-32 py-1.5 text-right text-sm"
          />
        </label>

        <label className="text-xs text-muted">
          <span className="mb-1 block">Source</span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="field w-32 py-1.5 text-sm"
            placeholder="referral"
          />
        </label>

        <button
          onClick={() =>
            startTransition(async () => {
              onDone(
                await createOpportunityAction({
                  organizationId,
                  title,
                  expectedValue,
                  source,
                }),
              )
            })
          }
          disabled={!title || pending}
          className="btn btn-primary text-xs"
        >
          Add
        </button>
      </div>
    </div>
  )
}
