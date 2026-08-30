import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { cashTieOut, listFinancialAccounts } from '@/modules/banking/accounts'
import { SETTINGS_NAV } from '../nav'
import { AccountsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The bank and card accounts a business actually has (spec §3, §5).
 *
 * Until Phase 40 these could only be created by an aggregator, so a business
 * banking somewhere the aggregator does not reach had none — and without one
 * there is no statement import, no reconciliation and no way to record a
 * deposit. This is the screen that unblocks all of them.
 */
export default async function AccountsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'bookkeeping:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Bank accounts</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the bookkeeping workspace.
        </p>
      </main>
    )
  }

  const [accounts, tieOut] = await Promise.all([
    listFinancialAccounts(actor),
    can(actor, 'accounting:view') ? cashTieOut(actor) : Promise.resolve([]),
  ])

  const byAccount = new Map(tieOut.map((row) => [row.financialAccountId, row]))

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="bookkeeping"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/accounts" />
      <AccountsBoard
        accounts={accounts.map((account) => ({
          ...account,
          tieOut: byAccount.get(account.id) ?? null,
        }))}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
