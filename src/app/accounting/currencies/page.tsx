import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { currenciesInUse, functionalCurrency, listRates } from '@/modules/fx/service'
import { foreignExposure, realisedMovement } from '@/modules/fx/reporting'
import { ACCOUNTING_NAV } from '../nav'
import { CurrencyBoard } from './board'
import { messageFor } from '@/modules/errors'

export const dynamic = 'force-dynamic'

/**
 * Currencies: the rates on file, and what the open foreign balances are worth
 * (spec §19, Phase 35).
 *
 * Not gated on an industry module. A consultancy in Ohio with one German client
 * needs this exactly as much as an importer does, and there is no pack that
 * describes "has a customer abroad".
 */
export default async function CurrenciesPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Currencies</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const params = await searchParams
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10)

  const [home, rates, inUse] = await Promise.all([
    functionalCurrency(actor.companyId),
    listRates(actor, { limit: 60 }),
    currenciesInUse(actor),
  ])

  // The exposure report is a financial one, so a bookkeeper who can enter a
  // rate still may not read what the position is worth.
  //
  // The conversion check that sat beside it needed only `reports:view` and is
  // gone (Phase 116): it asked whether a document carries what its own rate
  // produces, and the answer on correct books is routinely no — every
  // functional figure here is a sum of conversions rather than a conversion of
  // a sum. What is guaranteed instead is enforced by a database constraint, and
  // what a ledger holds against its subledger is on the operations page.
  const canSeeExposure = can(actor, 'reports:financial')

  // A missing closing rate is a refusal inside `foreignExposure`, and it is a
  // refusal worth showing rather than a page that fails to load: "you have open
  // euro invoices and no euro rate for today" is exactly the thing somebody
  // needs to be told.
  let exposure: Awaited<ReturnType<typeof foreignExposure>> | null = null
  let exposureError: string | null = null

  if (canSeeExposure) {
    try {
      exposure = await foreignExposure(actor, { asOf })
    } catch (error) {
      exposureError = messageFor(error, 'The exposure could not be worked out.')
    }
  }

  const realised = canSeeExposure ? await realisedMovement(actor) : null

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/currencies" />
      <CurrencyBoard
        functionalCurrency={home}
        asOf={asOf}
        rates={rates}
        currenciesInUse={inUse}
        exposure={exposure}
        exposureError={exposureError}
        realised={realised}
        canEnterRates={can(actor, 'accounting:journal')}
        canSeeExposure={canSeeExposure}
      />
    </AppShell>
  )
}
