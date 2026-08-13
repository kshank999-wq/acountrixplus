import Link from 'next/link'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { listPayrollRuns, payrollSummary } from '@/modules/payroll/service'
import { liabilityPositions } from '@/modules/payroll/remittance'
import { getPayrollProvider, payrollProviderStatus } from '@/modules/payroll/provider'
import { payrollNav } from './nav'
import { Card, Empty, IllustrativeBadge, NoAccess, SecurityNotice, Stat, Table } from './ui'
import { yearToDate } from './period'

export const dynamic = 'force-dynamic'

/**
 * The payroll overview (spec §13, §20).
 *
 * Leads with cost to the employer rather than gross pay. Gross is what people
 * ask for and it is the wrong number to plan against — the employer's own
 * taxes are real money that never appears on a payslip, and a business that
 * budgets off gross is short by them every month.
 */
export default async function PayrollPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'payroll:view')) return <NoAccess role={actor.role} what="Payroll" />

  const period = yearToDate()

  const [summary, runs, liabilities] = await Promise.all([
    payrollSummary(actor, period),
    listPayrollRuns(actor, { limit: 12 }),
    can(actor, 'tax:view')
      ? liabilityPositions(actor, { asOfDate: period.endDate, kind: 'payroll' })
      : Promise.resolve([]),
  ])

  const provider = getPayrollProvider()
  const owed = liabilities.reduce((sum, entry) => sum + entry.balanceCents, 0)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll" />
      <SecurityNotice />

      {summary.illustrativeRuns > 0 && (
        <p className="card mb-4 border-negative/40 p-4 text-sm">
          <span className="font-medium text-negative">
            {summary.illustrativeRuns} of {summary.runs} runs this year used illustrative figures.
          </span>{' '}
          Those amounts come from invented flat rates and are not anybody’s real withholding. They
          are included below because they are posted to the ledger, and they will block a filing
          until they are voided and re-entered from a payroll report.
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="Cost to the employer"
          value={formatCents(summary.totalCostCents)}
          hint="gross plus the employer’s own taxes"
          accent
        />
        <Stat label="Gross pay" value={formatCents(summary.grossPayCents)} hint="year to date" />
        <Stat
          label="Employer taxes"
          value={formatCents(summary.employerTaxCents)}
          hint="never appears on a payslip"
        />
        <Stat
          label="Net paid to people"
          value={formatCents(summary.netPayCents)}
          hint={`after ${formatCents(summary.employeeWithholdingCents + summary.employeeDeductionCents)} withheld`}
        />
        <Stat
          label="Owed to agencies"
          value={formatCents(owed)}
          hint="withheld and accrued, not yet remitted"
          tone={owed > 0 ? 'bad' : undefined}
        />
      </div>

      <Card
        title="Payroll runs"
        subtitle="Each one posted a single balanced journal entry. Voiding reverses that entry rather than deleting it."
        action={
          can(actor, 'payroll:run') ? (
            <Link href="/payroll/run" className="btn text-xs">
              Run payroll
            </Link>
          ) : undefined
        }
      >
        {runs.length === 0 ? (
          <Empty>
            No payroll has been run. Enter the figures from your payroll bureau’s report and this
            will post the entry for them.
          </Empty>
        ) : (
          <Table
            head={['Run', 'Pay date', 'Gross', 'Withheld', 'Employer tax', 'Net pay', 'Source']}
            rows={runs.map((entry) => [
              <span key={entry.id} className="flex items-center gap-2">
                <span className={`font-medium ${entry.status === 'void' ? 'line-through text-faint' : ''}`}>
                  {entry.reference}
                </span>
                {entry.isIllustrative && <IllustrativeBadge />}
                {entry.status === 'void' && <span className="text-xs text-faint">void</span>}
              </span>,
              entry.payDate,
              formatCents(entry.grossPayCents),
              formatCents(entry.employeeWithholdingCents + entry.employeeDeductionCents),
              formatCents(entry.employerTaxCents),
              formatCents(entry.netPayCents),
              <span key="s" className="text-xs text-muted">
                {entry.sourceProvider}
                {entry.sourceReference ? ` · ${entry.sourceReference}` : ''}
              </span>,
            ])}
          />
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Where the figures come from"
          subtitle="Recorded on every run, never inferred afterwards."
        >
          <ul className="divide-y divide-line text-sm">
            {payrollProviderStatus().map((entry) => (
              <li key={entry.key} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium">
                    {entry.key}
                    {entry.key === provider.key && (
                      <span className="ml-2 chip bg-brand/15 px-2 py-0.5 text-[11px] text-brand">
                        in use
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">{entry.label}</p>
                </div>
                <span className="shrink-0 text-xs text-faint">
                  {entry.calculates ? 'calculates' : 'records only'}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-4 py-3 text-xs text-faint">
            Set with <code>PAYROLL_PROVIDER</code>. There is no fallback: an unrecognised value
            throws rather than quietly substituting a different source of payroll figures.
          </p>
        </Card>

        {can(actor, 'tax:view') && (
          <Card
            title="Payroll liabilities"
            subtitle="Read from the ledger, not from the runs — the same place the balance sheet reads."
            action={
              can(actor, 'tax:manage') ? (
                <Link href="/payroll/liabilities" className="btn text-xs">
                  Remit
                </Link>
              ) : undefined
            }
          >
            {liabilities.length === 0 ? (
              <Empty>Nothing accrued yet.</Empty>
            ) : (
              <Table
                head={['Account', 'Accrued', 'Remitted', 'Owed']}
                rows={liabilities.map((entry) => [
                  <span key={entry.accountId}>
                    <span className="font-medium">{entry.accountNumber}</span>{' '}
                    <span className="text-muted">{entry.accountName}</span>
                  </span>,
                  formatCents(entry.accruedCents),
                  formatCents(entry.remittedCents),
                  formatCents(entry.balanceCents),
                ])}
              />
            )}
          </Card>
        )}
      </div>
    </AppShell>
  )
}
