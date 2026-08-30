import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listVendors } from '@/modules/receivables/service'
import { subcontractorSummaries } from '@/modules/jobs/compliance'
import { JOBS_NAV } from '../nav'
import { ModuleOff, NoAccess } from '../ui'
import { ComplianceBoard } from './board'

export const dynamic = 'force-dynamic'

export default async function SubcontractorsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'jobs:view')) return <NoAccess role={actor.role} />
  if (!(await moduleEnabled(actor.companyId, 'job_costing'))) return <ModuleOff />

  const summaries = await subcontractorSummaries(actor)

  // Vendors not already tracked as subs, so the add form does not offer
  // somebody who is already on the list.
  const tracked = new Set(summaries.map((sub) => sub.vendorId))
  const vendors = can(actor, 'accounting:view')
    ? (await listVendors(actor)).filter((vendor) => !tracked.has(vendor.id))
    : []

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="jobs"
    >
      <SubNav items={JOBS_NAV} active="/jobs/subcontractors" />
      <ComplianceBoard
        subcontractors={summaries}
        vendors={vendors.map((vendor) => ({ id: vendor.id, name: vendor.name }))}
        canManage={can(actor, 'jobs:manage')}
        today={new Date().toISOString().slice(0, 10)}
      />
    </AppShell>
  )
}
