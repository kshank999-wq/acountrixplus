import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies } from '@/db/schema'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { SETTINGS_NAV } from '../nav'
import { industryPack } from '@/modules/coa/industry'
import {
  IMPLEMENTED_MODULES,
  MODULE_DESCRIPTIONS,
  MODULE_LABELS,
  moduleStates,
  terminologyFor,
} from '@/modules/industry/modules'
import { ModuleToggles } from './toggles'

export const dynamic = 'force-dynamic'

/**
 * Industry module settings (spec §5, §23).
 *
 * The page exists to make one point visible: the industry chosen at signup is
 * a *default*, not a category the company is stuck in. Every module can be
 * switched on or off regardless of pack, and none of them changes the
 * accounting — which is why this page sits in settings rather than being a
 * choice buried in onboarding.
 */
export default async function ModuleSettingsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'company:manage')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Modules</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include managing company settings.
        </p>
      </main>
    )
  }

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, actor.companyId))
    .limit(1)

  const states = await moduleStates(actor.companyId)
  const pack = industryPack(company.industry)
  const terms = terminologyFor(company.industry)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="bookkeeping"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/modules" />

      <div className="mx-auto max-w-3xl space-y-4">
        <header>
          {/* h2: the shell already owns the page's h1 (the company name). */}
          <h2 className="text-lg font-semibold">Industry modules</h2>
          <p className="mt-1 text-sm text-muted">
            This company is set up as <span className="font-medium text-ink">{pack.label}</span>,
            which switches some modules on by default. You can change any of them: industry is a
            starting point, not a category you are locked into.
          </p>
        </header>

        <div className="card p-4 text-sm">
          <p className="font-medium">A module never changes the accounting.</p>
          <p className="mt-1 text-muted">
            Modules add workspaces, dimensions, and workflows on top of the same double-entry
            ledger every company on Accountrix Plus uses. Switching job costing on does not create
            a second set of books — it adds a job and cost-code dimension to journal lines that
            were always going to be posted anyway. Your profit &amp; loss stays comparable with any
            other company&rsquo;s.
          </p>
          <p className="mt-2 text-xs text-faint">
            This company&rsquo;s vocabulary: a client is a &ldquo;{terms.customer}&rdquo;, a
            project is a &ldquo;{terms.job}&rdquo;. Only the words change — the records are the
            same ones every company keeps.
          </p>
        </div>

        <ModuleToggles
          modules={states.map((state) => ({
            key: state.key,
            label: MODULE_LABELS[state.key],
            description: MODULE_DESCRIPTIONS[state.key],
            enabled: state.enabled,
            packDefault: state.packDefault,
            overridden: state.overridden,
            implemented: IMPLEMENTED_MODULES.includes(state.key),
          }))}
        />
      </div>
    </AppShell>
  )
}
