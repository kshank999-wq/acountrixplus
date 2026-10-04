import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  EXCLUDED_DESTINATIONS,
  EXPORT_DESTINATIONS,
  mayExportTo,
  offerableDestinations,
} from '@/modules/exporter/destinations'
import { TAX_CLASSIFICATIONS } from '@/modules/exporter/entity'
import { companyProfile } from '@/modules/exporter/entity'
import { exportHistory } from '@/modules/exporter/service'
import { gapNote, packageGaps } from '@/modules/exporter/sections'
import { ACCOUNTING_NAV } from '../nav'
import { ExportPanel } from './export-panel'

export const dynamic = 'force-dynamic'

/**
 * The accountant portal's export screen (Exporter spec §9, Phase 158).
 *
 * The screen the engine would otherwise have no caller for. It carries three
 * things a firm needs before pressing anything: which destinations exist and
 * which do not, what the package will and will not contain, and the log of what
 * has been exported before.
 *
 * The excluded products are **not** listed. §15's first acceptance criterion is
 * that *"direct competitor bookkeeping products are not presented as export
 * destinations"*, and a section headed "we will not export to these" presents
 * them — in the place somebody is looking for a destination, which is the worst
 * place to put a list of things that are not one. The refusal exists for anybody
 * who asks by key, and `EXCLUDED_DESTINATIONS` is read here only to say how many
 * decisions stand behind the engine.
 */
export default async function ExportPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'reports:financial')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Export to professional software</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to financial reports, and this screen
          sends the whole ledger out in a firm&apos;s format.
        </p>
      </main>
    )
  }

  const [profile, history] = await Promise.all([companyProfile(actor), exportHistory(actor, 20)])

  const now = new Date()
  const year = now.getUTCFullYear()

  const planned = EXPORT_DESTINATIONS.filter(
    (destination) => destination.integration === 'unresearched',
  ).map((destination) => {
    const verdict = mayExportTo(destination.key)
    return {
      key: destination.key,
      product: `${destination.vendor} ${destination.product}`,
      why: verdict.ok ? '' : verdict.why,
    }
  })

  return (
    <AppShell actor={actor} companyName={session.companyName} active="accounting">
      <SubNav items={ACCOUNTING_NAV} active="/accounting/export" />

      <div className="mt-4 space-y-6">
        <header>
          <h1 className="text-lg font-semibold">Export to professional software</h1>
          <p className="mt-1 max-w-3xl text-xs text-muted">
            Prepares this client&apos;s books for the tax, audit, trial-balance and workpaper
            systems a firm uses. The books are checked before anything is generated, and every
            export — including one that is held — is recorded.
          </p>
        </header>

        <ExportPanel
          destinations={offerableDestinations().map((destination) => ({
            key: destination.key,
            product: destination.product,
            vendor: destination.vendor,
            use: destination.use,
          }))}
          planned={planned}
          classifications={TAX_CLASSIFICATIONS.map((classification) => ({
            key: classification.key,
            label: classification.label,
            filesAs: classification.filesAs,
          }))}
          classification={profile.classification?.key ?? null}
          defaultStart={`${year}-01-01`}
          defaultEnd={now.toISOString().slice(0, 10)}
        />

        <section className="rounded border bg-white p-4">
          <h2 className="text-sm font-semibold">What a package contains</h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-600">{gapNote()}</p>
          <ul className="mt-3 space-y-2 text-xs text-slate-700">
            {packageGaps().map((gap) => (
              <li key={gap.key}>
                <span className="font-medium">{gap.item}</span> — {gap.because}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded border bg-white p-4">
          <h2 className="text-sm font-semibold">Export history</h2>
          <p className="mt-1 text-xs text-slate-600">
            Who exported what, where to, for which period, and with which adapter version. A held
            export is here too, with the reason — the row that answers &ldquo;did anybody
            try&rdquo;.
          </p>

          {history.length === 0 ? (
            <p className="mt-3 text-xs text-muted">Nothing has been exported yet.</p>
          ) : (
            <table className="mt-3 w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1">When</th>
                  <th className="py-1">Destination</th>
                  <th className="py-1">Period</th>
                  <th className="py-1">Adapter</th>
                  <th className="py-1">Result</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="py-1">{row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td className="py-1">{row.destinationKey}</td>
                    <td className="py-1">
                      {row.periodStart} to {row.periodEnd}
                    </td>
                    <td className="py-1">{row.adapterVersion}</td>
                    <td className="py-1">
                      {row.result === 'generated'
                        ? `${row.fileCount} files (${row.readiness})`
                        : `held — ${row.exceptionCount} exception${row.exceptionCount === 1 ? '' : 's'}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="text-xs text-muted">
          {EXCLUDED_DESTINATIONS.length} owner-facing bookkeeping products are deliberately not
          export destinations. Accountrix Plus can read books <em>in</em> from them; sending a
          client&apos;s books out to one would be building the way off this platform as a feature of
          it.
        </p>
      </div>
    </AppShell>
  )
}
