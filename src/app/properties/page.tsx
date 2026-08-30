import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import { moduleEnabled, companyTerminology } from '@/modules/industry/modules'
import { listFinancialAccounts } from '@/modules/banking/sync'
import { listCustomers } from '@/modules/receivables/service'
import { listProperties } from '@/modules/properties/service'
import { occupancy, rentRoll } from '@/modules/properties/reporting'
import { listRentCharges, previewRentRun } from '@/modules/properties/billing'
import { depositsHeld } from '@/modules/properties/deposits'
import { PropertiesBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The properties workspace (spec §5 Real Estate / Property, Phase 23).
 *
 * Gated on the module rather than the industry, the same as inventory and time:
 * a general contractor who happens to own the unit next door has property, and
 * an estate agent who only sells has none.
 */
export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Properties</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to properties.
        </p>
      </main>
    )
  }

  if (!(await moduleEnabled(actor.companyId, 'properties'))) {
    return (
      <AppShell
        actor={actor}
        companyName={session.companyName}
        active="properties"
      >
        <div className="mx-auto max-w-2xl py-12 text-center">
          <h2 className="text-lg font-semibold">Properties is switched off</h2>
          <p className="mt-2 text-sm text-muted">
            Turn it on in{' '}
            <a className="text-action hover:underline" href="/settings/modules">
              company settings
            </a>{' '}
            to keep units and tenancies, run the rent, and hold deposits as a liability.
          </p>
        </div>
      </AppShell>
    )
  }

  const params = await searchParams
  const month = params.month ?? new Date().toISOString().slice(0, 7).concat('-01')

  const [properties, roll, stats, preview, charges, deposits, customers, accounts, terms] =
    await Promise.all([
      listProperties(actor),
      rentRoll(actor),
      occupancy(actor),
      previewRentRun(actor, { month }),
      listRentCharges(actor, { limit: 40 }),
      can(actor, 'reports:financial') ? depositsHeld(actor) : null,
      listCustomers(actor),
      listFinancialAccounts(actor),
      companyTerminology(actor.companyId),
    ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="properties"
    >
      <PropertiesBoard
        month={month}
        properties={properties.map((property) => ({
          id: property.id,
          code: property.code,
          name: property.name,
          city: property.city,
        }))}
        roll={roll}
        occupancy={stats}
        preview={preview}
        charges={charges}
        deposits={deposits}
        customers={customers.map((customer) => ({ id: customer.id, name: customer.name }))}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
        // The real-estate pack renames a customer to a Tenant (spec §5). The
        // record is the same `customers` row either way — only the word moves.
        tenantWord={terms.customer}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
