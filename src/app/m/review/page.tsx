import { requireActor } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { categorizableAccounts } from '@/modules/coa/service'
import { reviewQueue } from '@/modules/mobile/operations'
import { ReviewDeck } from './deck'

export const dynamic = 'force-dynamic'

/**
 * Quick review (spec §3: "a mobile workflow designed for several transactions
 * at a time").
 *
 * The whole queue and the whole account list are sent to the client in one
 * payload. That is the point: once this page has loaded, reviewing works with
 * the radio off, and every decision goes into the outbox rather than a
 * request.
 */
export default async function ReviewPage() {
  const actor = await requireActor()

  if (!can(actor, 'bookkeeping:categorize')) {
    return (
      <div className="card p-4">
        <p className="text-sm font-medium">No access</p>
        <p className="mt-1 text-xs text-muted">
          Your role ({actor.role}) cannot categorize transactions.
        </p>
      </div>
    )
  }

  const [queue, accounts] = await Promise.all([
    reviewQueue(actor, { limit: 100 }),
    categorizableAccounts(actor),
  ])

  const pending = queue.filter(
    (row) =>
      row.reviewState === 'new' ||
      row.reviewState === 'suggested' ||
      row.reviewState === 'needs_review',
  )

  return (
    <ReviewDeck
      transactions={pending.map((row) => ({
        id: row.id,
        postedDate: row.postedDate,
        amountCents: row.amountCents,
        description: row.description,
        merchantName: row.merchantName,
        suggestedAccountId: row.reviewState === 'suggested' ? row.chartAccountId : null,
      }))}
      accounts={accounts.map((account) => ({
        id: account.id,
        number: account.number,
        name: account.name,
      }))}
    />
  )
}
