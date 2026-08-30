import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { previewStatements, recentStatementSends } from '@/modules/receivables/statement-run'
import { STATEMENT_REFUSAL_LABELS } from '@/modules/receivables/statement-runs'
import { SETTINGS_NAV } from '../nav'
import { StatementRunBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Sending statements on a schedule (spec §13, Phase 57).
 *
 * The screen exists for the same reason Phase 43's does: nobody switches on a
 * thing that emails their customers without first seeing exactly what it would
 * send. So the preview is the page, and the settings are underneath it.
 */
export default async function StatementRunsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Sending statements</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [preview, recent] = await Promise.all([
    previewStatements(actor.companyId),
    recentStatementSends(actor, 15),
  ])

  // Only the reasons that actually apply to somebody's book. A list of six
  // rules with five zeroes beside them is a specification, not a screen.
  const heldSummary = Object.entries(preview.heldCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({
      reason,
      count,
      label: STATEMENT_REFUSAL_LABELS[reason as keyof typeof STATEMENT_REFUSAL_LABELS],
    }))
    .sort((a, b) => b.count - a.count)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/statements" />
      <StatementRunBoard
        policy={{
          enabled: preview.policy.enabled,
          dayOfMonth: preview.policy.dayOfMonth,
          kind: preview.policy.kind,
          minimumBalanceCents: preview.policy.minimumBalanceCents,
          quietDays: preview.policy.quietDays,
          maxPerRun: preview.policy.maxPerRun,
        }}
        asOf={preview.asOf}
        due={preview.due.map((row) => ({
          id: row.candidate.customerId,
          customerName: row.candidate.customerName,
          email: row.candidate.customerEmail,
          balanceCents: row.balanceCents,
          heldCreditCents: row.heldCreditCents,
        }))}
        held={preview.held
          // Biggest first, so the ones somebody is most likely to be wondering
          // about are the ones they see without scrolling.
          .sort((a, b) => b.candidate.balanceCents - a.candidate.balanceCents)
          .slice(0, 40)
          .map((row) => ({
            id: row.candidate.customerId,
            customerName: row.candidate.customerName,
            balanceCents: row.candidate.balanceCents,
            heldCreditCents: row.candidate.heldCreditCents,
            reason: STATEMENT_REFUSAL_LABELS[row.reason],
          }))}
        heldSummary={heldSummary}
        overCap={preview.overCap}
        recent={recent.map((row) => ({
          id: row.id,
          customerName: row.customerName,
          asOfDate: row.asOfDate,
          sentAt: row.sentAt ? row.sentAt.toISOString().slice(0, 10) : '',
          sentTo: row.sentTo,
          sendCount: row.sendCount,
        }))}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
