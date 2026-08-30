import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { aiAvailable } from '@/modules/ai/settings'
import { AI_NAV } from '../nav'
import { InsightsPanel } from './insights-panel'

export const dynamic = 'force-dynamic'

/**
 * Business insights in plain language (spec §11).
 *
 * Run on demand rather than on page load. An assistant that costs money every
 * time somebody opens a tab is a metered module spending its own ceiling on
 * navigation — the button is the consent.
 */
export default async function InsightsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'reports:view') || !can(actor, 'ai:use')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Business insights</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include financial reporting.
        </p>
      </main>
    )
  }

  const enabled = await aiAvailable(actor)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="ai"
    >
      <SubNav items={AI_NAV} active="/ai/insights" />
      <InsightsPanel enabled={enabled} />
    </AppShell>
  )
}
