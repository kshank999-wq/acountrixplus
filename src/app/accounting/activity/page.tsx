import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { recentActivity } from '@/modules/audit'
import { tell } from '@/modules/audit/story'
import { functionalCurrency } from '@/modules/fx/service'
import { ACCOUNTING_NAV } from '../nav'
import { ActivityList } from './list'

export const dynamic = 'force-dynamic'

/**
 * What has happened on these books (spec §19, Phase 71).
 *
 * The audit log has been written since Phase 3 and read by nothing. Every
 * correction, every edit to a supplier, every approval and every withdrawal of
 * one landed in a table with no screen in front of it — including, from Phase
 * 70, the reason somebody was made to type before the books would let them
 * take money back.
 *
 * Gated on `audit:view`, which is the permission that was declared for exactly
 * this in Phase 3 and never once checked until now.
 */
export default async function ActivityPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'audit:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include reading the audit log. You can still see the
          history of any record you are able to open.
        </p>
      </main>
    )
  }

  const [rows, homeCurrency] = await Promise.all([
    recentActivity(actor, 200),
    functionalCurrency(actor.companyId),
  ])

  const lines = rows.map((row) => ({
    ...tell(row),
    id: row.id,
    at: row.createdAt.toISOString(),
    userId: row.userId,
    actorName: row.actorName,
    entityType: row.entityType,
    isUndo: row.isUndo,
  }))

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/activity" />

      <header className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Everything that has been done to these books, newest first — who did it, what changed,
          and, where one was given, why. Nothing here can be edited; that is the point of it.
        </p>
      </header>

      <ActivityList lines={lines} homeCurrency={homeCurrency} />
    </AppShell>
  )
}
