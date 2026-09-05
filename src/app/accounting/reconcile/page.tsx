import Link from 'next/link'
import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { listFinancialAccounts } from '@/modules/banking/sync'
import { reconciliationHistory } from '@/modules/reconciliation/service'
import { ACCOUNTING_NAV } from '../nav'
import { StartReconciliation } from './start-form'

export const dynamic = 'force-dynamic'

export default async function ReconcilePage() {
  const actor = await requireActor()
  const session = await requireSession()

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

  const [accounts, history] = await Promise.all([
    listFinancialAccounts(actor),
    reconciliationHistory(actor),
  ])

  const inProgress = history.filter((row) => row.status === 'in_progress')
  const finished = history.filter((row) => row.status !== 'in_progress')
  const accountName = new Map(accounts.map((account) => [account.id, account.name]))

  // A statement balance is in the bank's money, and this list spans accounts
  // (Phase 131). Falling back to the company's own is the honest answer when
  // the account is gone: the figure is still what it always was, and there is
  // nothing left to say it was in anything else.
  const accountCurrency = new Map(accounts.map((account) => [account.id, account.currency]))

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/reconcile" />

      {inProgress.length > 0 && (
        <section className="card mb-4 p-4">
          <h2 className="text-sm font-semibold">In progress</h2>
          <ul className="mt-2 space-y-1">
            {inProgress.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/accounting/reconcile/${row.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2 text-sm hover:opacity-90"
                >
                  <span>
                    {accountName.get(row.financialAccountId) ?? 'Account'} ·{' '}
                    <span className="tnum text-muted">{row.statementEndDate}</span>
                  </span>
                  <span className="tnum text-xs text-muted">
                    Statement{' '}
                    {formatCents(
                      row.statementEndingBalanceCents,
                      accountCurrency.get(row.financialAccountId),
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {can(actor, 'reconciliation:perform') && (
        <StartReconciliation
          accounts={accounts.map((account) => ({
            id: account.id,
            name: account.name,
            mask: account.mask,
          }))}
        />
      )}

      <section className="card mt-4 overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Reconciliation history</h2>
          <p className="text-xs text-muted">
            Each completed row is a record that the books agreed with the bank on that date.
          </p>
        </header>

        {finished.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No completed reconciliations yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Statement date</th>
                  <th className="px-4 py-2 text-right font-medium">Ending balance</th>
                  <th className="px-4 py-2 text-right font-medium">Cleared</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {finished.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-4 py-1.5">
                      {accountName.get(row.financialAccountId) ?? '—'}
                    </td>
                    <td className="tnum px-4 py-1.5">{row.statementEndDate}</td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(
                        row.statementEndingBalanceCents,
                        accountCurrency.get(row.financialAccountId),
                      )}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right">{row.clearedCount ?? 0}</td>
                    <td className="px-4 py-1.5">
                      <Link
                        href={`/accounting/reconcile/${row.id}`}
                        className={`chip ${
                          row.status === 'completed'
                            ? 'bg-positive/15 text-positive'
                            : 'bg-warning/15 text-warning'
                        }`}
                      >
                        {row.status}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  )
}
