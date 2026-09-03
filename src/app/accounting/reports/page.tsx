import { Fragment } from 'react'
import { requireActor, requireSession } from '@/lib/current-user'
import { can, type ActorContext } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { trialBalance } from '@/modules/ledger/balances'
import { controlAccounts } from '@/modules/ledger/receivables-check'
import { apAging, arAging, balanceSheet, profitAndLoss } from '@/modules/ledger/reports'
import { BUCKETS, creditNote, foreignNote } from '@/modules/ledger/aging'
import {
  BASIS_DESCRIPTIONS,
  BASIS_LABELS,
  cashBasisCaveats,
  isReportingBasis,
  type ReportingBasis,
} from '@/modules/ledger/cash-basis'
import { cashFlowStatement } from '@/modules/ledger/cash-flow'
import {
  COMPARISON_LABELS,
  comparativeBalanceSheet,
  comparativeProfitAndLoss,
  comparisonWindows,
  type ComparisonKind,
} from '@/modules/ledger/comparative'
import { ACCOUNTING_NAV } from '../nav'
import { ReportPicker } from './report-picker'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  report?: string
  start?: string
  end?: string
  basis?: string
  compare?: string
}>

/** Sensible default range: the current calendar year to date. */
function defaultRange() {
  const now = new Date()
  const year = now.getUTCFullYear()
  return {
    start: `${year}-01-01`,
    end: now.toISOString().slice(0, 10),
  }
}

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requireActor()
  const session = await requireSession()
  const params = await searchParams

  if (!can(actor, 'accounting:view')) {
    return <NoAccess role={actor.role} />
  }

  const defaults = defaultRange()
  const start = params.start || defaults.start
  const end = params.end || defaults.end
  const report = params.report ?? 'trial_balance'
  const basis: ReportingBasis = isReportingBasis(params.basis) ? params.basis : 'accrual'
  const compare: ComparisonKind =
    params.compare === 'prior_year' || params.compare === 'year_to_date_prior_year'
      ? params.compare
      : 'prior_period'

  const canSeeStatements = can(actor, 'reports:financial')

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/reports" />
      <ReportPicker
        report={report}
        start={start}
        end={end}
        basis={basis}
        compare={compare}
        canSeeStatements={canSeeStatements}
      />

      <div className="mt-4">
        {report === 'trial_balance' && <TrialBalanceReport actor={actor} start={start} end={end} />}
        {report === 'profit_loss' && canSeeStatements && (
          <ProfitLossReport actor={actor} start={start} end={end} basis={basis} />
        )}
        {report === 'balance_sheet' && canSeeStatements && (
          <BalanceSheetReport actor={actor} end={end} basis={basis} />
        )}
        {report === 'cash_flow' && canSeeStatements && (
          <CashFlowReport actor={actor} start={start} end={end} />
        )}
        {report === 'comparative' && canSeeStatements && (
          <ComparativeReport actor={actor} start={start} end={end} basis={basis} compare={compare} />
        )}
        {report === 'comparative_bs' && canSeeStatements && (
          <ComparativeBalanceSheetReport
            actor={actor}
            start={start}
            end={end}
            basis={basis}
            compare={compare}
          />
        )}
        {report === 'ar_aging' && <AgingReport actor={actor} end={end} kind="ar" />}
        {report === 'ap_aging' && <AgingReport actor={actor} end={end} kind="ap" />}
        {report === 'control_accounts' && <ControlAccounts actor={actor} end={end} />}
      </div>
    </AppShell>
  )
}

