import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listPayments } from '@/modules/receivables/payment-voiding'
import { ACCOUNTING_NAV } from '../nav'
import { PaymentsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Money in and out (spec §13, Phase 52).
 *
 * Payments have never been listed anywhere. They are recorded from the invoices
 * screen and the payables screen and then vanish into balances — so *"did that
 * $1,500 go in twice?"* was a question with no screen behind it, and taking one
 * back was impossible in any case.
 */
export default async function PaymentsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Money in and out</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  const rows = await listPayments(actor, { limit: 100, today })

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/payments" />
      <PaymentsBoard
        rows={rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          paymentDate: row.paymentDate,
          amountCents: row.amountCents,
          status: row.status,
          reference: row.reference,
          partyName: row.partyName,
          voidReason: row.voidReason,
          restorations: row.restorations.map((r) => ({
            number: r.number,
            amountCents: r.amountCents,
            status: r.status,
          })),
          verdict: row.verdict,
        }))}
        canVoid={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
