import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { listFilings, workpaperPack } from '@/modules/payroll/workpapers'
import { payrollNav } from '../nav'
import { Card, Empty, ExceptionRow, NoAccess, SecurityNotice, Stat, Table } from '../ui'
import { currentQuarter } from '../period'
import { FilingPanel } from './filing'

export const dynamic = 'force-dynamic'

/**
 * The workpaper pack (spec §13: "tax-workpaper-friendly reports").
 *
 * What makes a report workpaper-friendly is not formatting. An accountant
 * needs the figures, the trail back to the transactions, and an honest account
 * of what is wrong with them. Most software gives the first two. The
 * exceptions list is the third, and it is why this page leads with it.
 */
export default async function WorkpapersPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'tax:view')) return <NoAccess role={actor.role} what="Tax" />
  if (!can(actor, 'reports:financial')) {
    return <NoAccess role={actor.role} what="Financial reports" />
  }

  const params = await searchParams
  const quarter = currentQuarter()
  const startDate = params.from ?? quarter.periodStart
  const endDate = params.to ?? quarter.periodEnd

  const [pack, filings] = await Promise.all([
    workpaperPack(actor, { startDate, endDate }),
    listFilings(actor, { limit: 25 }),
  ])

  const blockers = pack.exceptions.filter((entry) => entry.severity === 'blocker')
  const warnings = pack.exceptions.filter((entry) => entry.severity === 'warning')

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll/workpapers" />
      <SecurityNotice />

      <form className="card mb-4 flex flex-wrap items-end gap-2 p-3" method="get">
        <label className="text-xs text-muted">
          From
          <input className="field mt-1 w-40" type="date" name="from" defaultValue={startDate} />
        </label>
        <label className="text-xs text-muted">
          To
          <input className="field mt-1 w-40" type="date" name="to" defaultValue={endDate} />
        </label>
        <button className="btn text-xs" type="submit">
          Assemble the pack
        </button>
        <p className="ml-auto text-xs text-faint">Defaults to {quarter.label}.</p>
      </form>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Blockers"
          value={String(blockers.length)}
          hint="stop a filing until explained"
          tone={blockers.length > 0 ? 'bad' : 'good'}
        />
        <Stat label="Worth checking" value={String(warnings.length)} />
        <Stat
          label="Trial balance"
          value={pack.ledger.isBalanced ? 'Balanced' : 'Out'}
          tone={pack.ledger.isBalanced ? 'good' : 'bad'}
          hint={formatCents(pack.ledger.totalDebitCents)}
        />
        <Stat
          label="Net income"
          value={formatCents(pack.ledger.netIncomeCents)}
          hint="for the period"
          accent
        />
      </div>

      <Card
        title="What an accountant should look at first"
        subtitle="Found by assembling the pack, not by anybody reading it. An exception discovered in January under time pressure is the same exception — this just finds it earlier."
      >
        {pack.exceptions.length === 0 ? (
          <Empty>
            Nothing stood out. The trial balance foots, no payroll used illustrative figures, every
            sale carries a tax code, and every reportable contractor has an identifier on file.
          </Empty>
        ) : (
          <ul>
            {pack.exceptions.map((exception, index) => (
              <ExceptionRow
                key={`${exception.area}-${index}`}
                severity={exception.severity}
                area={exception.area}
                message={exception.message}
              />
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Payroll"
          subtitle={`${pack.payroll.runs} ${pack.payroll.runs === 1 ? 'run' : 'runs'} in the period`}
        >
          <Table
            head={['', 'Amount']}
            rows={[
              ['Gross pay', formatCents(pack.payroll.grossPayCents)],
              ['Tax withheld from pay', formatCents(pack.payroll.employeeWithholdingCents)],
              ['Other deductions withheld', formatCents(pack.payroll.employeeDeductionCents)],
              ['Employer taxes', formatCents(pack.payroll.employerTaxCents)],
              ['Net paid to people', formatCents(pack.payroll.netPayCents)],
              ['Total cost to the employer', formatCents(pack.payroll.totalCostCents)],
            ]}
          />
        </Card>

        <Card
          title="Sales tax"
          subtitle={`${pack.salesTax.lines.length} jurisdiction ${pack.salesTax.lines.length === 1 ? 'line' : 'lines'}`}
        >
          <Table
            head={['', 'Amount']}
            rows={[
              ['Taxable sales', formatCents(pack.salesTax.totalTaxableCents)],
              ['Exempt sales', formatCents(pack.salesTax.totalExemptCents)],
              ['Tax collected', formatCents(pack.salesTax.totalTaxCollectedCents)],
              ['In Sales Tax Payable', formatCents(pack.salesTax.ledgerBalanceCents)],
              ['Variance', formatCents(pack.salesTax.varianceCents)],
            ]}
          />
        </Card>

        <Card title="Liabilities at period end" subtitle="Straight from posted journal lines.">
          {pack.liabilities.length === 0 ? (
            <Empty>Nothing accrued.</Empty>
          ) : (
            <Table
              head={['Account', 'Accrued', 'Remitted', 'Owed']}
              rows={pack.liabilities.map((entry) => [
                `${entry.accountNumber} ${entry.accountName}`,
                formatCents(entry.accruedCents),
                formatCents(entry.remittedCents),
                formatCents(entry.balanceCents),
              ])}
            />
          )}
        </Card>

        <Card
          title="Contractors"
          subtitle={`${pack.contractors.reportableCount} reportable in ${pack.contractors.year}`}
        >
          <Table
            head={['', 'Amount']}
            rows={[
              ['Paid to reportable contractors', formatCents(pack.contractors.totalReportableCents)],
              ['Rows needing attention', String(pack.contractors.needsAttentionCount)],
              ['Remittances in the period', String(pack.remittances.count)],
              ['Remitted', formatCents(pack.remittances.totalCents)],
            ]}
          />
        </Card>
      </div>

      <div className="mt-4">
        <FilingPanel
          periodStart={startDate}
          periodEnd={endDate}
          blockerCount={blockers.length}
          canManage={can(actor, 'tax:manage')}
          jurisdictions={[...new Set(pack.salesTax.lines.map((line) => line.jurisdiction))]}
          filings={filings.map((filing) => ({
            id: filing.id,
            kind: filing.kind,
            jurisdiction: filing.jurisdiction,
            periodStart: filing.periodStart,
            periodEnd: filing.periodEnd,
            status: filing.status,
            filedOn: filing.filedOn,
            filedNote: filing.filedNote,
          }))}
        />
      </div>

      <p className="mt-3 text-xs text-faint">
        Assembled at {pack.preparedAt}. Every figure is read through the same report services the
        statements use rather than re-queried, so a workpaper and the statement it accompanies
        cannot disagree.
      </p>
    </AppShell>
  )
}
