import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { badDebtSummary, listCreditNotes, listWriteOffs } from '@/modules/receivables/credits'
import { customersWithBalances, listStatements } from '@/modules/receivables/statements'
import { listInvoices } from '@/modules/receivables/service'
import { remittanceAccounts } from '@/modules/payroll/remittance'
import { ACCOUNTING_NAV } from '../nav'
import { ReceivablesBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Credits, write-offs, and statements (spec §13, Phase 11).
 *
 * One page for the three things that happen to a receivable other than being
 * paid. Keeping them together is the point: the choice between crediting a
 * debt and writing it off is made once, quickly, and usually by somebody who
 * has not thought about which is which — so the two live side by side with
 * their difference stated.
 */
export default async function ReceivablesPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Receivables</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const year = new Date().getUTCFullYear()

  const [credits, writeOffs, badDebt, customers, statements, openInvoices, banks] = await Promise.all([
    listCreditNotes(actor, { limit: 25 }),
    listWriteOffs(actor, { limit: 25 }),
    badDebtSummary(actor, { startDate: `${year}-01-01`, endDate: `${year}-12-31` }).catch(() => ({
      count: 0,
      writtenOffCents: 0,
      recoveredCents: 0,
      netCents: 0,
    })),
    customersWithBalances(actor),
    listStatements(actor, { limit: 20 }),
    listInvoices(actor, { limit: 100 }),
    // Bank accounts, for recording that a written-off debt was paid after all.
    can(actor, 'tax:view') ? remittanceAccounts(actor) : Promise.resolve([]),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/receivables" />

      <ReceivablesBoard
        badDebt={badDebt}
        credits={credits.map((row) => ({
          id: row.id,
          number: row.number,
          issueDate: row.issueDate,
          customerId: row.customerId,
          customerName: row.customerName,
          status: row.status,
          totalCents: row.totalCents,
          remainingCents: row.remainingCents,
          reason: row.reason,
        }))}
        writeOffs={writeOffs.map((row) => ({
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName,
          writtenOffOn: row.writtenOffOn,
          amountCents: row.amountCents,
          reason: row.reason,
          recoveredOn: row.recoveredOn,
          recoveredCents: row.recoveredCents,
        }))}
        customers={customers.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          balanceCents: Number(row.balanceCents),
          openCount: Number(row.openCount),
        }))}
        statements={statements.map((row) => ({
          id: row.id,
          customerName: row.customerName,
          kind: row.kind,
          asOfDate: row.asOfDate,
          closingBalanceCents: row.closingBalanceCents,
          sentTo: row.sentTo,
        }))}
        openInvoices={openInvoices
          .filter((row) => row.balanceCents > 0 && row.status !== 'void')
          .map((row) => ({
            id: row.id,
            number: row.number,
            customerId: row.customerId,
            customerName: row.customerName,
            balanceCents: row.balanceCents,
            dueDate: row.dueDate,
          }))}
        banks={banks.map((row) => ({ id: row.id, name: row.name }))}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
