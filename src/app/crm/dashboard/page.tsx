import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatCents } from '@/lib/money'
import {
  breakdownBy,
  formatBasisPoints,
  lossReasons,
  pipelineValue,
  proposalStats,
  serviceBreakdown,
  serviceRevenue,
  winLossSummary,
} from '@/modules/crm/analytics'
import { stageLabel, type Stage } from '@/modules/crm/pipeline'
import { CRM_NAV } from '../nav'

export const dynamic = 'force-dynamic'

const LOSS_LABELS: Record<string, string> = {
  price: 'Price',
  timing: 'Timing',
  competitor: 'Competitor',
  no_response: 'No response',
  scope: 'Scope',
  internal_cancellation: 'Cancelled internally',
  other: 'Other',
}

/** The sales dashboard (spec §9). */
export default async function DashboardPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'crm:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Sales dashboard</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the CRM.
        </p>
      </main>
    )
  }

  const canSeeProposals = can(actor, 'proposals:view')

  const [summary, pipeline, sources, owners, months, losses, proposals, services, revenue] =
    await Promise.all([
      winLossSummary(actor),
      pipelineValue(actor),
      breakdownBy(actor, 'source'),
      breakdownBy(actor, 'owner'),
      // §9's "performance by time period". A cohort by arrival month — see
      // `BreakdownDimension` for why not by close date.
      breakdownBy(actor, 'month'),
      lossReasons(actor),
      canSeeProposals ? proposalStats(actor) : Promise.resolve(null),
      canSeeProposals ? serviceBreakdown(actor) : Promise.resolve(null),
      /*
        Revenue by product, realised. Behind `reports:view` rather than
        `proposals:view`, because it reads invoices — a salesperson sees what
        they offered and a bookkeeper sees what was billed.
      */
      can(actor, 'reports:view') ? serviceRevenue(actor) : Promise.resolve(null),
    ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="crm"
    >
      <SubNav items={CRM_NAV} active="/crm/dashboard" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Win rate (count)" value={formatBasisPoints(summary.winRateByCountBp)} accent />
        <Stat label="Win rate (value)" value={formatBasisPoints(summary.winRateByValueBp)} />
        <Stat label="Won value" value={formatCents(summary.wonValueCents)} />
        <Stat label="Weighted forecast" value={formatCents(summary.forecastValueCents)} accent />
        <Stat label="Open deals" value={String(summary.openCount)} />
        <Stat label="Average won deal" value={formatCents(summary.averageWonValueCents)} />
        {/*
          Was labelled "Days to decision" and measured creation to close, which
          reads as how long the client took and is how long the whole deal took.
          §9's time to decision is the proposal figure below.
        */}
        <Stat label="Days to close" value={String(summary.averageDaysToClose)} />
        <Stat label="Went dormant" value={String(summary.dormantCount)} />
      </div>

      {proposals && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Average proposal"
            value={formatCents(proposals.averageValueCents)}
            accent
          />
          <Stat
            label="Days to decision"
            value={
              proposals.decidedCount === 0 ? '—' : String(proposals.averageDaysToDecision)
            }
          />
          {/*
            The denominator, shown rather than implied: a mean over three
            proposals and a mean over three hundred are different claims, and
            the figure alone cannot tell them apart.
          */}
          <Stat label="Decided proposals" value={String(proposals.decidedCount)} />
          <Stat label="Opened" value={formatBasisPoints(proposals.viewRateBp)} />
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Open pipeline by stage"
          subtitle="Weighted value applies each deal's probability."
        >
          {pipeline.length === 0 ? (
            <Empty>No open opportunities.</Empty>
          ) : (
            <Table
              head={['Stage', 'Deals', 'Value', 'Weighted']}
              rows={pipeline.map((row) => [
                stageLabel(row.stage as Stage),
                String(row.count),
                formatCents(row.valueCents),
                formatCents(row.weightedCents),
              ])}
            />
          )}
        </Card>

        <Card title="Why deals were lost" subtitle="Lost and dormant opportunities.">
          {losses.rows.length === 0 ? (
            <Empty>Nothing lost yet.</Empty>
          ) : (
            <>
              <Table
                head={['Reason', 'Deals', 'Value', 'Share']}
                rows={losses.rows.map((row) => [
                  LOSS_LABELS[row.reason] ?? row.reason,
                  String(row.count),
                  formatCents(row.valueCents),
                  formatBasisPoints(row.shareBp),
                ])}
              />
              <p className="border-t border-line px-4 py-3 text-xs text-muted">
                {losses.reEngageableCount} of {losses.totalCount} may be re-engaged through
                marketing — the rest have no consent on record.
              </p>
            </>
          )}
        </Card>

        <Card title="Performance by source" subtitle="Where the wins come from.">
          {sources.length === 0 ? (
            <Empty>No opportunities yet.</Empty>
          ) : (
            <Table
              head={['Source', 'Won', 'Lost', 'Open', 'Win rate', 'Won value']}
              rows={sources.map((row) => [
                row.label,
                String(row.wonCount),
                String(row.lostCount),
                String(row.openCount),
                formatBasisPoints(row.winRateBp),
                formatCents(row.wonValueCents),
              ])}
            />
          )}
        </Card>

        <Card title="Performance by owner">
          {owners.length === 0 ? (
            <Empty>No opportunities yet.</Empty>
          ) : (
            <Table
              head={['Owner', 'Won', 'Lost', 'Win rate', 'Won value']}
              rows={owners.map((row) => [
                row.label,
                String(row.wonCount),
                String(row.lostCount),
                formatBasisPoints(row.winRateBp),
                formatCents(row.wonValueCents),
              ])}
            />
          )}
        </Card>

        <Card
          title="Performance by month"
          subtitle="Grouped by the month a deal arrived, so the open column belongs in the row."
        >
          {months.length === 0 ? (
            <Empty>No opportunities yet.</Empty>
          ) : (
            <Table
              head={['Month', 'Won', 'Lost', 'Open', 'Win rate', 'Won value']}
              rows={[...months]
                // Chronological, which the zero-padded key sorts correctly and
                // the readable label would not.
                .sort((a, b) => b.key.localeCompare(a.key))
                .map((row) => [
                  row.label,
                  String(row.wonCount),
                  String(row.lostCount),
                  String(row.openCount),
                  formatBasisPoints(row.winRateBp),
                  formatCents(row.wonValueCents),
                ])}
            />
          )}
        </Card>

        {services && (
          <Card
            title="Performance by service"
            subtitle="Proposal lines, not deals — one proposal can carry several products."
          >
            {services.length === 0 ? (
              <Empty>No proposal lines yet.</Empty>
            ) : (
              <Table
                head={['Service', 'Lines', 'Won', 'Lost', 'Win rate', 'Won value']}
                rows={services.map((row) => [
                  row.code ? `${row.code} — ${row.label}` : row.label,
                  String(row.lineCount),
                  String(row.wonLineCount),
                  String(row.lostLineCount),
                  formatBasisPoints(row.winRateByValueBp),
                  formatCents(row.wonValueCents),
                ])}
              />
            )}
          </Card>
        )}

        {revenue && (
          <Card
            title="Revenue by service"
            subtitle="Invoiced, in your own currency. What was billed, not what was offered."
          >
            {revenue.length === 0 ? (
              <Empty>No invoice lines yet.</Empty>
            ) : (
              <Table
                head={['Service', 'Lines', 'Invoiced', 'Share']}
                rows={revenue.map((row) => [
                  row.code ? `${row.code} — ${row.label}` : row.label,
                  String(row.lineCount),
                  formatCents(row.invoicedCents),
                  formatBasisPoints(row.shareBp),
                ])}
              />
            )}
          </Card>
        )}

        {proposals && (
          <Card
            title="Proposals by status"
            subtitle={`${formatBasisPoints(proposals.viewRateBp)} of sent proposals were opened.`}
          >
            {proposals.totalCount === 0 ? (
              <Empty>No proposals yet.</Empty>
            ) : (
              <Table
                head={['Status', 'Count', 'Value']}
                rows={Object.entries(proposals.byStatus).map(([status, entry]) => [
                  status.replace('_', ' '),
                  String(entry.count),
                  formatCents(entry.valueCents),
                ])}
              />
            )}
          </Card>
        )}
      </div>
    </AppShell>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${accent ? 'text-action' : ''}`}>{value}</p>
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
        <tr>
          {head.map((label, index) => (
            <th key={label} className={`px-4 py-2 font-medium ${index > 0 ? 'text-right' : ''}`}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-t border-line">
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className={`px-4 py-1.5 ${cellIndex > 0 ? 'tnum text-right' : ''}`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
