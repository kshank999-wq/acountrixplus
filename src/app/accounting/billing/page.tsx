import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listAccounts } from '@/modules/coa/service'
import { listCustomers } from '@/modules/receivables/service'
import { listSchedules, scheduleDetail } from '@/modules/billing/service'
import { awaitingRaise, billingForecast, type Forecast } from '@/modules/billing/reporting'
import { ACCOUNTING_NAV } from '../nav'
import { BillingBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Arrangements to bill a customer every period (spec §13, Phase 37).
 *
 * Not gated on an industry module. A retainer client, a maintenance contract
 * and a subscription are the same arrangement, and there is no pack that
 * describes "bills somebody the same amount every month".
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string }>
}) {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Recurring billing</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const params = await searchParams

  // Setting a schedule up means choosing a customer, and `listCustomers` needs
  // `crm:view` — which an accountant does not have. Guarded rather than
  // assumed: an accountant can read the arrangements and run them, and the
  // form to create one is simply absent, instead of the page failing to load.
  const canPickCustomers = can(actor, 'crm:view')

  const [schedules, waiting, customers, accounts] = await Promise.all([
    listSchedules(actor),
    awaitingRaise(actor),
    canPickCustomers ? listCustomers(actor) : Promise.resolve([]),
    listAccounts(actor),
  ])

  const selected = schedules.find((row) => row.id === params.s) ?? schedules[0] ?? null
  const detail = selected ? await scheduleDetail(actor, selected.id) : null

  // The forecast is a financial report; a bookkeeper can set an arrangement up
  // without being able to read what it adds up to. The same split as Phase 36.
  const canForecast = can(actor, 'reports:financial')
  const forecast: Forecast | null = canForecast ? await billingForecast(actor) : null

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/billing" />
      <BillingBoard
        schedules={schedules}
        selectedId={selected?.id ?? null}
        detail={
          detail
            ? {
                lines: detail.lines.map((line) => ({
                  id: line.id,
                  description: line.description,
                  quantityMilli: line.quantityMilli,
                  unitPriceCents: line.unitPriceCents,
                })),
                history: detail.history.map((row) => ({
                  id: row.id,
                  occurredOn: row.occurredOn,
                  totalCents: row.totalCents,
                  invoiceNumber: row.invoiceNumber,
                  invoiceStatus: row.invoiceStatus,
                  balanceCents: row.balanceCents,
                  invoiceCurrency: row.invoiceCurrency,
                })),
                perOccurrenceCents: detail.perOccurrenceCents,
              }
            : null
        }
        waiting={waiting}
        forecast={forecast}
        canForecast={canForecast}
        canManage={can(actor, 'accounting:journal')}
        canCreate={can(actor, 'accounting:journal') && canPickCustomers}
        customers={customers.map((row) => ({ id: row.id, name: row.name }))}
        accounts={accounts
          .filter((account) => ['revenue', 'other_income'].includes(account.type))
          .map((account) => ({ id: account.id, number: account.number, name: account.name }))}
      />
    </AppShell>
  )
}
