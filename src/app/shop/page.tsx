import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled } from '@/modules/industry/modules'
import { listLines, repairOrderView } from '@/modules/vehicles/service'
import {
  authorisationsAgree,
  openOrders,
  shopMix,
  vehicleHistory,
  vehicleList,
} from '@/modules/vehicles/reporting'
import { ShopBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The shop workspace (spec §5 Automotive, Phase 30).
 *
 * Gated on the module rather than the industry, like every workspace since
 * Phase 14: a plant-hire firm on the general pack keeps vehicles, and a body
 * shop that only does insurance work through a portal may not.
 */
export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; vehicle?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()
  const params = await searchParams

  if (!can(actor, 'jobs:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">The shop</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to repair orders.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'vehicles'))) {
    return (
      <AppShell actor={actor} companyName={session.companyName} active="shop">
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Vehicles is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-action hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to keep customer vehicles, write repair orders, and hold an estimate to what was agreed.
          </p>
        </div>
      </AppShell>
    )
  }

  const today = new Date().toISOString().slice(0, 10)

  const [orders, cars, mix, check] = await Promise.all([
    openOrders(actor),
    vehicleList(actor),
    can(actor, 'reports:view') ? shopMix(actor) : null,
    can(actor, 'reports:view') ? authorisationsAgree(actor) : null,
  ])

  const order = params.order ? await repairOrderView(actor, params.order).catch(() => null) : null
  const lines = order ? await listLines(actor, order.id) : []
  const history = params.vehicle ? await vehicleHistory(actor, params.vehicle) : []

  return (
    <AppShell actor={actor} companyName={session.companyName} active="shop">
      <ShopBoard
        orders={orders}
        cars={cars}
        mix={mix}
        check={check}
        order={order}
        lines={lines.map((line) => ({
          id: line.id,
          kind: line.kind,
          description: line.description,
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          subletCostCents: line.subletCostCents,
        }))}
        history={history}
        historyVehicleId={params.vehicle ?? null}
        today={today}
        canManage={can(actor, 'jobs:manage')}
        canBill={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
