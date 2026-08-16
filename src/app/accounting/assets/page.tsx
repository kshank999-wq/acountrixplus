import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  assetRegister,
  cashChartAccounts,
  depreciationDue,
  reconcileFixedAssets,
} from '@/modules/assets/service'
import { ACCOUNTING_NAV } from '../nav'
import { AssetBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The fixed asset register (spec §13).
 *
 * The screen leads with the reconciliation rather than the asset list, because
 * a register that disagrees with the ledger is the finding — and it is the one
 * thing no other report in the application can tell you.
 */
export default async function AssetsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Fixed assets</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  const [register, due, reconciliation, banks] = await Promise.all([
    assetRegister(actor, { includeDisposed: true }),
    depreciationDue(actor, { throughDate: today }),
    reconcileFixedAssets(actor, { asOf: today }),
    cashChartAccounts(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/assets" />
      <AssetBoard
        today={today}
        register={register.map((asset) => ({
          id: asset.id,
          tag: asset.tag,
          name: asset.name,
          category: asset.category,
          costCents: asset.costCents,
          accumulatedCents: asset.accumulatedCents,
          bookValueCents: asset.bookValueCents,
          method: asset.method,
          convention: asset.convention,
          lifeMonths: asset.lifeMonths,
          inServiceDate: asset.inServiceDate,
          status: asset.status,
          depreciatedThrough: asset.depreciatedThrough,
          disposedOn: asset.disposedOn,
        }))}
        due={due.map((row) => ({
          assetId: row.assetId,
          tag: row.tag,
          name: row.name,
          periodEnd: row.periodEnd,
          amountCents: row.amountCents,
        }))}
        reconciliation={reconciliation}
        banks={banks.map((account) => ({
          id: account.id,
          name: `${account.number} ${account.name}`,
        }))}
        canPost={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
