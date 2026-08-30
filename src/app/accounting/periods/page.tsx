import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listRecurringEntries } from '@/modules/ledger/recurring'
import { listCloses, previewClose, staleCloses } from '@/modules/ledger/closing'
import { listDraftEntries } from '@/modules/ledger/journal'
import { listAccounts } from '@/modules/coa/service'
import { ACCOUNTING_NAV } from '../nav'
import { PeriodsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Recurring entries and the year-end close (spec §13, Phase 11).
 *
 * Together because they are the two places the ledger changes without anybody
 * typing an entry, and both hinge on the same question: what may happen
 * unattended, and what needs a person. A recurring template answers it once;
 * closing a year refuses to answer it at all.
 */
export default async function PeriodsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Periods</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const params = await searchParams
  // Last year by default: closing the year you are still in is unusual, and
  // offering it as the default invites it.
  const year = Number(params.year) || new Date().getUTCFullYear() - 1
  const closingDate = `${year}-12-31`

  const [templates, closes, drafts, accounts, preview, stale] = await Promise.all([
    listRecurringEntries(actor),
    listCloses(actor),
    listDraftEntries(actor, { limit: 20 }),
    listAccounts(actor, { activeOnly: true }),
    can(actor, 'accounting:close')
      ? previewClose(actor, { closingDate }).catch(() => null)
      : Promise.resolve(null),
    // Closing does not lock the period — that is a separate control by design
    // — so an entry can land in a closed year and make its figures stale
    // without anything refusing. This is the something that says so.
    staleCloses(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/periods" />

      <PeriodsBoard
        year={year}
        closingDate={closingDate}
        preview={preview}
        stale={stale.map((row) => ({
          fiscalYear: row.fiscalYear,
          entriesSinceCloseCount: row.entriesSinceCloseCount,
          netIncomeDriftCents: row.netIncomeDriftCents,
        }))}
        closes={closes.map((row) => ({
          id: row.id,
          fiscalYear: row.fiscalYear,
          closingDate: row.closingDate,
          netIncomeCents: row.netIncomeCents,
          revenueCents: row.revenueCents,
          expenseCents: row.expenseCents,
          reopenedAt: row.reopenedAt?.toISOString() ?? null,
          reopenReason: row.reopenReason,
        }))}
        templates={templates.map((row) => ({
          id: row.id,
          name: row.name,
          cadence: row.cadence,
          dayOfMonth: row.dayOfMonth,
          autoPost: row.autoPost,
          isActive: row.isActive,
          nextRunOn: row.nextRunOn,
          lastRunOn: row.lastRunOn,
          occurrenceCount: row.occurrenceCount,
          endsOn: row.endsOn,
        }))}
        drafts={drafts.map((row) => ({
          id: row.id,
          entryNumber: row.entryNumber,
          entryDate: row.entryDate,
          memo: row.memo,
          sourceType: row.sourceType,
        }))}
        accounts={accounts.map((row) => ({ id: row.id, number: row.number, name: row.name }))}
        canManage={can(actor, 'accounting:journal')}
        canClose={can(actor, 'accounting:close')}
      />
    </AppShell>
  )
}
