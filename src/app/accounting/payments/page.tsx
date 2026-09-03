import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listPayments } from '@/modules/receivables/payment-voiding'
import { heldCredits } from '@/modules/receivables/customer-credit'
import { openDocumentsFor } from '@/modules/receivables/open-documents'
import { listFinancialAccounts } from '@/modules/banking/accounts'
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
  const session = await requireSession()

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

  const [rows, credits, accounts] = await Promise.all([
    listPayments(actor, { limit: 100, today }),
    heldCredits(actor),
    listFinancialAccounts(actor),
  ])

  // The invoices each holder could put their credit against. Read here rather
  // than in the browser because a credit belongs to one customer and may only
  // settle that customer's documents — offering anything else would be
  // offering a refusal.
  const openByCustomer = new Map<string, { id: string; number: string; balanceCents: number }[]>()
  for (const credit of credits) {
    if (openByCustomer.has(credit.customerId)) continue
    const open = await openDocumentsFor(actor, 'customer', credit.customerId)
    openByCustomer.set(
      credit.customerId,
      open.map((row) => ({ id: row.id, number: row.number, balanceCents: row.balanceCents })),
    )
  }

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/payments" />
      <PaymentsBoard
        rows={rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          paymentDate: row.paymentDate,
          amountCents: row.amountCents,
          // What money the payment moved, and the same money converted at the
          // rate it moved at — the row shows the first, the tiles add the
          // second (Phase 115).
          currency: row.currency,
          functionalAmountCents: row.functionalAmountCents,
          status: row.status,
          reference: row.reference,
          partyName: row.partyName,
          voidReason: row.voidReason,
          restorations: row.restorations.map((r) => ({
            number: r.number,
            amountCents: r.amountCents,
            // The document's currency, which need not be the payment's.
            currency: r.currency,
            status: r.status,
          })),
          verdict: row.verdict,
          // Date only: the hour an advice went is noise beside the day, and a
          // raw Date would not survive the server boundary anyway.
          remittanceSentAt: row.remittanceSentAt
            ? row.remittanceSentAt.toISOString().slice(0, 10)
            : null,
          remittanceSendCount: row.remittanceSendCount,
        }))}
        credits={credits.map((row) => ({
          paymentId: row.paymentId,
          customerId: row.customerId,
          customerName: row.customerName,
          paymentDate: row.paymentDate,
          reference: row.reference,
          availableCents: row.availableCents,
          // Which money that held amount is in (Phase 115). Without it the
          // screen rendered €2,000 as "$2,000.00" — the right number under the
          // wrong sign, which is worse than no number at all.
          currency: row.currency,
          openInvoices: openByCustomer.get(row.customerId) ?? [],
        }))}
        accounts={accounts.map((row) => ({ id: row.id, name: row.name, mask: row.mask }))}
        today={today}
        canVoid={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
