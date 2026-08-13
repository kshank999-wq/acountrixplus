import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listOpportunities, listOrganizations, stageCounts } from '@/modules/crm/opportunities'
import { CRM_NAV } from './nav'
import { PipelineBoard } from './pipeline-board'

export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'crm:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Clients &amp; Sales</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the CRM.
        </p>
      </main>
    )
  }

  const [opportunities, counts, organizations] = await Promise.all([
    listOpportunities(actor),
    stageCounts(actor),
    listOrganizations(actor, { limit: 500 }),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="crm"
    >
      <SubNav items={CRM_NAV} active="/crm" />
      <PipelineBoard
        opportunities={opportunities.map((o) => ({
          id: o.id,
          title: o.title,
          stage: o.stage,
          expectedValueCents: o.expectedValueCents,
          probability: o.probability,
          organizationName: o.organizationName,
          source: o.source,
          lossReason: o.lossReason,
        }))}
        counts={counts}
        organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
        canManage={can(actor, 'crm:manage')}
      />
    </AppShell>
  )
}
