import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  accountsWithBalances,
  openVendorCredits,
  payableQueue,
} from '@/modules/payables/queue'
import { ACCOUNTING_NAV } from '../nav'
import { PayablesBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * What you owe, and choosing what to pay (spec §13, Phase 49).
 *
 * The AP mirror of Phase 43's chase queue. A/P aging has existed since Phase 2
 * as an as-of snapshot with nothing on it clickable; the bill list is ordered
 * by issue date with no totals and no overdue marking. Neither answers the
 * question a business asks itself every Friday, and neither can be paid from.
 */
export default async function PayablesPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">What we owe</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  const [queue, accounts, credits] = await Promise.all([
    payableQueue(actor, { asOf: today }),
    accountsWithBalances(actor),
    openVendorCredits(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/payables" />
      <PayablesBoard
        today={today}
        bills={queue.map((row) => ({
          id: row.id,
          number: row.number,
          vendorReference: row.vendorReference,
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          dueDate: row.dueDate,
          balanceCents: row.balanceCents,
          bucket: row.bucket,
          vendorCreditCents: row.vendorCreditCents,
        }))}
        accounts={accounts.map((row) => ({
          id: row.id,
          name: row.name,
          mask: row.mask,
          availableCents: row.availableCents,
          owingCents: row.owingCents,
        }))}
        credits={credits.map((row) => ({
          id: row.id,
          number: row.number,
          vendorId: row.vendorId ?? '',
          vendorName: row.vendorName,
          remainingCents: row.remainingCents,
        }))}
        canPay={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
