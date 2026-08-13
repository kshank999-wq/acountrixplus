import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { requireActor, currentSession } from '@/lib/current-user'
import { can, scoped } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { formatBasisPoints } from '@/modules/crm/analytics'
import { companyTerminology, moduleEnabled } from '@/modules/industry/modules'
import { listAccounts } from '@/modules/coa/service'
import { listCostCodes } from '@/modules/jobs/cost-codes'
import { listChangeOrders } from '@/modules/jobs/budgets'
import { jobCostByCode, jobCostDetail, workInProgress } from '@/modules/jobs/reports'
import {
  billableCustomers,
  billedByItem,
  listProgressBillings,
  retainageHeld,
  scheduleFor,
} from '@/modules/jobs/billing'
import { JOBS_NAV } from '../nav'
import { Card, Empty, ModuleOff, NoAccess, Stat, Table } from '../ui'
import { JobPanels } from './panels'

export const dynamic = 'force-dynamic'

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'jobs:view')) return <NoAccess role={actor.role} />
  if (!(await moduleEnabled(actor.companyId, 'job_costing'))) return <ModuleOff />

  const [job] = await db
    .select()
    .from(projects)
    .where(scoped(actor, projects, eq(projects.id, id)))
    .limit(1)

  if (!job) notFound()

  const [
    terms,
    costRows,
    changeOrders,
    sov,
    applications,
    costCodes,
    accounts,
    customers,
    held,
    wip,
    detail,
  ] = await Promise.all([
    companyTerminology(actor.companyId),
    jobCostByCode(actor, id),
    listChangeOrders(actor, id),
    scheduleFor(actor, id),
    listProgressBillings(actor, id),
    listCostCodes(actor, { activeOnly: true }),
    listAccounts(actor, { activeOnly: true }),
    billableCustomers(actor),
    retainageHeld(actor, id),
    workInProgress(actor, { projectId: id, includeComplete: true }),
    jobCostDetail(actor, id, { limit: 100 }),
  ])

  const financials = wip[0]

  // Billed per contract item, so the schedule of values shows progress without
  // the panel having to re-derive it from the applications.
  const sovBilled = await billedByItem(actor, id)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="jobs"
    >
      <SubNav items={JOBS_NAV} active="/jobs" />

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          {/* h2, not h1: the app shell's h1 is the company name, and a page
              with two top-level headings reads badly to a screen reader. */}
          <h2 className="text-lg font-semibold">
            {job.code} <span className="font-normal text-muted">{job.name}</span>
          </h2>
          <p className="text-xs text-muted">
            {terms.job} · {job.status.replace('_', ' ')}
            {job.startDate ? ` · started ${job.startDate}` : ''}
          </p>
        </div>
        <Link href="/jobs" className="btn text-xs">
          Back to WIP
        </Link>
      </div>

      {financials && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat
            label="Contract value"
            value={formatCents(financials.contractValueCents)}
            hint="including approved change orders"
            accent
          />
          <Stat
            label="Revised budget"
            value={formatCents(financials.revisedBudgetCents)}
            hint={
              financials.originalBudgetCents === financials.revisedBudgetCents
                ? 'unchanged from the estimate'
                : `originally ${formatCents(financials.originalBudgetCents)}`
            }
          />
          <Stat
            label="Cost to date"
            value={formatCents(financials.costToDateCents)}
            hint={
              financials.percentCompleteBp === null
                ? 'no budget set'
                : `${formatBasisPoints(financials.percentCompleteBp)} complete`
            }
          />
          <Stat
            label="Billed to date"
            value={formatCents(financials.billedToDateCents)}
            hint={`${formatCents(held)} held in retainage`}
          />
          <Stat
            label={financials.overUnderBillingCents >= 0 ? 'Overbilled' : 'Underbilled'}
            value={formatCents(Math.abs(financials.overUnderBillingCents))}
            hint={
              financials.overUnderBillingCents >= 0
                ? 'billed ahead of work done'
                : 'work done ahead of billing'
            }
            tone={financials.overUnderBillingCents < 0 ? 'bad' : undefined}
          />
        </div>
      )}

      <JobPanels
        projectId={id}
        terms={{ job: terms.job, customer: terms.customer }}
        canManage={can(actor, 'jobs:manage')}
        budget={costRows}
        changeOrders={changeOrders.map((order) => ({
          id: order.id,
          number: order.number,
          title: order.title,
          status: order.status,
          contractAmountCents: order.contractAmountCents,
          costAmountCents: order.costAmountCents,
          decidedOn: order.decidedOn,
        }))}
        sov={sov.map((item) => ({
          id: item.id,
          itemNumber: item.itemNumber,
          description: item.description,
          scheduledValueCents: item.scheduledValueCents,
          chartAccountId: item.chartAccountId,
          billedCents: sovBilled.get(item.id) ?? 0,
        }))}
        applications={applications.map((row) => ({
          id: row.id,
          applicationNumber: row.applicationNumber,
          billingDate: row.billingDate,
          thisPeriodCents: row.thisPeriodCents,
          retainedCents: row.retainedCents,
          netDueCents: row.netDueCents,
          isRetainageRelease: row.isRetainageRelease,
          invoiceNumber: row.invoiceNumber,
          invoiceBalanceCents: row.invoiceBalanceCents,
        }))}
        costCodes={costCodes.map((code) => ({
          id: code.id,
          code: code.code,
          name: code.name,
        }))}
        revenueAccounts={accounts
          .filter((account) => account.type === 'revenue')
          .map((account) => ({ id: account.id, number: account.number, name: account.name }))}
        customers={customers}
        retainageHeldCents={held}
        defaultRetainageBp={1000}
      />

      <div className="mt-4">
        <Card
          title="Ledger detail"
          subtitle="Every posted line carrying this job. The budget report above is these rows, grouped."
        >
          {detail.length === 0 ? (
            <Empty>Nothing has posted to this {terms.job.toLowerCase()} yet.</Empty>
          ) : (
            <Table
              head={['Date', 'Entry', 'Account', 'Memo', 'Debit', 'Credit']}
              rows={detail.slice(0, 50).map((line) => [
                line.entryDate,
                `#${line.entryNumber}`,
                `${line.accountNumber} ${line.accountName}`,
                line.memo ?? '',
                line.debitCents === 0 ? '' : formatCents(line.debitCents),
                line.creditCents === 0 ? '' : formatCents(line.creditCents),
              ])}
            />
          )}
        </Card>
      </div>
    </AppShell>
  )
}
