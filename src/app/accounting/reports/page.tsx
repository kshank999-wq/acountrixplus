import { Fragment } from 'react'
import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import { trialBalance } from '@/modules/ledger/balances'
import { apAging, arAging, balanceSheet, profitAndLoss } from '@/modules/ledger/reports'
import { ACCOUNTING_NAV } from '../nav'
import { ReportPicker } from './report-picker'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{ report?: string; start?: string; end?: string }>

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
  const session = await currentSession()
  const params = await searchParams

  if (!can(actor, 'accounting:view')) {
    return <NoAccess role={actor.role} />
  }

  const defaults = defaultRange()
  const start = params.start || defaults.start
  const end = params.end || defaults.end
  const report = params.report ?? 'trial_balance'

  const canSeeStatements = can(actor, 'reports:financial')

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/reports" />
      <ReportPicker report={report} start={start} end={end} canSeeStatements={canSeeStatements} />

      <div className="mt-4">
        {report === 'trial_balance' && <TrialBalanceReport actor={actor} start={start} end={end} />}
        {report === 'profit_loss' && canSeeStatements && (
          <ProfitLossReport actor={actor} start={start} end={end} />
        )}
        {report === 'balance_sheet' && canSeeStatements && (
          <BalanceSheetReport actor={actor} end={end} />
        )}
        {report === 'ar_aging' && <AgingReport actor={actor} end={end} kind="ar" />}
        {report === 'ap_aging' && <AgingReport actor={actor} end={end} kind="ap" />}
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
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  start: string
  end: string
}) {
  const pl = await profitAndLoss(actor, { startDate: start, endDate: end })

  const blocks = [
    pl.revenue,
    pl.costOfSales,
    pl.operatingExpenses,
    pl.otherIncome,
    pl.otherExpenses,
  ].filter((block) => block.rows.length > 0)

  return (
    <Card title="Profit and loss" subtitle={`${start} to ${end}`}>
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
}: {
  actor: Awaited<ReturnType<typeof requireActor>>
  end: string
}) {
  const bs = await balanceSheet(actor, { asOfDate: end })

  return (
    <Card title="Balance sheet" subtitle={`As of ${end}`}>
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

  return (
    <Card title={title} subtitle={`As of ${end}`}>
      {report.rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing outstanding.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">{partyLabel}</th>
              <th className="px-4 py-2 text-right font-medium">Current</th>
              <th className="px-4 py-2 text-right font-medium">1–30</th>
              <th className="px-4 py-2 text-right font-medium">31–60</th>
              <th className="px-4 py-2 text-right font-medium">61–90</th>
              <th className="px-4 py-2 text-right font-medium">90+</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.partyId} className="border-t border-line">
                <td className="px-4 py-1.5">{row.partyName}</td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(row.current)}</td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(row.d1_30)}</td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(row.d31_60)}</td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(row.d61_90)}</td>
                <td className="tnum px-4 py-1.5 text-right">{formatCents(row.d90_plus)}</td>
                <td className="tnum px-4 py-1.5 text-right font-medium">
                  {formatCents(row.totalCents)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-line font-semibold">
              <td className="px-4 py-2">Total</td>
              <td className="tnum px-4 py-2 text-right">{formatCents(report.totals.current)}</td>
              <td className="tnum px-4 py-2 text-right">{formatCents(report.totals.d1_30)}</td>
              <td className="tnum px-4 py-2 text-right">{formatCents(report.totals.d31_60)}</td>
              <td className="tnum px-4 py-2 text-right">{formatCents(report.totals.d61_90)}</td>
              <td className="tnum px-4 py-2 text-right">{formatCents(report.totals.d90_plus)}</td>
              <td className="tnum px-4 py-2 text-right">{formatCents(report.totals.totalCents)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  )
}
