import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  listCustomerSummaries,
  listVendorSummaries,
  sharedAddresses,
} from '@/modules/parties/service'
import { resolveAll } from '@/modules/parties/duplicates'
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
  const session = await requireSession()

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

  const [customers, vendors, homeCurrency, clashes] = await Promise.all([
    can(actor, 'crm:view') ? listCustomerSummaries(actor) : Promise.resolve([]),
    listVendorSummaries(actor),
    functionalCurrency(actor.companyId),
    sharedAddresses(actor),
  ])

  /**
   * What the nightly register found, resolved against what is already loaded
   * (Phase 95).
   *
   * No extra query: `PartySummary` has carried the whole footprint since Phase
   * 56 — every document ever, what is open, what is held. Asking the database
   * again for facts already on this page would be a second answer to one
   * question, and the two would disagree the moment somebody raised an invoice
   * between the queries.
   *
   * A reader without `crm:view` gets an empty customer list above, so a
   * customer clash here would name records they cannot see. Resolutions are
   * filtered to the sides they are allowed to read.
   */
  const visible = can(actor, 'crm:view') ? clashes : clashes.filter((c) => c.side === 'vendor')
  const resolutions = resolveAll(visible, [...customers, ...vendors])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/people" />
      <PeopleBoard
        customers={customers}
        vendors={vendors}
        canEditCustomers={can(actor, 'crm:manage')}
        canEditVendors={can(actor, 'accounting:journal')}
        homeCurrency={homeCurrency}
        sharedAddresses={resolutions}
        // Decided here rather than in the browser: an age computed from the
        // reader's own clock is one two people disagree about (Phase 56).
        asOf={new Date().toISOString().slice(0, 10)}
      />
    </AppShell>
  )
}
