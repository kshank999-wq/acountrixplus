import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listCustomerSummaries, listVendorSummaries } from '@/modules/parties/service'
import { functionalCurrency } from '@/modules/fx/service'
import { ACCOUNTING_NAV } from '../nav'
import { PeopleBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * The people a business trades with (spec §6, §13).
 *
 * Customers and vendors have existed since Phase 2 as a dropdown inside the
 * invoice composer and nothing else. There was no page that listed them, no
 * way to reach one, and no way to change one — so a typo in an email meant
 * that customer could never be sent anything again.
 */
export default async function PeoplePage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Customers and suppliers</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [customers, vendors, homeCurrency] = await Promise.all([
    can(actor, 'crm:view') ? listCustomerSummaries(actor) : Promise.resolve([]),
    listVendorSummaries(actor),
    functionalCurrency(actor.companyId),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/people" />
      <PeopleBoard
        customers={customers}
        vendors={vendors}
        canEditCustomers={can(actor, 'crm:manage')}
        canEditVendors={can(actor, 'accounting:journal')}
        homeCurrency={homeCurrency}
        // Decided here rather than in the browser: an age computed from the
        // reader's own clock is one two people disagree about (Phase 56).
        asOf={new Date().toISOString().slice(0, 10)}
      />
    </AppShell>
  )
}
