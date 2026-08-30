import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listPractitioners } from '@/modules/appointments/service'
import { diary, diarySummary, giftCardPosition, payoutPosition } from '@/modules/appointments/reporting'
import { AppointmentsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The appointments workspace (spec §5 Healthcare and Personal Care, Phase 29).
 *
 * Gated on the module rather than the industry, like every workspace since
 * Phase 14: a physiotherapist on the general pack keeps a diary, and a clinic
 * that only does insurance billing does not.
 */
export default async function AppointmentsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Appointments</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the diary.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'appointments'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session.companyName}
        active="appointments"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Appointments is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-action hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to keep a diary, split what each visit earns, and sell gift cards.
          </p>
        </div>
      </AppShell>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  const [rows, summary, staff, payouts, cards] = await Promise.all([
    diary(actor),
    diarySummary(actor),
    listPractitioners(actor),
    can(actor, 'reports:view') ? payoutPosition(actor) : null,
    can(actor, 'reports:view') ? giftCardPosition(actor) : null,
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="appointments"
    >
      <AppointmentsBoard
        rows={rows.map((row) => ({
          ...row,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
        }))}
        summary={summary}
        practitioners={staff.map((row) => ({
          id: row.id,
          name: row.name,
          commissionBp: row.commissionBp,
          productCommissionBp: row.productCommissionBp,
          isActive: row.isActive,
        }))}
        payouts={payouts}
        cards={cards}
        today={today}
        canManage={can(actor, 'accounting:journal')}
        canAddStaff={can(actor, 'company:manage')}
      />
    </AppShell>
  )
}
