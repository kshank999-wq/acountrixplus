import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { listServiceItems } from '@/modules/studio/service'
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
import { listTaxCodes } from '@/modules/payroll/sales-tax'
import { suspectedDuplicateBills } from '@/modules/payables/duplicates'
import { currencyChoices } from '@/modules/fx/service'
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
  const session = await requireSession()

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
    sellableItems,
    owedByCustomers,
    owedToVendors,
    banks,
    duplicates,
    currencies,
    taxCodes,
  ] = await Promise.all([
    listInvoices(actor, { limit: 60 }),
    listBills(actor, { limit: 60 }),
    listCustomers(actor),
    listVendors(actor),
    documentLineAccounts(actor, 'customer'),
    documentLineAccounts(actor, 'vendor'),
    /*
      The sellable catalogue, so an invoice line can say which item it sold
      (Phase 169). Active items only: a deactivated item should not be sellable,
      while the lines already pointing at one keep their reference.
    */
    listServiceItems(actor),
    partiesWithOpenDocuments(actor, 'customer'),
    partiesWithOpenDocuments(actor, 'vendor'),
    listFinancialAccounts(actor),
    suspectedDuplicateBills(actor, { limit: 25 }),
    // What the composer may offer, and which of them is home (Phase 64).
    currencyChoices(actor),
    /*
      The sales tax codes an invoice line may be taxed under (Phase 209).

      A list **or null**, where null means this reader may not see the company's
      tax codes — which hides the picker and, with it, any claim about what an
      invoice is taxed under. An empty list would have hidden the control and
      still implied there was nothing to choose. Phase 208's shape, for the same
      reason: `tax:view` is separate from `accounting:view`, and `readonly` has
      the second without the first.

      Active only. A code the company has retired should not be offered on a new
      invoice, while every line already pointing at one keeps its frozen rate —
      which is this list function's `activeOnly` opt-in taking its first offer
      site in 209 phases.

      And the flag is **inert today**, which is said here rather than left for
      somebody to discover: `tax_codes.is_active` has no writer anywhere in the
      application, so no code can be retired and this filter can only ever drop
      a row somebody set false in the database by hand. The flag is passed all
      the same, because the alternative is an offer site that goes wrong the
      moment a retire control exists.

      Measuring ADR 0208's nomination is what found it, and `employees` is the
      same shape and worse: one insert, no update, so `is_active` and `end_date`
      have no writer either and an employee cannot be recorded as having left.
      Neither is a column census finding, because `listTaxCodes` and
      `listEmployees` select every row and filter in JavaScript — so the string
      `taxCodes.isActive` is never written, and the scan's rule for a column
      being read is that something names it.
    */
    can(actor, 'tax:view') ? listTaxCodes(actor, { activeOnly: true }) : Promise.resolve(null),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
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
          currency: row.currency,
          totalCents: row.totalCents,
          balanceCents: row.balanceCents,
          sentAt: row.sentAt ? row.sentAt.toISOString().slice(0, 10) : null,
          sentTo: row.sentTo,
          viewCount: row.viewCount,
          shareToken: row.shareToken,
        }))}
        bills={bills.map((row) => ({
          id: row.id,
          number: row.number,
          vendorReference: row.vendorReference,
          partyName: row.vendorName,
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          status: row.status,
          currency: row.currency,
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
        sellableItems={sellableItems.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          unitPriceCents: row.unitPriceCents,
          chartAccountId: row.chartAccountId,
          isInventoried: row.isInventoried,
        }))}
        duplicates={duplicates.map((pair) => ({
          vendorName: pair.vendorName,
          keptNumber: pair.keptNumber,
          keptReference: pair.keptReference,
          keptIssueDate: pair.keptIssueDate,
          suspectNumber: pair.suspectNumber,
          suspectReference: pair.suspectReference,
          suspectIssueDate: pair.suspectIssueDate,
          totalCents: pair.totalCents,
          suspectBalanceCents: pair.suspectBalanceCents,
          // Phase 124. Bills carry a currency; two suppliers are two of them.
          currency: pair.currency,
          why: pair.why,
        }))}
        owedByCustomers={owedByCustomers}
        owedToVendors={owedToVendors}
        banks={banks.map((row) => ({ id: row.id, name: row.name }))}
        taxCodes={
          taxCodes &&
          taxCodes.map((row) => ({
            id: row.id,
            code: row.code,
            jurisdiction: row.jurisdiction,
            rateBp: row.rateBp,
            isExempt: row.isExempt,
          }))
        }
        homeCurrency={currencies.homeCurrency}
        currencies={currencies.offerable}
        today={new Date().toISOString().slice(0, 10)}
        canManage={can(actor, 'accounting:journal')}
        canAddCustomer={can(actor, 'crm:manage')}
      />
    </AppShell>
  )
}
