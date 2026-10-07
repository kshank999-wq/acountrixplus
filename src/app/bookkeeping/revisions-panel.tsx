'use client'

import { useState, useTransition } from 'react'
import { applyChangeAction, dismissRevisionAction } from '@/app/actions/bookkeeping'
import { formatCents } from '@/lib/money'

/**
 * The revisions a bank feed could not apply (Phase 177).
 *
 * This panel is the reason the hold is a control rather than a dropped update.
 * `importTransactions` used `ON CONFLICT DO NOTHING`, so a pending transaction
 * posting at a different amount was silently ignored — and a count in a job
 * result would have been the same defect wearing a number, since nobody reads a
 * job result.
 *
 * Shown above the inbox and only when there is something to show, because a
 * permanent empty panel is how the one that matters gets skimmed past.
 */

export type HeldRevisionRow = {
  id: string
  transactionId: string
  accountName: string
  /** The account's own currency. A bank transaction inherits it. */
  currency: string
  description: string
  /** What the bank asserted: different figures, or that it never happened. */
  kind: 'revision' | 'retraction'
  holdGround: string
  remedy: string
  summary: string
  fromAmountCents: number
  toAmountCents: number
  fromPostedDate: string
  toPostedDate: string
  applyable: boolean
}

export function RevisionsPanel({
  rows,
  canEdit,
}: {
  rows: HeldRevisionRow[]
  canEdit: boolean
}) {
  if (rows.length === 0) return null

  return (
    <section className="card mb-6 border-amber-300 bg-amber-50/60">
      <header>
        <h2 className="text-sm font-semibold">
          {rows.length === 1
            ? 'The bank changed one transaction after it was recorded'
            : `The bank changed ${rows.length} transactions after they were recorded`}
        </h2>
        <p className="mt-1 text-xs text-muted">
          Usually a pending transaction posting at a different amount — a tip, an exchange rate, a
          fuel hold settling. Sometimes the bank withdraws one outright, because an authorisation
          never captured. None of these were acted on, because something in the books was built
          from what is already stored. Leaving them is a reconciliation that will not close by
          exactly the difference.
        </p>
      </header>

      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <RevisionRow key={row.id} row={row} canEdit={canEdit} />
        ))}
      </ul>
    </section>
  )
}

function RevisionRow({ row, canEdit }: { row: HeldRevisionRow; canEdit: boolean }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [note, setNote] = useState('')

  const retracted = row.kind === 'retraction'
  // A withdrawal carries no new figures — the amount is what is being taken
  // back, not what it is becoming — so the before/after columns would both read
  // the same. Shown as one amount instead.
  const amountMoved = !retracted && row.fromAmountCents !== row.toAmountCents
  const dateMoved = !retracted && row.fromPostedDate !== row.toPostedDate

  function apply() {
    setError(null)
    startTransition(async () => {
      const result = await applyChangeAction(row.id)
      if (!result.ok) setError(result.error)
    })
  }

  function dismiss() {
    setError(null)
    startTransition(async () => {
      const result = await dismissRevisionAction(row.id, note)
      if (!result.ok) setError(result.error)
      else setDismissing(false)
    })
  }

  return (
    <li className="rounded border border-amber-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{row.description}</span>
        <span className="text-xs text-muted">{row.accountName}</span>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        {retracted && (
          <div>
            <dt className="text-muted">The bank says this never happened</dt>
            <dd className="font-medium line-through">
              {formatCents(row.toAmountCents, row.currency)}
            </dd>
          </div>
        )}
        {amountMoved && (
          <div>
            <dt className="text-muted">Amount</dt>
            <dd>
              <span className="line-through">{formatCents(row.fromAmountCents, row.currency)}</span>{' '}
              <span className="font-medium">{formatCents(row.toAmountCents, row.currency)}</span>
            </dd>
          </div>
        )}
        {dateMoved && (
          <div>
            <dt className="text-muted">Date</dt>
            <dd>
              <span className="line-through">{row.fromPostedDate}</span>{' '}
              <span className="font-medium">{row.toPostedDate}</span>
            </dd>
          </div>
        )}
      </dl>

      {/*
        The remedy, not the ground. "posted-to-the-ledger" is a register key and
        says nothing to the person reading it; the remedy is a sentence naming a
        screen they can open. Phase 119.
      */}
      <p className="mt-2 text-xs text-muted">{row.remedy}</p>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/*
            Absent rather than disabled when this ground cannot be applied here.
            A disabled button invites a person to work out why; the remedy above
            already told them, and the thing to do is on another screen.
          */}
          {row.applyable && (
            <button className="btn btn-sm" onClick={apply} disabled={pending}>
              {/*
                The label says which act it is, because the two are not
                interchangeable: one re-posts the entry at a new figure and the
                other voids it and posts nothing. A single "Apply" would be the
                button asking somebody to guess.
              */}
              {pending
                ? retracted
                  ? 'Excluding…'
                  : 'Applying…'
                : retracted
                  ? 'Exclude and void'
                  : 'Apply and re-post'}
            </button>
          )}

          {dismissing ? (
            <span className="flex flex-wrap items-center gap-2">
              <input
                className="input input-sm"
                placeholder={
                retracted
                  ? 'Why does the transaction stand?'
                  : 'Why does the stored figure stand?'
              }
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button className="btn btn-sm" onClick={dismiss} disabled={pending}>
                Dismiss
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setDismissing(false)}
                disabled={pending}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setDismissing(true)}
              disabled={pending}
            >
              {retracted ? 'The transaction stands' : 'The stored figure stands'}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
