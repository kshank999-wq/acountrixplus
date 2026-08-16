import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  listDimensionValues,
  listDimensions,
  unassignedLines,
} from '@/modules/dimensions/service'
import { dimensionalProfitAndLoss } from '@/modules/dimensions/reporting'
import { listAccounts } from '@/modules/coa/service'
import { ACCOUNTING_NAV } from '../nav'
import { DimensionBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Accounting dimensions (spec §13).
 *
 * A restaurant with three sites, an agency with two departments, a nonprofit
 * with restricted funds. Projects and cost codes have covered jobs since
 * Phase 7; this is the other half of the sentence.
 */
export default async function DimensionsPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; from?: string; to?: string }>
}) {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Dimensions</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const params = await searchParams
  const today = new Date().toISOString().slice(0, 10)
  const startDate = params.from ?? `${today.slice(0, 4)}-01-01`
  const endDate = params.to ?? today

  const [dimensions, values, accounts] = await Promise.all([
    listDimensions(actor, { includeInactive: true }),
    listDimensionValues(actor, { includeInactive: true }),
    listAccounts(actor),
  ])

  const active = dimensions.filter((dimension) => dimension.isActive)
  const selected =
    active.find((dimension) => dimension.id === params.d) ?? active[0] ?? null

  // The report needs `reports:financial`; a bookkeeper can still set the
  // dimensions up without being able to read the profit and loss.
  const canReport = can(actor, 'reports:financial')

  const [report, unassigned] = selected
    ? await Promise.all([
        canReport
          ? dimensionalProfitAndLoss(actor, {
              dimensionId: selected.id,
              startDate,
              endDate,
            })
          : Promise.resolve(null),
        unassignedLines(actor, selected.id, { startDate, endDate, limit: 100 }),
      ])
    : [null, []]

  const accountNames = new Map(accounts.map((account) => [account.id, account]))

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/dimensions" />
      <DimensionBoard
        dimensions={dimensions}
        values={values}
        selectedId={selected?.id ?? null}
        startDate={startDate}
        endDate={endDate}
        report={report}
        unassigned={unassigned.map((line) => {
          const account = accountNames.get(line.accountId)
          return {
            journalLineId: line.journalLineId,
            entryNumber: line.entryNumber,
            entryDate: line.entryDate,
            accountLabel: account ? `${account.number} ${account.name}` : 'Unknown account',
            memo: line.memo,
            amountCents: line.debitCents - line.creditCents,
          }
        })}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
