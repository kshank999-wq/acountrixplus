import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listAccounts } from '@/modules/coa/service'
import { listCostCodes } from '@/modules/jobs/cost-codes'
import { JOBS_NAV } from '../nav'
import { ModuleOff, NoAccess } from '../ui'
import { CostCodeLibrary } from './library'

export const dynamic = 'force-dynamic'

export default async function CostCodesPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'jobs:view')) return <NoAccess role={actor.role} />
  if (!(await moduleEnabled(actor.companyId, 'job_costing'))) return <ModuleOff />

  const [codes, accounts] = await Promise.all([
    listCostCodes(actor),
    listAccounts(actor, { activeOnly: true }),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="jobs"
    >
      <SubNav items={JOBS_NAV} active="/jobs/cost-codes" />
      <CostCodeLibrary
        codes={codes.map((code) => ({
          id: code.id,
          code: code.code,
          name: code.name,
          division: code.division,
          costType: code.costType,
          isActive: code.isActive,
        }))}
        accounts={accounts
          .filter((account) => ['cogs', 'expense'].includes(account.type))
          .map((account) => ({ id: account.id, number: account.number, name: account.name }))}
        canManage={can(actor, 'jobs:manage')}
      />
    </AppShell>
  )
}
