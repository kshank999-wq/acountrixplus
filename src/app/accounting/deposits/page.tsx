import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  depositLineAccounts,
  depositableAccounts,
  listDeposits,
  undepositedReceipts,
} from '@/modules/banking/deposits'
import { ACCOUNTING_NAV } from '../nav'
import { DepositBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Deposits and undeposited funds (spec §13).
 *
 * The screen exists because reconciliation matches one statement line at a
 * time: three cheques banked together are one line at the bank, and without a
 * deposit they are three in the books.
 */
export default async function DepositsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Deposits</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [waiting, deposits, accounts, lineAccounts] = await Promise.all([
    undepositedReceipts(actor),
    listDeposits(actor),
    depositableAccounts(actor),
    depositLineAccounts(actor),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/deposits" />
      <DepositBoard
        waiting={waiting.map((receipt) => ({
          id: receipt.id,
          paymentDate: receipt.paymentDate,
          amountCents: receipt.amountCents,
          currency: receipt.currency,
          customerName: receipt.customerName,
          reference: receipt.reference,
        }))}
        deposits={deposits.map((deposit) => ({
          id: deposit.id,
          number: deposit.number,
          depositDate: deposit.depositDate,
          totalCents: deposit.totalCents,
          receiptsCents: deposit.receiptsCents,
          currency: deposit.currency,
          functionalTotalCents: deposit.functionalTotalCents,
          accountName: deposit.accountName,
          voided: deposit.voidedAt !== null,
        }))}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
        lineAccounts={lineAccounts}
        canRecord={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
