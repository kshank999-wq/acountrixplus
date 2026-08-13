import { requireActor } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { reviewQueue } from '@/modules/mobile/operations'
import { ReceiptCapture } from './capture'

export const dynamic = 'force-dynamic'

export default async function ReceiptPage() {
  const actor = await requireActor()

  if (!can(actor, 'bookkeeping:categorize')) {
    return (
      <div className="card p-4">
        <p className="text-sm font-medium">No access</p>
        <p className="mt-1 text-xs text-muted">
          Your role ({actor.role}) cannot attach receipts.
        </p>
      </div>
    )
  }

  const queue = await reviewQueue(actor, { limit: 60 })

  // Spending is what receipts are for; a deposit almost never has one.
  const spending = queue.filter((row) => row.amountCents < 0)

  return (
    <ReceiptCapture
      transactions={spending.map((row) => ({
        id: row.id,
        postedDate: row.postedDate,
        amountCents: row.amountCents,
        label: row.merchantName ?? row.description,
      }))}
    />
  )
}
