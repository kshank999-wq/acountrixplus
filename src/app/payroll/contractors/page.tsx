import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import {
  contractorPayments,
  DEFAULT_REPORTING_THRESHOLD_CENTS,
} from '@/modules/payroll/vendor-reporting'
import { payrollNav } from '../nav'
import { NoAccess, SecurityNotice, Stat } from '../ui'
import { currentYear } from '../period'
import { ContractorTable } from './table'

export const dynamic = 'force-dynamic'

/**
 * Contractor payment reporting (spec §13: "1099-related vendor data fields").
 *
 * Named for what it is rather than for a jurisdiction's form number. Producing
 * the figure needs the accounting records and this system has them; producing
 * the form is a compliance claim it has not earned, and spec §19 requires a
 * security review before tax filing is relied on in production.
 */
export default async function ContractorsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; all?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'tax:view')) return <NoAccess role={actor.role} what="Tax" />

  const params = await searchParams
  const year = Number(params.year) || currentYear()
  const includeAllVendors = params.all === '1'

  const report = await contractorPayments(actor, { year, includeAllVendors })

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll/contractors" />
      <SecurityNotice />

      <form className="card mb-4 flex flex-wrap items-end gap-3 p-3" method="get">
        <label className="text-xs text-muted">
          Calendar year
          <input
            className="field mt-1 w-32"
            type="number"
            name="year"
            defaultValue={year}
            min={2000}
            max={2100}
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-muted">
          <input type="checkbox" name="all" value="1" defaultChecked={includeAllVendors} />
          Show every vendor, including those under the threshold
        </label>
        <button className="btn text-xs" type="submit">
          Show the year
        </button>
      </form>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Reportable"
          value={String(report.reportableCount)}
          hint="flagged and over the threshold"
          accent
        />
        <Stat label="Paid to them" value={formatCents(report.totalReportableCents)} />
        <Stat
          label="Need attention"
          value={String(report.needsAttentionCount)}
          hint="something is stopping a filing"
          tone={report.needsAttentionCount > 0 ? 'bad' : undefined}
        />
        <Stat
          label="Threshold"
          value={formatCents(report.thresholdCents)}
          hint={
            report.thresholdCents === DEFAULT_REPORTING_THRESHOLD_CENTS
              ? 'the default — set yours if it differs'
              : 'set for this company'
          }
        />
      </div>

      <ContractorTable
        year={report.year}
        rows={report.rows}
        canManage={can(actor, 'tax:manage')}
      />

      <p className="mt-3 text-xs text-faint">
        Counted from payments actually made in {year}, not bills raised. A contractor is reported
        on what they were paid in the year, and an unpaid bill dated December belongs to next
        year’s report.
      </p>
    </AppShell>
  )
}
