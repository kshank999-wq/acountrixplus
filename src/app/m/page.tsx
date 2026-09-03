import Link from 'next/link'
import { requireActor } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { formatCents } from '@/lib/money'
import { inboxCounts } from '@/modules/bookkeeping/transactions'
import { arAging } from '@/modules/ledger/reports'
import { OutboxBadge } from './outbox-badge'
import { InstallPrompt } from './install-prompt'

export const dynamic = 'force-dynamic'

/**
 * Today (spec §3: "bookkeeping becomes a continuous habit rather than a
 * month-end project").
 *
 * The screen answers one question — *is there anything for me to do?* — and
 * then gets out of the way. It is deliberately not a dashboard: a phone opened
 * for ninety seconds cannot afford a screen of figures somebody has to read
 * before they can act.
 */
export default async function MobileHome() {
  const actor = await requireActor()

  const counts = can(actor, 'bookkeeping:view') ? await inboxCounts(actor) : null
  const receivable = can(actor, 'reports:view')
    ? await arAging(actor, { asOfDate: new Date().toISOString().slice(0, 10) })
    : null

  // `inboxCounts` is keyed by the raw review-state enum values and omits any
  // state with no rows, so every read needs its snake_case key and a default.
  // Adding an absent key produces NaN, and `NaN > 0` is false — which reads on
  // screen as "nothing to review" no matter how much is waiting.
  const waiting = counts
    ? (counts.new ?? 0) + (counts.suggested ?? 0) + (counts.needs_review ?? 0)
    : 0
  const overdue = receivable
    ? receivable.totals.totalCents - receivable.totals.current
    : 0

  return (
    <div>
      <OutboxBadge />

      {waiting > 0 ? (
        <Link
          href="/m/review"
          className="card mb-3 block bg-brand p-4 text-brand-ink active:opacity-90"
        >
          <p className="text-3xl font-semibold tnum">{waiting}</p>
          <p className="mt-0.5 text-sm">
            {waiting === 1 ? 'transaction needs a category' : 'transactions need a category'}
          </p>
          <p className="mt-2 text-xs opacity-80">
            About {Math.max(1, Math.round(waiting / 6))} minute
            {Math.max(1, Math.round(waiting / 6)) === 1 ? '' : 's'} of tapping. Start →
          </p>
        </Link>
      ) : (
        counts && (
          <div className="card mb-3 p-4">
            <p className="text-sm font-medium">Nothing to review</p>
            <p className="mt-1 text-xs text-muted">
              Every transaction has a category. This is the state the app is trying to keep you
              in.
            </p>
          </div>
        )
      )}

      <div className="grid grid-cols-2 gap-3">
        <Link href="/m/receipt" className="card p-4 active:bg-raised">
          <p className="text-sm font-medium">Capture a receipt</p>
          <p className="mt-1 text-xs text-muted">
            Photograph it now — before it goes through the wash.
          </p>
        </Link>

        {receivable && (
          <div className="card p-4">
            <p className="text-xs text-muted">Owed to you</p>
            {/* The company's own currency, which is what aging is in (Phase 107). */}
            <p className="tnum mt-0.5 text-lg font-semibold">
              {formatCents(receivable.totals.totalCents, receivable.currency)}
            </p>
            {overdue > 0 && (
              <p className="mt-0.5 text-xs text-negative">
                {formatCents(overdue, receivable.currency)} past due
              </p>
            )}
          </div>
        )}
      </div>

      {counts && (counts.suggested ?? 0) > 0 && (
        <p className="mt-3 text-xs text-muted">
          {counts.suggested} of those already have a suggested category from a rule you made — they
          are the fastest ones.
        </p>
      )}

      <InstallPrompt />
    </div>
  )
}
