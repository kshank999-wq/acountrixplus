import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  assetRegister,
  cashChartAccounts,
  depreciationDue,
  reconcileFixedAssets,
} from '@/modules/assets/service'
import { evidenceForMany } from '@/modules/evidence/service'
import { notesForMany } from '@/modules/evidence/notes'
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
  const session = await requireSession()

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

  // Two queries for the whole register rather than two per asset. The
  // paperwork behind a purchase — the invoice, the finance agreement — is the
  // thing an auditor asks for first, so it belongs on this page and not behind
  // a click that loads it one asset at a time.
  const assetIds = register.map((asset) => asset.id)
  const [paperwork, notes] = await Promise.all([
    evidenceForMany(actor, 'fixed_asset', assetIds),
    notesForMany(actor, 'fixed_asset', assetIds),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
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
        evidence={Object.fromEntries(
          assetIds.map((id) => [
            id,
            (paperwork.get(id) ?? []).map((item) => ({
              documentId: item.documentId,
              filename: item.filename,
              contentType: item.contentType,
              sizeBytes: item.sizeBytes,
              uploadedByName: item.uploadedByName,
            })),
          ]),
        )}
        notes={Object.fromEntries(
          assetIds.map((id) => [
            id,
            (notes.get(id) ?? []).map((note) => ({
              id: note.id,
              body: note.body,
              isQuestion: note.isQuestion,
              authorName: note.authorName,
              createdAt: note.createdAt.toISOString().slice(0, 10),
              resolved: note.resolvedAt !== null,
            })),
          ]),
        )}
        canPost={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
