import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listServiceItems } from '@/modules/studio/service'
import { listBoms, listWorkOrders } from '@/modules/manufacturing/service'
import { finishedGoodsOnHand, stageValues, wipPosition } from '@/modules/manufacturing/reporting'
import { ManufacturingBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The manufacturing workspace (spec §5 Manufacturing, Phase 27).
 *
 * Gated on the module rather than the industry, the same as inventory,
 * properties and funds: a joiner who assembles kits from bought parts is
 * manufacturing, and a factory that only distributes is not.
 */
export default async function ManufacturingPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Manufacturing</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to manufacturing.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'manufacturing'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session?.companyName ?? 'Accountrix Plus'}
        active="manufacturing"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Manufacturing is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-brand hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to keep bills of materials and move cost from raw materials into finished goods.
          </p>
        </div>
      </AppShell>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  const [boms, orders, wip, stages, finished, items] = await Promise.all([
    listBoms(actor),
    listWorkOrders(actor),
    // The reconciliation follows the same permission as every other statement
    // rather than the softer one that opens the run list.
    can(actor, 'reports:view') ? wipPosition(actor, { asOf: today }) : null,
    can(actor, 'reports:view') ? stageValues(actor, { asOf: today }) : [],
    can(actor, 'reports:view') ? finishedGoodsOnHand(actor) : [],
    listServiceItems(actor, { activeOnly: true }),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="manufacturing"
    >
      <ManufacturingBoard
        boms={boms}
        orders={orders}
        wip={wip}
        stages={stages}
        finished={finished}
        items={items.map((item) => ({ id: item.id, name: item.name }))}
        today={today}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
