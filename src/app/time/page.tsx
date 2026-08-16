import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import {
  billablePeople,
  timesheet,
  unbilledWork,
  utilizationReport,
} from '@/modules/timebilling/service'
import { listRetainers } from '@/modules/timebilling/billing'
import { listProjects } from '@/modules/crm/conversion'
import { listCustomers } from '@/modules/receivables/service'
import { depositableAccounts } from '@/modules/banking/deposits'
import { TimeBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Time and billing (spec §5, Professional Services).
 *
 * One page for the loop that runs a services firm: log it, approve it, see
 * what is unbilled, bill it.
 */
export default async function TimePage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Time</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to time and billing.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'time_billing'))) {
    return (
      <AppShell actor={actor} companyName={session?.companyName ?? 'Accountrix Plus'} active="time">
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Time and billing is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-brand hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to keep timesheets, recover expenses, and bill from what was recorded.
          </p>
        </div>
      </AppShell>
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  const monthStart = `${today.slice(0, 7)}-01`

  const [rows, unbilled, people, projectList, customers, retainers, utilization, banks] =
    await Promise.all([
      timesheet(actor, { limit: 60 }),
      unbilledWork(actor),
      billablePeople(actor),
      listProjects(actor),
      listCustomers(actor),
      listRetainers(actor, { openOnly: true }),
      utilizationReport(actor, { from: monthStart, to: today }),
      depositableAccounts(actor),
    ])

  return (
    <AppShell actor={actor} companyName={session?.companyName ?? 'Accountrix Plus'} active="time">
      <TimeBoard
        today={today}
        rows={rows.map((row) => ({
          id: row.id,
          workedOn: row.workedOn,
          minutes: row.minutes,
          description: row.description,
          isBillable: row.isBillable,
          status: row.status,
          projectName: row.projectName,
          personName: row.personName,
        }))}
        unbilled={unbilled.map((row) => ({
          projectId: row.projectId,
          projectName: row.projectName,
          timeMinutes: row.timeMinutes,
          timeValueCents: row.timeValueCents,
          expenseCount: row.expenseCount,
          expenseValueCents: row.expenseValueCents,
          totalCents: row.totalCents,
          oldestDate: row.oldestDate,
        }))}
        utilization={utilization.map((row) => ({
          personName: row.personName,
          billableMinutes: row.billableMinutes,
          totalMinutes: row.totalMinutes,
          utilizationBasisPoints: row.utilizationBasisPoints,
        }))}
        projects={projectList.map((project) => ({ id: project.id, name: project.name }))}
        customers={customers.map((customer) => ({ id: customer.id, name: customer.name }))}
        retainers={retainers.map((retainer) => ({
          id: retainer.id,
          customerId: retainer.customerId,
          customerName: retainer.customerName,
          remainingCents: retainer.remainingCents,
        }))}
        banks={banks.map((bank) => ({ id: bank.id, name: bank.name }))}
        peopleCount={people.length}
        canApprove={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
