import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listImportRuns, reversalBlockers } from '@/modules/importing/reversal'
import { openingReadiness } from '@/modules/importing/opening-balances'
import { listStatementAccounts } from '@/modules/importing/statements'
import { IMPORT_KINDS } from '@/modules/importing/vocabulary'
import { SETTINGS_NAV } from '../nav'
import { ImportWizard } from './wizard'

export const dynamic = 'force-dynamic'

/**
 * Bringing an existing business's books in (spec §20 Phase 8).
 *
 * The page leads with the opening-balance readiness check rather than the
 * upload form, because the question a migration is answering is "are my books
 * open yet", and the answer is one number.
 */
export default async function ImportPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Bring in your books</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const canReport = can(actor, 'reports:financial')

  const [runs, readiness, accounts] = await Promise.all([
    listImportRuns(actor),
    canReport ? openingReadiness(actor) : Promise.resolve(null),
    listStatementAccounts(actor),
  ])

  // Worked out on the server so "Undo" is never a button that fails.
  const blockers = await Promise.all(
    runs.map(async (run) =>
      run.status === 'committed' ? await reversalBlockers(actor, run.id) : [],
    ),
  )

  // A bookkeeper imports bank statements and an accountant brings the opening
  // books across. They are different jobs with different permissions, so the
  // page names what this person may do rather than gating the whole wizard on
  // the stricter of the two.
  const canOpenBooks = can(actor, 'accounting:journal')
  const canImportStatement = can(actor, 'bookkeeping:import')
  const allowedKinds = IMPORT_KINDS.filter((kind) =>
    kind === 'bank_statement' ? canImportStatement : canOpenBooks,
  )

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="bookkeeping"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/import" />
      <ImportWizard
        readiness={readiness}
        runs={runs.map((run, index) => ({
          id: run.id,
          kind: run.kind,
          status: run.status,
          fileName: run.fileName,
          rowCount: run.rowCount,
          createdCount: run.createdCount,
          updatedCount: run.updatedCount,
          totalCents: run.totalCents,
          createdAt: run.createdAt.toISOString().slice(0, 10),
          notes: run.notes,
          blockers: blockers[index],
          canUndo: run.kind === 'bank_statement' ? canImportStatement : canOpenBooks,
        }))}
        allowedKinds={allowedKinds}
        accounts={accounts}
      />
    </AppShell>
  )
}
