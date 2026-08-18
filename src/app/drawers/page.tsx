import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listAccounts } from '@/modules/coa/service'
import {
  listDrawers,
  drawerPosition,
  shiftHistory,
  shiftPosition,
} from '@/modules/drawer/service'
import { DrawersBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The tills workspace (spec §5, §13, Phase 34).
 *
 * Gated on the module rather than the industry, like every workspace since
 * Phase 14: a salon on the personal-care pack has a drawer, and a wholesaler
 * that only invoices does not.
 *
 * Distinct from Takings on purpose. Takings is a day somebody else's till
 * reported; this is the till, and the difference between them is who counted
 * it.
 */
export default async function DrawersPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Tills</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the tills.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'cash_drawer'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session?.companyName ?? 'Accountrix Plus'}
        active="drawers"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Cash drawers are switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn them on in{' '}
            <a className="text-brand hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to open a till with a float, take notes into it, and count it at the end of a shift.
          </p>
        </div>
      </AppShell>
    )
  }

  const [drawers, history, position, accounts] = await Promise.all([
    listDrawers(actor),
    shiftHistory(actor, { limit: 30 }),
    can(actor, 'reports:view') ? drawerPosition(actor) : null,
    listAccounts(actor),
  ])

  // What each open till expects to hold, so somebody counting one can see the
  // number they are counting against.
  const open = await Promise.all(
    drawers
      .filter((row) => row.openShiftId)
      .map(async (row) => {
        const shift = await shiftPosition(actor, row.openShiftId!)
        return {
          shiftId: shift.shiftId,
          drawerName: shift.drawerName,
          openedAt: shift.openedAt.toISOString(),
          openedByName: shift.openedByName,
          floatCents: shift.floatCents,
          takingsCents: shift.takingsCents,
          paidOutCents: shift.paidOutCents,
          expectedCents: shift.expectedCents,
          takingCount: shift.takingCount,
          payouts: shift.payouts,
        }
      }),
  )

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="drawers"
    >
      <DrawersBoard
        drawers={drawers.map((row) => ({
          id: row.id,
          name: row.name,
          defaultFloatCents: row.defaultFloatCents,
          isActive: row.isActive,
          openShiftId: row.openShiftId,
        }))}
        open={open}
        history={history.map((row) => ({
          id: row.id,
          drawerName: row.drawerName,
          status: row.status,
          openedAt: row.openedAt.toISOString(),
          closedAt: row.closedAt?.toISOString() ?? null,
          floatCents: row.floatCents,
          countedCents: row.countedCents,
          expectedCents: row.expectedCents,
          overShortCents: row.overShortCents,
          openedByName: row.openedByName,
        }))}
        position={position}
        expenseAccounts={accounts
          .filter((account) => account.type === 'expense')
          .map((account) => ({ id: account.id, number: account.number, name: account.name }))}
        canManage={can(actor, 'accounting:journal')}
        canAddDrawers={can(actor, 'company:manage')}
      />
    </AppShell>
  )
}
