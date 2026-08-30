import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { previewChases } from '@/modules/receivables/chase-run'
import { REFUSAL_LABELS } from '@/modules/receivables/chasing'
import { SETTINGS_NAV } from '../nav'
import { ChasingBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Chasing overdue invoices (spec §13, Phase 43).
 *
 * The screen exists because nobody switches on a thing that emails their
 * customers without first seeing exactly what it would send. So the preview is
 * the page, and the settings are underneath it.
 */
export default async function ChasingPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Chasing</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const preview = await previewChases(actor.companyId)

  // Only the reasons that actually apply to somebody's books. A list of nine
  // rules with eight zeroes beside them is a specification, not a screen.
  const heldSummary = Object.entries(preview.heldCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({
      reason,
      count,
      label: REFUSAL_LABELS[reason as keyof typeof REFUSAL_LABELS],
    }))
    .sort((a, b) => b.count - a.count)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={SETTINGS_NAV} active="/settings/chasing" />
      <ChasingBoard
        policy={{
          enabled: preview.policy.enabled,
          firstAfterDays: preview.policy.firstAfterDays,
          everyDays: preview.policy.everyDays,
          maxChases: preview.policy.maxChases,
          minimumBalanceCents: preview.policy.minimumBalanceCents,
          quietDaysAfterPayment: preview.policy.quietDaysAfterPayment,
          maxPerRun: preview.policy.maxPerRun,
        }}
        asOf={preview.asOf}
        overCap={preview.overCap}
        due={preview.due.map((row) => ({
          id: row.invoice.id,
          number: row.invoice.number,
          customerName: row.invoice.customerName,
          balanceCents: row.invoice.balanceCents,
          currency: row.invoice.currency,
          daysOverdue: row.daysOverdue,
          stage: row.stage,
          nextAfter: row.nextAfter,
        }))}
        held={preview.held
          // Oldest first, so the ones somebody is most likely to be wondering
          // about are the ones they see without scrolling.
          .sort((a, b) => a.invoice.dueDate.localeCompare(b.invoice.dueDate))
          .slice(0, 40)
          .map((row) => ({
            id: row.invoice.id,
            number: row.invoice.number,
            customerName: row.invoice.customerName,
            balanceCents: row.invoice.balanceCents,
            currency: row.invoice.currency,
            dueDate: row.invoice.dueDate,
            reason: REFUSAL_LABELS[row.reason],
            nextChase: row.nextChase,
          }))}
        heldTotal={preview.held.length}
        heldSummary={heldSummary}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
