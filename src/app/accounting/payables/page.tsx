import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  accountsWithBalances,
  openVendorCredits,
  payableQueue,
} from '@/modules/payables/queue'
import { payablesPolicy } from '@/modules/payables/approvals-service'
import { listPayRuns } from '@/modules/payables/pay-runs'
import { functionalCurrency } from '@/modules/fx/service'
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

  const [queue, accounts, credits, policy, runs] = await Promise.all([
    payableQueue(actor, { asOf: today }),
    accountsWithBalances(actor),
    openVendorCredits(actor),
    payablesPolicy(actor.companyId),
    listPayRuns(actor),
  ])

  // The only currency a total on this screen can be in (Phase 60).
  const homeCurrency = await functionalCurrency(actor.companyId)

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
          // The supplier's currency, and what that is worth in ours (Phase 60).
          currency: row.currency,
          functionalBalanceCents: row.functionalBalanceCents,
          functionalTotalCents: row.functionalTotalCents,
          bucket: row.bucket,
          vendorCreditCents: row.vendorCreditCents,
          totalCents: row.totalCents,
          enteredBy: row.enteredBy,
          enteredByName: row.enteredByName,
          approvedBy: row.approvedBy,
          /** Whether this bill entered by me is one I may approve. */
          enteredByMe: row.enteredBy === actor.userId,
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
        policy={policy}
        runs={runs.map((row) => ({
          id: row.id,
          runDate: row.runDate,
          reference: row.reference,
          accountName: row.accountName,
          status: row.status,
          suppliersAttempted: row.suppliersAttempted,
          suppliersPaid: row.suppliersPaid,
          billsSettled: row.billsSettled,
          paidCents: row.paidCents,
          unpaidCents: row.unpaidCents,
          failures: row.failures,
          liveSuppliers: row.liveSuppliers,
          advisedSuppliers: row.advisedSuppliers,
        }))}
        homeCurrency={homeCurrency}
        canPay={can(actor, 'accounting:journal')}
        canApprove={can(actor, 'accounting:approve')}
      />
    </AppShell>
  )
}
