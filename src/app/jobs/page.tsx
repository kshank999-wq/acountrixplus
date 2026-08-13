import Link from 'next/link'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { formatBasisPoints } from '@/modules/crm/analytics'
import { companyTerminology, moduleEnabled } from '@/modules/industry/modules'
import { wipSummary } from '@/modules/jobs/reports'
import { expiringDocuments } from '@/modules/jobs/compliance'
import { JOBS_NAV } from './nav'
import { Card, Empty, ModuleOff, NoAccess, Stat, Table, Variance } from './ui'

export const dynamic = 'force-dynamic'

/**
 * The WIP schedule (spec §5 "job costing", §13 reporting).
 *
 * The one report a contractor's accountant asks for and their accounting
 * software usually cannot produce. Every column comes from posted journal
 * lines, so it agrees with the profit & loss by construction rather than by
 * reconciliation.
 */
export default async function JobsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'jobs:view')) return <NoAccess role={actor.role} />
  if (!(await moduleEnabled(actor.companyId, 'job_costing'))) return <ModuleOff />

  const [summary, terms, expiring] = await Promise.all([
    wipSummary(actor),
    companyTerminology(actor.companyId),
    expiringDocuments(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="jobs"
    >
      <SubNav items={JOBS_NAV} active="/jobs" />

      {expiring.length > 0 && (
        <p className="card mb-4 border-warning/40 p-4 text-sm">
          <span className="font-medium text-warning">
            {expiring.length} subcontractor {expiring.length === 1 ? 'document' : 'documents'} need
            attention.
          </span>{' '}
          <Link href="/jobs/subcontractors" className="underline">
            Review compliance
          </Link>
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Contract value"
          value={formatCents(summary.contractValueCents)}
          hint="including approved change orders"
          accent
        />
        <Stat
          label="Cost to date"
          value={formatCents(summary.costToDateCents)}
          hint={`against ${formatCents(summary.revisedBudgetCents)} budgeted`}
        />
        <Stat label="Billed to date" value={formatCents(summary.billedToDateCents)} />
        <Stat
          label="Underbilled"
          value={formatCents(summary.costsInExcessCents)}
          hint="costs in excess of billings — an asset"
          tone={summary.costsInExcessCents > 0 ? 'bad' : undefined}
        />
        <Stat
          label="Overbilled"
          value={formatCents(summary.billingsInExcessCents)}
          hint="billings in excess of costs — a liability"
        />
      </div>

      <Card
        title={`${terms.job} work in progress`}
        subtitle="Percent complete is cost to date over revised budget. Earned revenue is contract value at that percentage."
      >
        {summary.jobs.length === 0 ? (
          <Empty>
            No open {terms.job.toLowerCase()}s. A won proposal creates one, or add it from the
            clients workspace.
          </Empty>
        ) : (
          <Table
            head={[
              terms.job,
              'Contract',
              'Budget',
              'Cost to date',
              '% complete',
              'Earned',
              'Billed',
              'Over / (under)',
            ]}
            rows={summary.jobs.map((job) => [
              <Link key={job.projectId} href={`/jobs/${job.projectId}`} className="underline">
                <span className="font-medium">{job.code}</span>{' '}
                <span className="text-muted">{job.name}</span>
              </Link>,
              formatCents(job.contractValueCents),
              formatCents(job.revisedBudgetCents),
              formatCents(job.costToDateCents),
              job.percentCompleteBp === null ? (
                <span className="text-faint" title="No budget, so completion cannot be computed.">
                  —
                </span>
              ) : (
                formatBasisPoints(job.percentCompleteBp)
              ),
              formatCents(job.earnedRevenueCents),
              formatCents(job.billedToDateCents),
              <Variance key="v" cents={job.overUnderBillingCents} format={formatCents} />,
            ])}
          />
        )}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Every figure above is a sum over posted journal lines carrying the job as a dimension —
        the same rows the trial balance reads. Job costing extends the ledger; it does not keep a
        second set of books.
      </p>
    </AppShell>
  )
}
