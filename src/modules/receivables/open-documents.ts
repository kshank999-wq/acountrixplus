import { eq, gt, inArray, notInArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, customers, invoices, vendors } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { OpenDocument } from './allocation'

/**
 * What somebody still owes, or is still owed (spec §13).
 *
 * Feeds the allocation core, which needs nothing but an id, a number, a
 * balance and two dates — so this returns exactly that and no more.
 *
 * ## What counts as open
 *
 * A positive balance and a status of `open` or `partial`. Deliberately not:
 *
 *  - **draft**, which is not owed by anybody yet;
 *  - **paid**, which has nothing left;
 *  - **void**, which never happened;
 *  - **written off**, which is the interesting one. A written-off invoice is
 *    real and owed and has been given up on, and money arriving against it is
 *    a *recovery* — Phase 11 built `recoverWriteOff` for exactly that, and it
 *    posts differently. Silently applying a receipt to it here would take the
 *    bad debt back off the P&L without anybody deciding to.
 */
export type PaymentSide = 'customer' | 'vendor'

export async function openDocumentsFor(
  ctx: ActorContext,
  side: PaymentSide,
  partyId: string,
): Promise<OpenDocument[]> {
  requirePermission(ctx, 'accounting:view')

  const OPEN = ['open', 'partial'] as const

  if (side === 'customer') {
    const rows = await db
      .select({
        id: invoices.id,
        number: invoices.number,
        balanceCents: invoices.balanceCents,
        dueDate: invoices.dueDate,
        issueDate: invoices.issueDate,
      })
      .from(invoices)
      .where(
        scoped(
          ctx,
          invoices,
          eq(invoices.customerId, partyId),
          inArray(invoices.status, OPEN),
          gt(invoices.balanceCents, 0),
        ),
      )

    return rows
  }

  const rows = await db
    .select({
      id: bills.id,
      number: bills.number,
      balanceCents: bills.balanceCents,
      dueDate: bills.dueDate,
      issueDate: bills.issueDate,
    })
    .from(bills)
    .where(
      scoped(
        ctx,
        bills,
        eq(bills.vendorId, partyId),
        inArray(bills.status, OPEN),
        gt(bills.balanceCents, 0),
      ),
    )

  return rows
}

/**
 * Everyone who currently owes something, or is owed something.
 *
 * Drives the payment form's party list: offering every customer on the books
 * when three of them have open invoices is how somebody records a receipt
 * against the wrong one.
 */
