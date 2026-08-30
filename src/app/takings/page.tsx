import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listAccounts } from '@/modules/coa/service'
import { listDays, tipsPosition } from '@/modules/pos/service'
import { TakingsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The takings workspace (spec §5 Restaurant and E-commerce, Phase 28).
 *
 * Gated on the module rather than the industry, like every workspace since
 * Phase 14: a market stall on the general pack takes a day's cash, and a
 * restaurant that invoices for catering only does not.
 */
export default async function TakingsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Takings</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to takings.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'pos_import'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session.companyName}
        active="takings"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Daily takings is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-action hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to import a day from a till, a marketplace or a payment processor.
          </p>
        </div>
      </AppShell>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  const [days, tips, accounts] = await Promise.all([
    listDays(actor),
    can(actor, 'reports:view') ? tipsPosition(actor) : null,
    listAccounts(actor),
  ])

  return (
    <AppShell actor={actor} companyName={session.companyName} active="takings">
      <TakingsBoard
        days={days}
        tips={tips}
        revenueAccounts={accounts
          .filter((account) => account.type === 'revenue' && account.isActive)
          .map((account) => ({ number: account.number, name: account.name }))}
        today={today}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
