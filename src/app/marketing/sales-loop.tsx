'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { completeTaskAction, reopenFromMarketingAction } from '@/app/actions/marketing'

const LOSS_LABELS: Record<string, string> = {
  price: 'lost on price',
  timing: 'lost on timing',
  competitor: 'lost to a competitor',
  no_response: 'went quiet',
  scope: 'lost on scope',
  internal_cancellation: 'cancelled internally',
  other: 'lost',
}

/** One follow-up task, with the single action that closes it. */
export function TaskRow({
  id,
  title,
  detail,
  dueOn,
  organizationName,
  canComplete,
}: {
  id: string
  title: string
  detail: string | null
  dueOn: string | null
  organizationName: string | null
  canComplete: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  if (done) return null

  const overdue = dueOn ? dueOn < new Date().toISOString().slice(0, 10) : false

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {detail && <p className="mt-0.5 text-xs text-muted">{detail}</p>}
        <p className="mt-0.5 text-xs text-faint">
          {organizationName ?? 'No client on record'}
          {dueOn && (
            <span className={overdue ? 'text-warning' : ''}> · due {dueOn}</span>
          )}
        </p>
      </div>

      {canComplete && (
        <button
          onClick={() =>
            startTransition(async () => {
              const result = await completeTaskAction(id)
              if (result.ok) {
                setDone(true)
                router.refresh()
              }
            })
          }
          disabled={pending}
          className="btn shrink-0 text-xs"
        >
          {pending ? 'Closing…' : 'Done'}
        </button>
      )}
    </li>
  )
}

/**
 * A lost deal whose client has started engaging again (spec §10).
 *
 * Reopening is a button a person presses, never something engagement does on
 * its own — an automatic reopen would quietly rewrite the win/loss figures
 * spec §9 reports.
 */
export function ReEngageRow({
  opportunityId,
  organizationName,
  opportunityTitle,
  lossReason,
  campaignName,
  lastClickedAt,
  canReopen,
}: {
  opportunityId: string
  organizationName: string
  opportunityTitle: string
  lossReason: string | null
  campaignName: string | null
  lastClickedAt: string | null
  canReopen: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [reopened, setReopened] = useState(false)

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{organizationName}</p>
          <p className="mt-0.5 text-xs text-muted">
            {opportunityTitle}
            {lossReason && ` — ${LOSS_LABELS[lossReason] ?? lossReason}`}
          </p>
          <p className="mt-0.5 text-xs text-faint">
            Clicked {campaignName ? `“${campaignName}”` : 'a campaign'}
            {lastClickedAt && ` on ${lastClickedAt.slice(0, 10)}`}
          </p>
        </div>

        {reopened ? (
          <Link href="/crm" className="btn shrink-0 text-xs">
            Open pipeline
          </Link>
        ) : (
          canReopen && (
            <button
              onClick={() =>
                startTransition(async () => {
                  const result = await reopenFromMarketingAction(opportunityId, 'qualified')
                  if (result.ok) {
                    setReopened(true)
                    router.refresh()
                  } else {
                    setError(result.error)
                  }
                })
              }
              disabled={pending}
              className="btn btn-primary shrink-0 text-xs"
            >
              {pending ? 'Reopening…' : 'Reopen deal'}
            </button>
          )
        )}
      </div>

      {error && (
        <p role="alert" className="mt-1.5 text-xs text-negative">
          {error}
        </p>
      )}
    </li>
  )
}
