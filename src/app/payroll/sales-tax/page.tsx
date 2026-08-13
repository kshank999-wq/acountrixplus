import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { listTaxCodes, salesTaxReturn } from '@/modules/payroll/sales-tax'
import { payrollNav } from '../nav'
import { Card, Empty, NoAccess, SecurityNotice, Stat, Table, Variance, formatRateBp } from '../ui'
import { currentQuarter } from '../period'
import { TaxCodes } from './codes'

export const dynamic = 'force-dynamic'

/**
 * The sales tax return (spec §13).
 *
 * Two things on this page are deliberate. Exempt sales are shown next to
 * taxable ones, because most returns ask for both. And the ledger balance sits
 * beside the period's collections rather than replacing them — they answer
 * different questions, and quietly showing one as the other is how a return
 * gets filed for the wrong amount.
 */
export default async function SalesTaxPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'tax:view')) return <NoAccess role={actor.role} what="Tax" />

  const params = await searchParams
  const quarter = currentQuarter()
  const periodStart = params.from ?? quarter.periodStart
  const periodEnd = params.to ?? quarter.periodEnd

  const [codes, report] = await Promise.all([
    listTaxCodes(actor),
    salesTaxReturn(actor, { periodStart, periodEnd }),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="payroll"
    >
      <SubNav items={payrollNav(actor)} active="/payroll/sales-tax" />
      <SecurityNotice />

      <form className="card mb-4 flex flex-wrap items-end gap-2 p-3" method="get">
        <label className="text-xs text-muted">
          From
          <input className="field mt-1 w-40" type="date" name="from" defaultValue={periodStart} />
        </label>
        <label className="text-xs text-muted">
          To
          <input className="field mt-1 w-40" type="date" name="to" defaultValue={periodEnd} />
        </label>
        <button className="btn text-xs" type="submit">
          Show the period
        </button>
        <p className="ml-auto text-xs text-faint">Defaults to {quarter.label}.</p>
      </form>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Tax collected"
          value={formatCents(report.totalTaxCollectedCents)}
          hint="on invoices issued in this period"
          accent
        />
        <Stat label="Taxable sales" value={formatCents(report.totalTaxableCents)} />
        <Stat
          label="Exempt sales"
          value={formatCents(report.totalExemptCents)}
          hint="most returns ask for this too"
        />
        <Stat
          label="In Sales Tax Payable"
          value={formatCents(report.ledgerBalanceCents)}
          hint={`as at ${periodEnd}, all periods`}
        />
      </div>

      {report.varianceCents !== 0 && report.totalTaxCollectedCents > 0 && (
        <p className="card mb-4 border-warning/40 p-4 text-sm">
          <span className="font-medium text-warning">
            Collected this period and the account balance differ by{' '}
            {formatCents(Math.abs(report.varianceCents))}.
          </span>{' '}
          That is not necessarily wrong — an earlier period may be unremitted — but it is the first
          thing to explain before filing.
        </p>
      )}

      {report.hasUncodedSales && (
        <p className="card mb-4 border-warning/40 p-4 text-sm">
          <span className="font-medium text-warning">
            {formatCents(report.uncodedSalesCents)} of invoiced sales carry no tax code
          </span>{' '}
          and so appear on no jurisdiction’s return. Usually a company that has not set codes up
          yet; occasionally a real gap.
        </p>
      )}

      <Card
        title="By jurisdiction"
        subtitle="The rate shown is the rate as applied when each invoice was raised. Changing a code's rate does not restate a past return."
      >
        {report.lines.length === 0 ? (
          <Empty>
            No tax was charged in this period. Add the codes you are registered for below, and
            invoices raised against them will appear here.
          </Empty>
        ) : (
          <Table
            head={['Jurisdiction', 'Code', 'Rate', 'Gross sales', 'Taxable', 'Exempt', 'Tax']}
            rows={report.lines.map((line) => [
              <span key={line.taxCodeId} className="font-medium">
                {line.jurisdiction}
              </span>,
              <span key="c" className="text-muted">
                {line.code} — {line.name}
              </span>,
              formatRateBp(line.rateBp),
              formatCents(line.grossSalesCents),
              formatCents(line.taxableCents),
              formatCents(line.exemptCents),
              formatCents(line.taxCollectedCents),
            ])}
          />
        )}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Variance against the ledger:{' '}
        <Variance cents={report.varianceCents} format={formatCents} />. Collected in the period
        minus what the account holds.
      </p>

      <div className="mt-4">
        <TaxCodes
          codes={codes.map((code) => ({
            id: code.id,
            code: code.code,
            name: code.name,
            jurisdiction: code.jurisdiction,
            rateBp: code.rateBp,
            isExempt: code.isExempt,
            isActive: code.isActive,
            effectiveFrom: code.effectiveFrom,
          }))}
          canManage={can(actor, 'tax:manage')}
        />
      </div>
    </AppShell>
  )
}
