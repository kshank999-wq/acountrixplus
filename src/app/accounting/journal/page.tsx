import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listPeriods } from '@/modules/ledger/journal'
import { correctableEntries } from '@/modules/ledger/corrections-service'
import { listAccounts } from '@/modules/coa/service'
import { ACCOUNTING_NAV } from '../nav'
import { JournalForm } from './journal-form'
import { PeriodControls } from './period-controls'
import { JournalEntries } from './entries'

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
    correctableEntries(actor, { limit: 100 }),
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

      <JournalEntries
        rows={entries.map((row) => ({
          id: row.id,
          entryNumber: row.entryNumber,
          entryDate: row.entryDate,
          memo: row.memo,
          source: row.source,
          status: row.status,
          reversalOfId: row.reversalOfId,
          reversedBy: row.reversedBy,
          correction: row.correction,
        }))}
        canPost={canPost}
      />
    </AppShell>
  )
}