function NoAccess({ role }: { role: string }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold">Accounting</h1>
      <p className="mt-2 text-sm text-muted">
        Your role ({role}) does not include access to the accounting workspace.
      </p>
    </main>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

async function TrialBalanceReport({
  actor,
  start,
  end,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  start: string
  end: string
}) {
  const tb = await trialBalance(actor, { startDate: start, endDate: end })

  return (
    <Card title="Trial balance" subtitle={`${start} to ${end}`}>
      <table className="w-full text-sm">
        <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Account</th>
            <th className="px-4 py-2 text-right font-medium">Debit</th>
            <th className="px-4 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {tb.rows.map((row) => (
            <tr key={row.chartAccountId} className="border-t border-line">
              <td className="px-4 py-1.5">
                <span className="tnum text-faint">{row.number}</span> {row.name}
              </td>
              <td className="tnum px-4 py-1.5 text-right">
                {row.debitCents ? formatCents(row.debitCents) : ''}
              </td>
              <td className="tnum px-4 py-1.5 text-right">
                {row.creditCents ? formatCents(row.creditCents) : ''}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-line font-semibold">
            <td className="px-4 py-2">Total</td>
            <td className="tnum px-4 py-2 text-right">{formatCents(tb.totalDebitCents)}</td>
            <td className="tnum px-4 py-2 text-right">{formatCents(tb.totalCreditCents)}</td>
          </tr>
        </tbody>
      </table>

      <p
        className={`px-4 py-3 text-xs ${tb.isBalanced ? 'text-positive' : 'text-negative'}`}
      >
        {tb.isBalanced
          ? 'Debits equal credits. The ledger is in balance.'
          : `Out of balance by ${formatCents(tb.totalDebitCents - tb.totalCreditCents)}. This should never happen — every entry is validated on the way in.`}
      </p>
    </Card>
  )
}

async function ProfitLossReport({
  actor,
  start,
  end,
  basis,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  start: string
  end: string
  basis: ReportingBasis
}) {
  const [pl, caveats] = await Promise.all([
    profitAndLoss(actor, { startDate: start, endDate: end, basis }),
    basis === 'cash'
      ? cashBasisCaveats(actor, { startDate: start, endDate: end })
      : Promise.resolve([]),
  ])

  const blocks = [
    pl.revenue,
    pl.costOfSales,
    pl.operatingExpenses,
    pl.otherIncome,
    pl.otherExpenses,
  ].filter((block) => block.rows.length > 0)

  return (
    <Card
      title={`Profit and loss — ${BASIS_LABELS[pl.basis].toLowerCase()} basis`}
      subtitle={`${start} to ${end}. ${BASIS_DESCRIPTIONS[pl.basis]}`}
    >
      <table className="w-full text-sm">
        <tbody>
          {blocks.map((block) => (
            // The key belongs on the fragment, not the first row inside it.
            <Fragment key={block.title}>
              <tr className="border-t border-line bg-raised/40">
                <td className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  {block.title}
                </td>
                <td />
              </tr>
              {block.rows.map((row) => (
                <tr key={row.chartAccountId} className="border-t border-line">
                  <td className="px-4 py-1.5 pl-8">
                    <span className="tnum text-faint">{row.number}</span> {row.name}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(row.balanceCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-line font-medium">
                <td className="px-4 py-1.5 pl-8">Total {block.title.toLowerCase()}</td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(block.totalCents)}</td>
              </tr>
            </Fragment>
          ))}

          <SummaryRow label="Gross profit" cents={pl.grossProfitCents} />
          <SummaryRow label="Operating income" cents={pl.operatingIncomeCents} />
          <SummaryRow label="Net income" cents={pl.netIncomeCents} emphasis />
        </tbody>
      </table>

      {caveats.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="text-xs font-medium text-warning">
            What a cash-basis report of these books cannot represent
          </p>
          <ul className="mt-1 space-y-1">
            {caveats.map((caveat) => (
              <li key={caveat.area} className="text-xs text-muted">
                <span className="font-medium">{caveat.area}:</span> {caveat.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

function SummaryRow({
  label,
  cents,
  emphasis,
}: {
  label: string
  cents: number
  emphasis?: boolean
}) {
  return (
    <tr className={`border-t-2 border-line ${emphasis ? 'text-base font-semibold' : 'font-medium'}`}>
      <td className="px-4 py-2">{label}</td>
      <td
        className={`tnum px-4 py-2 text-right ${cents < 0 ? 'text-negative' : emphasis ? 'text-positive' : ''}`}
      >
        {formatCents(cents)}
      </td>
    </tr>
  )
}

async function BalanceSheetReport({
  actor,
  end,
  basis,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  end: string
  basis: ReportingBasis
}) {
  const bs = await balanceSheet(actor, { asOfDate: end, basis })

  return (
    <Card
      title={`Balance sheet — ${BASIS_LABELS[bs.basis].toLowerCase()} basis`}
      subtitle={
        bs.basis === 'cash'
          ? `As of ${end}. Receivables and payables are absent by definition, not by omission.`
          : `As of ${end}`
      }
    >
      <table className="w-full text-sm">
        <tbody>
          {/* Assets subtotal IS the grand total, so it carries the emphasis
              rather than being repeated as a separate summary row. */}
          <SectionBlock
            title="Assets"
            rows={bs.assets.rows}
            total={bs.assets.totalCents}
            emphasizeTotal
          />
          <SectionBlock
            title="Liabilities"
            rows={bs.liabilities.rows}
            total={bs.liabilities.totalCents}
          />

          <tr className="border-t border-line bg-raised/40">
            <td className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              Equity
            </td>
            <td />
          </tr>
          {bs.equity.rows.map((row) => (
            <tr key={row.chartAccountId} className="border-t border-line">
              <td className="px-4 py-1.5 pl-8">
                <span className="tnum text-faint">{row.number}</span> {row.name}
              </td>
              <td className="tnum px-4 py-1.5 text-right">{formatCents(row.balanceCents)}</td>
            </tr>
          ))}
          <tr className="border-t border-line">
            <td className="px-4 py-1.5 pl-8">
              Net income for the period
              <span className="ml-1 text-xs text-faint">(not yet closed to retained earnings)</span>
            </td>
            <td className="tnum px-4 py-1.5 text-right">{formatCents(bs.netIncomeCents)}</td>
          </tr>
          <tr className="border-t border-line font-medium">
            <td className="px-4 py-1.5 pl-8">Total equity</td>
            <td className="tnum px-4 py-1.5 text-right">
              {formatCents(bs.equity.totalCents + bs.netIncomeCents)}
            </td>
          </tr>

          <SummaryRow
            label="Total liabilities and equity"
            cents={bs.totalLiabilitiesAndEquityCents}
            emphasis
          />
        </tbody>
      </table>

      <p className={`px-4 py-3 text-xs ${bs.isBalanced ? 'text-positive' : 'text-negative'}`}>
        {bs.isBalanced
          ? 'Assets equal liabilities plus equity.'
          : `Out of balance by ${formatCents(bs.totalAssetsCents - bs.totalLiabilitiesAndEquityCents)}.`}
      </p>
    </Card>
  )
}

function SectionBlock({
  title,
  rows,
  total,
  emphasizeTotal,
}: {
  title: string
  rows: Array<{ chartAccountId: string; number: string; name: string; balanceCents: number }>
  total: number
  emphasizeTotal?: boolean
}) {
  return (
    <>
      <tr className="border-t border-line bg-raised/40">
        <td className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          {title}
        </td>
        <td />
      </tr>
      {rows.map((row) => (
        <tr key={row.chartAccountId} className="border-t border-line">
          <td className="px-4 py-1.5 pl-8">
            <span className="tnum text-faint">{row.number}</span> {row.name}
          </td>
          <td className="tnum px-4 py-1.5 text-right">{formatCents(row.balanceCents)}</td>
        </tr>
      ))}
      <tr
        className={
          emphasizeTotal
            ? 'border-t-2 border-line text-base font-semibold'
            : 'border-t border-line font-medium'
        }
      >
        <td className={emphasizeTotal ? 'px-4 py-2' : 'px-4 py-1.5 pl-8'}>
          Total {title.toLowerCase()}
        </td>
        <td
          className={`tnum px-4 text-right ${emphasizeTotal ? 'py-2 text-positive' : 'py-1.5'}`}
        >
          {formatCents(total)}
        </td>
      </tr>
    </>
  )
}

async function CashFlowReport({
  actor,
  start,
  end,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  start: string
  end: string
}) {
  const statement = await cashFlowStatement(actor, { startDate: start, endDate: end })

  const sections = [statement.operating, statement.investing, statement.financing]

  return (
    <div className="space-y-3">
      {!statement.reconciles && (
        <p className="card border-danger/40 p-3 text-xs text-danger">
          The sections come to {formatCents(statement.netChangeInCashCents)} but the cash accounts
          moved by {formatCents(statement.closingCashCents - statement.openingCashCents)}. The
          statement is derived from the same movements as the balance sheet, so this can only mean
          something wrote to the ledger outside the journal service.
        </p>
      )}

      <Card title="Statement of cash flows" subtitle={`${start} to ${end} · indirect method`}>
        <table className="w-full text-sm">
          <tbody>
            {sections.map((section, index) => (
              <Fragment key={section.title}>
                <tr className="bg-raised/60">
                  <td className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    {section.title}
                  </td>
                  <td />
                </tr>
                {index === 0 && (
                  <tr className="border-t border-line">
                    <td className="px-4 py-1.5">Net income</td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(statement.netIncomeCents)}
                    </td>
                  </tr>
                )}
                {section.lines.map((line) => (
                  <tr key={line.chartAccountId} className="border-t border-line">
                    <td className="px-4 py-1.5 pl-8">
                      <span className="tnum text-faint">{line.number}</span> {line.name}
                    </td>
                    <td className="tnum px-4 py-1.5 text-right">
                      {formatCents(line.cashEffectCents)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line font-medium">
                  <td className="px-4 py-1.5">Net cash from {section.title.toLowerCase()}</td>
                  <td className="tnum px-4 py-1.5 text-right">
                    {formatCents(section.totalCents)}
                  </td>
                </tr>
              </Fragment>
            ))}

            <tr className="border-t-2 border-line font-semibold">
              <td className="px-4 py-2">Net change in cash</td>
              <td className="tnum px-4 py-2 text-right">
                {formatCents(statement.netChangeInCashCents)}
              </td>
            </tr>
            <tr className="border-t border-line">
              <td className="px-4 py-1.5 text-muted">Cash at {start}</td>
              <td className="tnum px-4 py-1.5 text-right">
                {formatCents(statement.openingCashCents)}
              </td>
            </tr>
            <tr className="border-t border-line font-semibold">
              <td className="px-4 py-2">Cash at {end}</td>
              <td className="tnum px-4 py-2 text-right">
                {formatCents(statement.closingCashCents)}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      <p className="text-xs text-faint">
        Indirect method: the change in cash is the negated movement of every other account, grouped
        into three sections. Depreciation appears in operating because it moved an account and no
        cash — not as a rule applied afterwards.
      </p>
    </div>
  )
}

async function ComparativeReport({
  actor,
  start,
  end,
  basis,
  compare,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  start: string
  end: string
  basis: ReportingBasis
  compare: ComparisonKind
}) {
  const periods = comparisonWindows({ startDate: start, endDate: end }, compare)
  const report = await comparativeProfitAndLoss(actor, { periods, basis })

  const sections = [
    report.revenue,
    report.costOfSales,
    report.operatingExpenses,
    report.otherIncome,
    report.otherExpenses,
  ].filter((section) => section.rows.length > 0)

  return (
    <Card
      title={`Comparative profit & loss — ${COMPARISON_LABELS[compare]}`}
      subtitle={`${BASIS_LABELS[basis]} basis`}
    >
      <table className="w-full text-sm">
        <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Account</th>
            {report.periods.map((period) => (
              <th key={period.label} className="px-4 py-2 text-right font-medium">
                {period.label}
              </th>
            ))}
            <th className="px-4 py-2 text-right font-medium">Variance</th>
            <th className="px-4 py-2 text-right font-medium">%</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section.title}>
              <tr className="bg-raised/40">
                <td
                  colSpan={report.periods.length + 3}
                  className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  {section.title}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr key={row.chartAccountId} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    <span className="tnum text-faint">{row.number}</span> {row.name}
                  </td>
                  {row.amountsCents.map((amount, index) => (
                    <td key={index} className="tnum px-4 py-1.5 text-right">
                      {formatCents(amount)}
                    </td>
                  ))}
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(row.varianceCents)}</td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">
                    {/* No prior figure means no percentage. Printing one would
                        invite somebody to act on an infinity. */}
                    {row.varianceBasisPoints === null
                      ? '—'
                      : `${(row.varianceBasisPoints / 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}

          <tr className="border-t-2 border-line font-semibold">
            <td className="px-4 py-2">Net income</td>
            {report.netIncomeCents.map((amount, index) => (
              <td key={index} className="tnum px-4 py-2 text-right">
                {formatCents(amount)}
              </td>
            ))}
            <td className="tnum px-4 py-2 text-right">
              {formatCents(
                report.netIncomeCents[0] - report.netIncomeCents[report.netIncomeCents.length - 1],
              )}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </Card>
  )
}

/**
 * The comparative balance sheet.
 *
 * A balance sheet is a point in time, so the comparison is two *dates* rather
 * than two ranges — the end of the current window against the end of the one
 * it is compared with. Taking the start of the prior window instead would put
 * the opening position beside the closing one and call the difference a
 * variance.
 *
 * `isBalanced` is printed per column. A comparative that balances in one
 * column and not the other is a broken report, and it is the kind of thing a
 * reader will not notice unless it is stated.
 */
async function ComparativeBalanceSheetReport({
  actor,
  start,
  end,
  basis,
  compare,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  start: string
  end: string
  basis: ReportingBasis
  compare: ComparisonKind
}) {
  const periods = comparisonWindows({ startDate: start, endDate: end }, compare)
  const report = await comparativeBalanceSheet(actor, {
    basis,
    columns: periods.map((period) => ({ label: period.label, asOfDate: period.endDate })),
  })

  const last = report.totalAssetsCents.length - 1
  const varianceCents = report.totalAssetsCents[0] - report.totalAssetsCents[last]

  // Equity is rendered separately from assets and liabilities because the
  // period's profit belongs in it and is not an account. Without that line the
  // page shows liabilities above a smaller total, and the gap — which is
  // exactly the net income — has nothing explaining it.
  const sections = [report.assets, report.liabilities].filter(
    (section) => section.rows.length > 0,
  )
  const equityTotals = report.equity.totalsCents.map(
    (amount, index) => amount + report.netIncomeCents[index],
  )

  return (
    <Card
      title={`Comparative balance sheet — ${COMPARISON_LABELS[compare]}`}
      subtitle={`${BASIS_LABELS[basis]} basis · ${report.asOfDates.join(' and ')}`}
    >
      <table className="w-full text-sm">
        <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Account</th>
            {/* The date is the heading, not the window that produced it. A
                balance sheet column is a moment; printing "1 Jan to 16 Aug"
                over a closing position invites somebody to read it as
                activity across those dates, which is the profit and loss. */}
            {report.asOfDates.map((asOfDate) => (
              <th key={asOfDate} className="px-4 py-2 text-right font-medium">
                As at {asOfDate}
              </th>
            ))}
            <th className="px-4 py-2 text-right font-medium">Variance</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section.title}>
              <tr className="bg-raised/40">
                <td
                  colSpan={report.labels.length + 2}
                  className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  {section.title}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr key={row.chartAccountId} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    <span className="tnum text-faint">{row.number}</span> {row.name}
                  </td>
                  {row.amountsCents.map((amount, index) => (
                    <td key={index} className="tnum px-4 py-1.5 text-right">
                      {formatCents(amount)}
                    </td>
                  ))}
                  <td className="tnum px-4 py-1.5 text-right">{formatCents(row.varianceCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-line text-muted">
                <td className="px-4 py-1.5 text-xs">Total {section.title.toLowerCase()}</td>
                {section.totalsCents.map((amount, index) => (
                  <td key={index} className="tnum px-4 py-1.5 text-right text-xs">
                    {formatCents(amount)}
                  </td>
                ))}
                <td className="tnum px-4 py-1.5 text-right text-xs">
                  {formatCents(section.totalsCents[0] - section.totalsCents[last])}
                </td>
              </tr>
            </Fragment>
          ))}

          <tr className="bg-raised/40">
            <td
              colSpan={report.labels.length + 2}
              className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted"
            >
              Equity
            </td>
          </tr>
          {report.equity.rows.map((row) => (
            <tr key={row.chartAccountId} className="border-t border-line">
              <td className="px-4 py-1.5">
                <span className="tnum text-faint">{row.number}</span> {row.name}
              </td>
              {row.amountsCents.map((amount, index) => (
                <td key={index} className="tnum px-4 py-1.5 text-right">
                  {formatCents(amount)}
                </td>
              ))}
              <td className="tnum px-4 py-1.5 text-right">{formatCents(row.varianceCents)}</td>
            </tr>
          ))}
          <tr className="border-t border-line">
            <td className="px-4 py-1.5">
              Net income for the period
              <span className="block text-xs text-faint">
                Not an account — it is what the profit and loss made, sitting in equity until the
                year is closed.
              </span>
            </td>
            {report.netIncomeCents.map((amount, index) => (
              <td key={index} className="tnum px-4 py-1.5 text-right">
                {formatCents(amount)}
              </td>
            ))}
            <td className="tnum px-4 py-1.5 text-right">
              {formatCents(report.netIncomeCents[0] - report.netIncomeCents[last])}
            </td>
          </tr>
          <tr className="border-t border-line text-muted">
            <td className="px-4 py-1.5 text-xs">Total equity</td>
            {equityTotals.map((amount, index) => (
              <td key={index} className="tnum px-4 py-1.5 text-right text-xs">
                {formatCents(amount)}
              </td>
            ))}
            <td className="tnum px-4 py-1.5 text-right text-xs">
              {formatCents(equityTotals[0] - equityTotals[last])}
            </td>
          </tr>

          <tr className="border-t-2 border-line font-semibold">
            <td className="px-4 py-2">Total assets</td>
            {report.totalAssetsCents.map((amount, index) => (
              <td key={index} className="tnum px-4 py-2 text-right">
                {formatCents(amount)}
              </td>
            ))}
            <td className="tnum px-4 py-2 text-right">{formatCents(varianceCents)}</td>
          </tr>
          <tr className="font-semibold">
            <td className="px-4 py-2">Liabilities and equity</td>
            {report.totalLiabilitiesAndEquityCents.map((amount, index) => (
              <td key={index} className="tnum px-4 py-2 text-right">
                {formatCents(amount)}
              </td>
            ))}
            <td className="tnum px-4 py-2 text-right">
              {formatCents(
                report.totalLiabilitiesAndEquityCents[0] -
                  report.totalLiabilitiesAndEquityCents[last],
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="border-t border-line px-4 py-2 text-xs text-faint">
        {report.isBalanced.every(Boolean)
          ? 'Both columns balance.'
          : `One column does not balance: ${report.asOfDates
              .filter((_, index) => !report.isBalanced[index])
              .join(', ')}. Something wrote around the journal service.`}
      </p>
    </Card>
  )
}

async function AgingReport({
  actor,
  end,
  kind,
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  end: string
  kind: 'ar' | 'ap'
}) {
  const report =
    kind === 'ar' ? await arAging(actor, { asOfDate: end }) : await apAging(actor, { asOfDate: end })

  const title = kind === 'ar' ? 'Accounts receivable aging' : 'Accounts payable aging'
  const partyLabel = kind === 'ar' ? 'Customer' : 'Vendor'

  // Every figure below is in the company's own currency (Phase 107). The report
  // spans every party, so there is exactly one currency in which "how much of
  // this is going bad" has an answer — and a foreign row says separately what
  // the other party was actually billed, so nobody quotes this figure at them.
  const money = (cents: number) => formatCents(cents, report.currency)
  const reconciliation = creditNote(report)

  return (
    <Card title={title} subtitle={`As of ${end} · ${report.currency}`}>
      {report.rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing outstanding.</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{partyLabel}</th>
                {BUCKETS.map((bucket) => (
                  <th key={bucket.key} className="px-4 py-2 text-right font-medium">
                    {bucket.label}
                  </th>
                ))}
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => {
                const invoiced = foreignNote(row)
                return (
                  <tr key={row.partyId} className="border-t border-line">
                    <td className="px-4 py-1.5">
                      {row.partyName}
                      {invoiced && (
                        <span className="ml-2 text-xs text-muted">{invoiced}</span>
                      )}
                    </td>
                    {BUCKETS.map((bucket) => (
                      <td key={bucket.key} className="tnum px-4 py-1.5 text-right">
                        {money(row[bucket.key])}
                      </td>
                    ))}
                    <td className="tnum px-4 py-1.5 text-right font-medium">
                      {money(row.totalCents)}
                    </td>
                  </tr>
                )
              })}
              <tr className="border-t-2 border-line font-semibold">
                <td className="px-4 py-2">Total</td>
                {BUCKETS.map((bucket) => (
                  <td key={bucket.key} className="tnum px-4 py-2 text-right">
                    {money(report.totals[bucket.key])}
                  </td>
                ))}
                <td className="tnum px-4 py-2 text-right">{money(report.totals.totalCents)}</td>
              </tr>
            </tbody>
          </table>
          {reconciliation && (
            <p className="border-t border-line px-4 py-3 text-xs text-muted">{reconciliation}</p>
          )}
        </>
      )}
    </Card>
  )
}


/**
 * Do the control accounts agree with the documents behind them? (Phase 31)
 *
 * Not a financial statement — a check. Accounts Receivable is the ledger's
 * one-line summary of a subledger made of customers, and the two are
 * maintained by different code. When they drift, the balance sheet says money
 * is owed and the aging report cannot say by whom, and nobody chases it.
 */
async function ControlAccounts({ actor, end }: { actor: ActorContext; end: string }) {
  const report = await controlAccounts(actor, { asOf: end })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        As at {end}. Each control account against the documents behind it. These{' '}
        <strong>should</strong> agree exactly: a difference means somebody posted straight at the
        account without a document, or a document moved without a posting.
      </p>

      {[report.receivables, report.payables].map((check) => (
        <div className="card px-4 py-3" key={check.accountNumber}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {check.accountNumber} {check.accountName}
            </h3>
            <span className={check.agrees ? 'text-success' : 'text-danger'}>
              {check.agrees ? 'Agrees' : `Out by ${formatCents(check.differenceCents)}`}
            </span>
          </div>

          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-faint">The ledger says</dt>
              <dd className="text-lg tabular-nums">{formatCents(check.ledgerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">The documents say</dt>
              <dd className="text-lg tabular-nums">{formatCents(check.subledgerCents)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Open documents</dt>
              <dd className="text-lg tabular-nums">{check.documents}</dd>
            </div>
          </dl>

          {check.parties.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {check.parties.slice(0, 10).map((party: { id: string; name: string; balanceCents: number }) => (
                <li className="flex justify-between gap-4" key={party.id}>
                  <span>{party.name}</span>
                  <span className="tabular-nums">{formatCents(party.balanceCents)}</span>
                </li>
              ))}
            </ul>
          )}

          {!check.agrees && (
            <p className="mt-2 text-xs text-danger">
              The balance sheet names a figure this report cannot attribute to anybody. Look for a
              manual journal entry against {check.accountNumber}.
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
