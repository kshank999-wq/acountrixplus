import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { formatMicros } from '@/modules/ai/provider'
import { formatBasisPoints } from '@/modules/crm/analytics'
import {
  getSettings,
  providerHealth,
  recentRequests,
  usageByFeature,
  usageWindow,
} from '@/modules/ai/settings'
import { acceptanceStats, pendingSuggestions } from '@/modules/ai/suggestions'
import { providerStatus } from '@/modules/ai/registry'
import { AI_NAV, FEATURE_LABELS, OUTCOME_LABELS } from './nav'
import { SettingsPanel } from './settings-panel'

export const dynamic = 'force-dynamic'

/**
 * The AI module's admin page (spec §11, §12).
 *
 * Everything a person needs to answer "is this worth paying for": what it
 * cost, how often it was right enough to accept, and what it got wrong. The
 * usage ledger spec §12 asks for is not a back-office table here — it is the
 * page, because a metered optional module that hides its meter is a module
 * nobody can make a decision about.
 */
export default async function AiPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'ai:manage')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">AI module</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include managing the AI module.
        </p>
      </main>
    )
  }

  const [settings, usage, health, byFeature, requests, pending, acceptance] = await Promise.all([
    getSettings(actor.companyId),
    usageWindow(actor.companyId),
    providerHealth(actor.companyId),
    usageByFeature(actor),
    recentRequests(actor, 25),
    pendingSuggestions(actor, 10),
    acceptanceStats(actor),
  ])

  const ceilingUsedBp =
    settings.monthlyCeilingMicros > 0
      ? Math.min(10_000, Math.round((usage.monthMicros / settings.monthlyCeilingMicros) * 10_000))
      : 0

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="ai"
    >
      <SubNav items={AI_NAV} active="/ai" />

      {!settings.enabled && (
        <p className="card mb-4 p-4 text-sm">
          <span className="font-medium">The AI module is off.</span>{' '}
          <span className="text-muted">
            Everything else in Accountrix Plus works exactly as it does now — bookkeeping,
            reconciliation, proposals, and campaigns never require it. Switching it on adds
            suggestions you can accept or ignore.
          </span>
        </p>
      )}

      {settings.enabled && health.fellBack && (
        <p className="card mb-4 border-warning/40 p-4 text-sm text-warning">
          <span className="font-medium">
            &ldquo;{health.selected}&rdquo; has no credentials configured.
          </span>{' '}
          Suggestions are coming from the built-in heuristics instead. Set the provider&rsquo;s API
          key on the server to use it.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Spend this month"
              value={formatMicros(usage.monthMicros)}
              hint={
                settings.monthlyCeilingMicros > 0
                  ? `${formatBasisPoints(ceilingUsedBp)} of ${formatMicros(settings.monthlyCeilingMicros)}`
                  : 'no ceiling set'
              }
              accent
            />
            <Stat label="Requests this month" value={String(usage.monthRequests)} hint={`${usage.hourRequests} in the last hour`} />
            <Stat
              label="Suggestions accepted"
              // A rate over nothing is not 0% — it is unknown, and showing 0%
              // reads as "the assistant is always wrong" on a fresh company.
              value={
                acceptance.accepted + acceptance.rejected === 0
                  ? '—'
                  : formatBasisPoints(acceptance.acceptanceRateBp)
              }
              hint={
                acceptance.accepted + acceptance.rejected === 0
                  ? 'nothing decided yet'
                  : `${acceptance.accepted} of ${acceptance.accepted + acceptance.rejected} decided`
              }
              accent
            />
            <Stat label="Awaiting a decision" value={String(acceptance.pending)} />
          </div>

          <Card
            title="Usage by capability"
            subtitle="This calendar month. Cost is an estimate from published token prices."
          >
            {byFeature.length === 0 ? (
              <Empty>Nothing has been asked yet.</Empty>
            ) : (
              <Table
                head={['Capability', 'Requests', 'Failed', 'Avg latency', 'Cost']}
                rows={byFeature.map((row) => [
                  FEATURE_LABELS[row.feature] ?? row.feature,
                  row.requests,
                  row.failures,
                  `${row.avgLatencyMs} ms`,
                  formatMicros(Number(row.micros)),
                ])}
              />
            )}
          </Card>

          <Card
            title="Awaiting a decision"
            subtitle="Nothing here has taken effect. Each is a proposal until somebody accepts it."
          >
            {pending.length === 0 ? (
              <Empty>No suggestions are waiting.</Empty>
            ) : (
              <Table
                head={['Capability', 'About', 'Confidence', 'Raised']}
                rows={pending.map((row) => [
                  FEATURE_LABELS[row.feature] ?? row.feature,
                  row.entityType.replace(/_/g, ' '),
                  row.confidenceBp === null ? '—' : formatBasisPoints(row.confidenceBp),
                  row.createdAt?.toISOString().slice(0, 10) ?? '',
                ])}
              />
            )}
          </Card>

          <Card title="Recent requests" subtitle="The usage ledger, newest first.">
            {requests.length === 0 ? (
              <Empty>No requests recorded.</Empty>
            ) : (
              <Table
                head={['When', 'Capability', 'Model', 'Tokens', 'Outcome', 'Cost']}
                rows={requests.map((row) => [
                  row.createdAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '',
                  FEATURE_LABELS[row.feature] ?? row.feature,
                  row.model,
                  String(row.inputTokens + row.outputTokens),
                  OUTCOME_LABELS[row.outcome] ?? row.outcome,
                  formatMicros(Number(row.costMicros)),
                ])}
              />
            )}
          </Card>
        </div>

        <SettingsPanel
          settings={{
            enabled: settings.enabled,
            provider: settings.provider,
            model: settings.model,
            monthlyCeilingDollars: settings.monthlyCeilingMicros / 1_000_000,
            hourlyRequestLimit: settings.hourlyRequestLimit,
            disabledFeatures: settings.disabledFeatures,
          }}
          providers={providerStatus()}
          effectiveModel={health.model}
        />
      </div>
    </AppShell>
  )
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className="card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-0.5 text-xl font-semibold ${accent ? 'text-brand' : ''}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
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
