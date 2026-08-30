import { notFound } from 'next/navigation'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  reconcilableTransactions,
  summarize,
} from '@/modules/reconciliation/service'
import { listFinancialAccounts } from '@/modules/banking/sync'
import { ACCOUNTING_NAV } from '../../nav'
import { ReconcileWorkspace } from './workspace'

export const dynamic = 'force-dynamic'

export default async function ReconcileSessionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()
  const { id } = await params

  if (!can(actor, 'reconciliation:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Reconcile</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include reconciliation access.
        </p>
      </main>
    )
  }

  let summary
  try {
    summary = await summarize(actor, id)
  } catch {
    notFound()
  }

  const [transactions, accounts] = await Promise.all([
    reconcilableTransactions(actor, id),
    listFinancialAccounts(actor),
  ])

  const account = accounts.find((row) => row.id === summary.financialAccountId)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/reconcile" />

      <ReconcileWorkspace
        summary={summary}
        accountName={account?.name ?? 'Account'}
        transactions={transactions.map((row) => ({
          id: row.id,
          postedDate: row.postedDate,
          description: row.description,
          merchantName: row.merchantName,
          amountCents: row.amountCents,
          cleared: row.clearedAt !== null,
        }))}
        canPerform={can(actor, 'reconciliation:perform')}
        canReopen={can(actor, 'reconciliation:reopen')}
      />
    </AppShell>
  )
}
