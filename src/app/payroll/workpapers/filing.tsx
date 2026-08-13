'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { markFiledExternallyAction, prepareFilingAction } from '@/app/actions/payroll'

type Filing = {
  id: string
  kind: string
  jurisdiction: string | null
  periodStart: string
  periodEnd: string
  status: string
  filedOn: string | null
  filedNote: string | null
}

/**
 * Preparing a filing, and recording that somebody filed it somewhere else.
 *
 * There is no "file" button and there is not going to be one without the
 * security review spec §19 requires. What this system can honestly hold is
 * that a human says they filed it, when, and with what reference — which is
 * what an audit trail actually needs. The status enum has no `filed` value, so
 * the shape of the data says the same thing as the screen.
 */
export function FilingPanel({
  periodStart,
  periodEnd,
  blockerCount,
  canManage,
  jurisdictions,
  filings,
}: {
  periodStart: string
  periodEnd: string
  blockerCount: number
  canManage: boolean
  jurisdictions: string[]
  filings: Filing[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [kind, setKind] = useState<'sales_tax' | 'payroll' | 'contractor'>('sales_tax')
  const [jurisdiction, setJurisdiction] = useState(jurisdictions[0] ?? '')
  const [overrideReason, setOverrideReason] = useState('')
  const [showOverride, setShowOverride] = useState(false)

  const [marking, setMarking] = useState<string | null>(null)
  const [filedOn, setFiledOn] = useState('')
  const [note, setNote] = useState('')

  function prepare(withOverride: boolean) {
    startTransition(async () => {
      const result = await prepareFilingAction({
        kind,
        jurisdiction,
        periodStart,
        periodEnd,
        overrideReason: withOverride ? overrideReason : undefined,
      })

      setMessage({ text: result.ok ? (result.message ?? 'Prepared.') : result.error, ok: result.ok })

      if (result.ok) {
        setShowOverride(false)
        setOverrideReason('')
        router.refresh()
      } else if (blockerCount > 0) {
        // The refusal names every blocker. Offering the override here rather
        // than up front means somebody has read them before they decide.
        setShowOverride(true)
      }
    })
  }

  function markFiled(filingId: string) {
    startTransition(async () => {
      const result = await markFiledExternallyAction({ filingId, filedOn, note })
      setMessage({ text: result.ok ? (result.message ?? 'Recorded.') : result.error, ok: result.ok })
      if (result.ok) {
        setMarking(null)
        setFiledOn('')
        setNote('')
        router.refresh()
      }
    })
  }

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Filings</h2>
        <p className="text-xs text-muted">
          Preparing freezes the period’s figures and the exceptions found alongside them, so a
          return questioned later shows what was known to be wrong when it was prepared. Nothing
          here submits anything to anybody.
        </p>
      </header>

      {message && (
        <p
          className={`border-b border-line px-4 py-2 text-xs ${
            message.ok ? 'text-positive' : 'text-negative'
          }`}
          role="status"
        >
          {message.text}
        </p>
      )}

      {canManage && (
        <div className="space-y-2 border-b border-line p-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted">
              Kind
              <select
                className="field mt-1 w-44"
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="sales_tax">Sales tax</option>
                <option value="payroll">Payroll</option>
                <option value="contractor">Contractor</option>
              </select>
            </label>
            <label className="text-xs text-muted">
              Jurisdiction
              <input
                className="field mt-1 w-52"
                list="workpaper-jurisdictions"
                placeholder="Optional"
                value={jurisdiction}
                onChange={(event) => setJurisdiction(event.target.value)}
              />
              <datalist id="workpaper-jurisdictions">
                {jurisdictions.map((entry) => (
                  <option key={entry} value={entry} />
                ))}
              </datalist>
            </label>
            <p className="pb-2 text-xs text-faint">
              {periodStart} → {periodEnd}
            </p>
            <button
              className="btn btn-primary text-xs"
              disabled={pending}
              onClick={() => prepare(false)}
            >
              {pending ? 'Preparing…' : 'Prepare'}
            </button>
          </div>

          {blockerCount > 0 && !showOverride && (
            <p className="text-xs text-negative">
              This period has {blockerCount} {blockerCount === 1 ? 'blocker' : 'blockers'}.
              Preparing will refuse and tell you which.
            </p>
          )}

          {showOverride && (
            <div className="rounded-lg border border-negative/40 p-3">
              <p className="text-xs text-negative">
                Preparing anyway needs a reason, and the reason is stored on the filing next to
                every blocker it overrode.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  className="field flex-1 min-w-64"
                  placeholder="Why these figures are being prepared regardless"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                />
                <button
                  className="btn text-xs"
                  disabled={pending || !overrideReason.trim()}
                  onClick={() => prepare(true)}
                >
                  Prepare with the reason recorded
                </button>
                <button className="btn text-xs" onClick={() => setShowOverride(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {filings.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing prepared yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {filings.map((filing) => (
            <li key={filing.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {filing.kind.replace('_', ' ')}
                    {filing.jurisdiction ? ` — ${filing.jurisdiction}` : ''}
                  </p>
                  <p className="text-xs text-muted">
                    {filing.periodStart} → {filing.periodEnd}
                  </p>
                  {filing.filedNote && (
                    <p className="mt-1 text-xs text-faint">
                      Filed {filing.filedOn}: {filing.filedNote}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`chip px-2 py-0.5 text-[11px] ${
                      filing.status === 'filed_externally'
                        ? 'bg-positive/15 text-positive'
                        : 'bg-raised text-muted'
                    }`}
                  >
                    {filing.status === 'filed_externally' ? 'filed elsewhere' : 'prepared'}
                  </span>
                  {canManage && filing.status !== 'filed_externally' && (
                    <button
                      className="btn px-2 py-1 text-xs"
                      onClick={() => setMarking(marking === filing.id ? null : filing.id)}
                    >
                      Record as filed
                    </button>
                  )}
                </div>
              </div>

              {marking === filing.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="field w-40"
                    type="date"
                    value={filedOn}
                    onChange={(event) => setFiledOn(event.target.value)}
                  />
                  <input
                    className="field flex-1 min-w-64"
                    placeholder="Where it was filed, and with what reference"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                  <button
                    className="btn btn-primary px-2 py-1 text-xs"
                    disabled={pending || !note.trim() || !filedOn}
                    onClick={() => markFiled(filing.id)}
                  >
                    Record
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-line px-4 py-3 text-xs text-faint">
        A filing can be “prepared” or “filed elsewhere”. There is no “filed” — this system does not
        submit returns, and a status that implied it did would be the software making a claim about
        compliance it has no way to keep.
      </p>
    </section>
  )
}
