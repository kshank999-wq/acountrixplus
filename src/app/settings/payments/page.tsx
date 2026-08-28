import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listFinancialAccounts } from '@/modules/banking/accounts'
import { getPaymentSettings } from '@/modules/payments/settings'
import { paymentProviderHealth } from '@/modules/payments/registry'
import { recentCheckouts, recentPayouts } from '@/modules/payments/service'
import { paymentsInTransitPosition } from '@/modules/payments/reporting'
import { describeSchedule } from '@/modules/payments/settlement'
import { SETTINGS_NAV } from '../nav'
import { PaymentsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Taking money by card (spec §13, Phase 44).
 *
 * The screen leads with where the money is, not with the settings, because the
 * question somebody has after their first card payment is "so where is it" —
 * and the answer, for two working days, is "at the processor", which is the
 * one thing a ledger that posted straight to the bank could never tell them.
 */
export default async function PaymentsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Card payments</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const settings = await getPaymentSettings(actor.companyId)

  const [accounts, checkouts, payouts, position] = await Promise.all([
    listFinancialAccounts(actor),
    recentCheckouts(actor),
    recentPayouts(actor),
    paymentsInTransitPosition(actor),
  ])

  const health = paymentProviderHealth(settings.provider)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/payments" />
      <PaymentsBoard
        settings={{
          enabled: settings.enabled,
          feePercentBp: settings.fee.percentBp,
          feeFixedCents: settings.fee.fixedCents,
          payoutFinancialAccountId: settings.payoutFinancialAccountId,
        }}
        feeDescription={describeSchedule(settings.fee)}
        health={health}
        position={position}
        accounts={accounts
          .filter((account) => account.isActive)
          .map((account) => ({
            id: account.id,
            name: account.name,
            mask: account.mask,
            chartAccountNumber: account.chartAccountNumber,
          }))}
        checkouts={checkouts.map((row) => ({
          id: row.id,
          status: row.status,
          grossCents: row.grossCents,
          feeCents: row.feeCents,
          currency: row.currency,
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName,
          failureReason: row.failureReason,
          paidOut: row.paidOut,
          on: (row.completedAt ?? row.createdAt).toISOString().slice(0, 10),
        }))}
        payouts={payouts.map((row) => ({
          id: row.id,
          arrivalDate: row.arrivalDate,
          amountCents: row.amountCents,
          currency: row.currency,
          differenceCents: row.differenceCents,
        }))}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