export async function partiesWithOpenDocuments(
  ctx: ActorContext,
  side: PaymentSide,
): Promise<Array<{ id: string; name: string; outstandingCents: number; documentCount: number }>> {
  requirePermission(ctx, 'accounting:view')

  const rows =
    side === 'customer'
      ? await db
          .select({
            id: customers.id,
            name: customers.name,
            balanceCents: invoices.balanceCents,
          })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .where(
            scoped(
              ctx,
              invoices,
              inArray(invoices.status, ['open', 'partial']),
              gt(invoices.balanceCents, 0),
            ),
          )
      : await db
          .select({
            id: vendors.id,
            name: vendors.name,
            balanceCents: bills.balanceCents,
          })
          .from(bills)
          .innerJoin(vendors, eq(vendors.id, bills.vendorId))
          .where(
            scoped(ctx, bills, inArray(bills.status, ['open', 'partial']), gt(bills.balanceCents, 0)),
          )

  const byParty = new Map<string, { id: string; name: string; outstandingCents: number; documentCount: number }>()

  for (const row of rows) {
    const entry = byParty.get(row.id) ?? {
      id: row.id,
      name: row.name,
      outstandingCents: 0,
      documentCount: 0,
    }
    entry.outstandingCents += row.balanceCents
    entry.documentCount += 1
    byParty.set(row.id, entry)
  }

  return [...byParty.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Accounts a document line can be coded to.
 *
 * An invoice line is income; a bill line is a cost or something bought — a
 * supplier bill for a van legitimately debits Fixed Assets, so assets are
 * offered.
 *
 * **Two kinds of account are held back even so**, because coding a line to one
 * silently breaks an invariant something else is checking:
 *
 *  - **The accounts something else maintains.** Receivables and payables are
 *    built from the documents underneath them. A bill line posted straight at
 *    1100 makes the control account disagree with the sum of open invoices,
 *    which is exactly the fault `ledger.receivables` exists to catch — raised
 *    by the tool that is supposed to prevent it. The class is
 *    `MAINTAINED_ACCOUNTS`, and reading it here rather than keeping a list is
 *    the whole of Phase 211.
 *  - **Cash.** Every bank and card account has a ledger account of its own
 *    (Phase 40), and its balance is tied out against its feed. "I owe a
 *    supplier, and the money went into my current account" is not a thing that
 *    happens, and recording it puts the tie-out permanently out.
 *
 * ## The sentence this docstring used to end on
 *
 * It read *"and one for stock debits Inventory"*, two sentences before the rule
 * about accounts whose invariant a line would break. Both were right and the
 * first was the exception to the second: measured in Phase 211, a $1,000 bill
 * line coded to 1400 put `inventory.lots` into a **fault** — Σ open lots 0
 * against a ledger of 100000 — and receiving the goods properly afterwards
 * doubled the difference instead of closing it, because the receipt posts its
 * own debit to the same account.
 *
 * `1500 Fixed Assets` stays on the list and the clause about the van stays
 * true, because there the bill line is the intended path and `registerAsset`
 * adopts the cost without posting it again. The register carries that argument
 * and the measurement behind it.
 */
export async function documentLineAccounts(ctx: ActorContext, side: PaymentSide) {
  requirePermission(ctx, 'accounting:view')

  const { chartAccounts, financialAccounts } = await import('@/db/schema')
  const { refusedAccountIds } = await import('@/modules/coa/maintained')

  const wanted =
    side === 'customer'
      ? (['revenue', 'other_income'] as const)
      : (['expense', 'cogs', 'other_expense', 'asset'] as const)

  const attachedToABankAccount = db
    .select({ id: financialAccounts.chartAccountId })
    .from(financialAccounts)
    .where(eq(financialAccounts.companyId, ctx.companyId))

  /**
   * Accounts something else maintains, which nothing may post to by hand.
   *
   * Resolved to ids for this company rather than filtered by number, because
   * the stock half of the class is not a list of numbers: an item may name any
   * account as the one its stock is carried on, and `stockCarryingAccountIds`
   * is the same function `reconcileInventory` compares against.
   *
   * Run for the customer side too, where it currently removes nothing — every
   * account the class names is an asset or a liability and an invoice line
   * offers revenue. That was measured rather than assumed, and asking the
   * question on both sides is what keeps it true if either list widens.
   */
  const maintainedElsewhere = await refusedAccountIds(ctx, 'documentLine')

  return db
    .select({
      id: chartAccounts.id,
      number: chartAccounts.number,
      name: chartAccounts.name,
      type: chartAccounts.type,
    })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        eq(chartAccounts.isActive, true),
        inArray(chartAccounts.type, wanted),
        // Omitted rather than given an empty list: `notInArray` over nothing
        // compiles to a predicate postgres-js will not bind, and `scoped`
        // drops an undefined condition.
        maintainedElsewhere.size > 0
          ? notInArray(chartAccounts.id, [...maintainedElsewhere])
          : undefined,
        // Cash is cash whether or not anybody has opened a bank account
        // against it. Filtering only on the `financial_accounts` link leaves a
        // brand-new company's 1000 Checking Account on the list, because
        // nobody has opened one yet — so the chart's own word for what an
        // account *is* has to do the work as well.
        // `subtype NOT IN (...)` is *unknown* rather than true when subtype is
        // NULL, and most expense accounts have no subtype — so written that
        // way this filtered out nearly the whole cost side.
        sql`(${chartAccounts.subtype} is null or ${chartAccounts.subtype} not in ('bank', 'cash', 'credit_card'))`,
        sql`${chartAccounts.id} not in ${attachedToABankAccount}`,
      ),
    )
    .orderBy(chartAccounts.number)
}
