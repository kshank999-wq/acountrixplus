import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listEmployees } from '@/modules/payroll/service'
import { payrollNav } from '../nav'
import { NoAccess, SecurityNotice } from '../ui'
import { Roster } from './roster'

export const dynamic = 'force-dynamic'

/** The people payroll is run for (spec §13). */
export default async function PeoplePage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'payroll:view')) return <NoAccess role={actor.role} what="Payroll" />

  const people = await listEmployees(actor)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll/people" />
      <SecurityNotice />

      <Roster
        people={people.map((person) => ({
          id: person.id,
          name: person.name,
          reference: person.reference,
          email: person.email,
          workerType: person.workerType,
          payBasis: person.payBasis,
          baseRateCents: person.baseRateCents,
          taxIdLast4: person.taxIdLast4,
          startDate: person.startDate,
          isActive: person.isActive,
        }))}
        canManage={can(actor, 'payroll:manage')}
      />
    </AppShell>
  )
}
