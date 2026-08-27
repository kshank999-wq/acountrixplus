import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import {
  listBills,
  listCustomers,
  listInvoices,
  listVendors,
} from '@/modules/receivables/service'
import {
  documentLineAccounts,
  partiesWithOpenDocuments,
} from '@/modules/receivables/open-documents'
import { listFinancialAccounts } from '@/modules/banking/accounts'
import { ACCOUNTING_NAV } from '../nav'
import { InvoicesBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Raising an invoice, entering a bill, and recording what was paid
 * (spec §3, §13).
 *
 * ## Why this page did not exist until Phase 41
 *
 * Every one of these operations was built and tested in Phase 2, and every one
 * of them was reachable only as a by-product of some other module: a won
 * opportunity, a completed appointment, a repair order, a rent schedule, a
 * progress claim. A business that simply wanted to bill a customer for a day's
 * work had no screen at all.
 *
 * So this is first in the accounting nav. Everything else there is about what
 * happened to a document afterwards.
 */
export default async function InvoicesPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Invoices &amp; bills</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [
    invoices,
    bills,
    customers,
    vendors,
    revenueAccounts,
    costAccounts,
    owedByCustomers,
    owedToVendors,
    banks,
  ] = await Promise.all([
    listInvoices(actor, { limit: 60 }),
    listBills(actor, { limit: 60 }),
    listCustomers(actor),
    listVendors(actor),
    documentLineAccounts(actor, 'customer'),
    documentLineAccounts(actor, 'vendor'),
    partiesWithOpenDocuments(actor, 'customer'),
    partiesWithOpenDocuments(actor, 'vendor'),
    listFinancialAccounts(actor, { activeOnly: true }),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/invoices" />

      <InvoicesBoard
        invoices={invoices.map((row) => ({
          id: row.id,
          number: row.number,
          partyName: row.customerName,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          status: row.status,
          totalCents: row.totalCents,
          balanceCents: row.balanceCents,
        }))}
        bills={bills.map((row) => ({
          id: row.id,
          number: row.number,
          partyName: row.vendorName,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          status: row.status,
          totalCents: row.totalCents,
          balanceCents: row.balanceCents,
        }))}
        customers={customers.map((row) => ({ id: row.id, name: row.name }))}
        vendors={vendors.map((row) => ({ id: row.id, name: row.name }))}
        revenueAccounts={revenueAccounts.map((row) => ({
          id: row.id,
          label: `${row.number} · ${row.name}`,
        }))}
        costAccounts={costAccounts.map((row) => ({
          id: row.id,
          label: `${row.number} · ${row.name}`,
        }))}
        owedByCustomers={owedByCustomers}
        owedToVendors={owedToVendors}
        banks={banks.map((row) => ({ id: row.id, name: row.name }))}
        today={new Date().toISOString().slice(0, 10)}
        canManage={can(actor, 'accounting:journal')}
        canAddCustomer={can(actor, 'crm:manage')}
      />
    </AppShell>
  )
}
