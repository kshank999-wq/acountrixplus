import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listEntries, listPeriods } from '@/modules/ledger/journal'
import { listAccounts } from '@/modules/coa/service'
import { ACCOUNTING_NAV } from '../nav'
import { JournalForm } from './journal-form'
import { PeriodControls } from './period-controls'

export const dynamic = 'force-dynamic'

export default async function JournalPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Journal</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [entries, accounts, periods] = await Promise.all([
    listEntries(actor, { limit: 100, includeVoid: true }),
    listAccounts(actor, { activeOnly: true }),
    listPeriods(actor),
  ])

  const canPost = can(actor, 'accounting:journal')
  const canClose = can(actor, 'accounting:close')

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/journal" />

      {canClose && <PeriodControls periods={periods} />}

      {canPost && (
        <div className="mt-4">
          <JournalForm
            accounts={accounts.map((a) => ({ id: a.id, number: a.number, name: a.name }))}
          />
        </div>
      )}

      <section className="card mt-4 overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Journal entries</h2>
          <p className="text-xs text-muted">
            Most entries are derived from bank transactions, invoices, and payments. Voided
            entries stay listed — the ledger corrects by reversal, never by deletion.
          </p>
        </header>

        {entries.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Memo</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-line">
                    <td className="tnum px-4 py-1.5 text-faint">{entry.entryNumber}</td>
                    <td className="tnum whitespace-nowrap px-4 py-1.5">{entry.entryDate}</td>
                    <td className="px-4 py-1.5">{entry.memo ?? '—'}</td>
                    <td className="px-4 py-1.5 text-xs text-muted">
                      {entry.source.replace('_', ' ')}
                    </td>
                    <td className="px-4 py-1.5">
                      <span
                        className={`chip ${
                          entry.status === 'posted'
                            ? 'bg-positive/15 text-positive'
                            : 'bg-raised text-faint'
                        }`}
                      >
                        {entry.status}
                      </span>
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
