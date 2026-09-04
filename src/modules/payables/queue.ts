import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, creditNotes, users, vendors } from '@/db/schema'
import { balanceForAccount } from '@/modules/ledger/balances'
import { listFinancialAccounts } from '@/modules/banking/accounts'
import { bandFor } from '@/modules/banking/numbering'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { bucketFor, type PayableBill } from './run'
import type { ApprovableBill } from './approval'

/**
 * The work queue for money going out (spec §13).
 *
 * ## Why a queue rather than a report
 *
 * A/P aging has existed since Phase 2. It is an as-of snapshot: correct,
 * printable, and inert — nothing on it is clickable and nothing can be paid
 * from it. The bill list on the invoices screen is ordered by issue date with
 * no totals and no overdue marking.
 *
 * So the question a business asks itself every Friday — *what do I owe, what is
 * late, and can I cover it?* — had no screen, and the answer had to be
 * assembled by eye from a report and a list that disagree about ordering.
 *
 * This is the AP mirror of Phase 43's chase queue, and it stops at the same
 * place: it says what is owed and when. **Which supplier waits is a judgement
 * about relationships and cash, and no amount of arithmetic replaces it.**
 */

export type QueuedBill = PayableBill &
  ApprovableBill & {
    vendorReference: string | null
    issueDate: string
    bucket: ReturnType<typeof bucketFor>
    /** Credit sitting with this supplier that could reduce what is paid. */
    vendorCreditCents: number
    /**
     * Who entered it, by name. Null on bills raised before Phase 50.
     *
     * Carried so an approver can see whose work they are agreeing to without
     * leaving the screen — which is the whole substance of the two-person rule.
     */
    enteredByName: string | null
  }

/**
 * Everything open, oldest due first.
 *
 * Ordered by due date rather than by issue date, because the question is "what
 * has to be paid next" and a bill raised in January on 90-day terms is not more
 * urgent than one raised in March on 7-day terms.
 */
export async function payableQueue(
  ctx: ActorContext,
  opts: { asOf?: string; limit?: number } = {},
): Promise<QueuedBill[]> {
  requirePermission(ctx, 'accounting:view')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const rows = await db
    .select({
      id: bills.id,
      number: bills.number,
      vendorReference: bills.vendorReference,
      vendorId: bills.vendorId,
      vendorName: vendors.name,
      issueDate: bills.issueDate,
      dueDate: bills.dueDate,
      totalCents: bills.totalCents,
      balanceCents: bills.balanceCents,
      // The supplier's own currency, and what the balance is worth in ours
      // (Phase 60). Selected because everything above this line that adds or
      // compares amounts needs the second, and everything that shows one to a
      // person needs the first.
      currency: bills.currency,
      functionalBalanceCents: bills.functionalBalanceCents,
      functionalTotalCents: bills.functionalTotalCents,
      // Who entered it and who agreed to it (Phase 50). Carried on the queue
      // because the pay run decides from these and the screen shows them.
      enteredBy: bills.enteredBy,
      enteredByName: users.name,
      approvedBy: bills.approvedBy,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    // Left, not inner: a bill entered before Phase 50 has no `entered_by`, and
    // dropping those from the payables queue would hide real money.
    .leftJoin(users, eq(users.id, bills.enteredBy))
    .where(
      scoped(
        ctx,
        bills,
        inArray(bills.status, ['open', 'partial'] as const),
        gt(bills.balanceCents, 0),
      ),
    )
    .orderBy(asc(bills.dueDate), asc(bills.number))
    .limit(opts.limit ?? 200)

  const credits = await vendorCreditBalances(ctx)

  return rows.map((row) => ({
    ...row,
    bucket: bucketFor(row.dueDate, asOf),
    // In the bill's own currency: a credit raised in another one cannot
    // settle it, so offering it here would be the netting error again.
    vendorCreditCents: credits.get(vendorCreditKey(row.vendorId, row.currency)) ?? 0,
  }))
}

/** Key for a supplier's credit in one currency. See `vendorCreditBalances`. */
export function vendorCreditKey(vendorId: string, currency: string): string {
  return `${vendorId}:${currency}`
}

/**
 * Credit each supplier is still holding for us, per currency.
 *
 * Surfaced beside what is owed because it is the same money seen from the other
 * side, and a business paying a supplier in full while holding an unused credit
 * from them is paying twice for something it already sent back.
 *
 * **Per currency since Phase 122.** This summed `remaining_cents` across every
 * credit a supplier had, in whatever currency each was raised in, and the pay
 * run netted the total off what was owed. A €500 credit and a $500 credit came
 * back as "1000" of nothing, and that number came off a payment. Phase 62
 * settled the rule this now follows: money held in dollars settles nothing
 * denominated in euro, so a credit is only ever offered against a bill in its
 * own currency.
 */
export async function vendorCreditBalances(
  ctx: ActorContext,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      vendorId: creditNotes.vendorId,
      currency: creditNotes.currency,
      remainingCents: sql<string>`sum(${creditNotes.remainingCents})`,
    })
    .from(creditNotes)
    .where(
      scoped(
        ctx,
        creditNotes,
        eq(creditNotes.party, 'vendor'),
        gt(creditNotes.remainingCents, 0),
      ),
    )
    .groupBy(creditNotes.vendorId, creditNotes.currency)

  // `vendorId` is nullable on the table — exactly one of customer/vendor is
  // set, matching `party` — and the filter above already guarantees which.
  return new Map(
    rows
      .filter((row): row is typeof row & { vendorId: string } => row.vendorId !== null)
      .map((row) => [vendorCreditKey(row.vendorId, row.currency), Number(row.remainingCents)]),
  )
}

/** Unused vendor credits, so one can be chosen and applied to a bill. */
export async function openVendorCredits(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: creditNotes.id,
      number: creditNotes.number,
      issueDate: creditNotes.issueDate,
      vendorId: creditNotes.vendorId,
      vendorName: vendors.name,
      totalCents: creditNotes.totalCents,
      remainingCents: creditNotes.remainingCents,
      // Phase 124. A credit note is a document and carries its own currency;
      // the list somebody chooses from has to say which.
      currency: creditNotes.currency,
    })
    .from(creditNotes)
    .innerJoin(vendors, eq(vendors.id, creditNotes.vendorId))
    .where(
      scoped(
        ctx,
        creditNotes,
        eq(creditNotes.party, 'vendor'),
        gt(creditNotes.remainingCents, 0),
      ),
    )
    .orderBy(asc(creditNotes.issueDate))
}

/**
 * What each account holds — or owes, which is not the same thing.
 *
 * ## The defect browser verification found
 *
 * The picker offers every active account, and paying a supplier by company
 * credit card is perfectly ordinary. But a card's balance is what the business
 * **owes**, not what it has, and the screen said:
 *
 * > *Business Credit Card holds $1,404.79 on the ledger. $154.79 left
 * > afterwards.*
 *
 * That is exactly backwards. Paying $1,250 by card takes the debt to $2,654.79
 * — and somebody reading "$154.79 left" would think they had headroom.
 *
 * So a liability account reports **no available figure at all**. Its headroom
 * is its credit limit less its balance, and this system does not know the
 * limit; inventing one would be worse than saying nothing. `planRun` already
 * takes `availableCents: null` to mean "say nothing about coverage", which is
 * the honest answer here.
 *
 * The figure for a bank account is still the *ledger's*, not the bank's — a
 * cheque written last week may not have cleared — which is why a shortfall is
 * a warning rather than a refusal.
 */
export type AccountBalance = {
  id: string
  name: string
  mask: string | null
  kind: string
  chartAccountNumber: string
  /** What it holds. Null for a card, which owes rather than holds. */
  availableCents: number | null
  /** What is owed on it. Null for a bank account, which holds rather than owes. */
  owingCents: number | null
}

export async function accountsWithBalances(ctx: ActorContext): Promise<AccountBalance[]> {
  requirePermission(ctx, 'accounting:view')

  const accounts = await listFinancialAccounts(ctx, { activeOnly: true })

  return Promise.all(
    accounts.map(async (account) => {
      const balance = await balanceForAccount(ctx, account.chartAccountId)
      // Decided from the band the kind belongs to rather than by listing
      // kinds here, so a loan account gets the same treatment as a card
      // without anybody having to remember to add it.
      const owes = bandFor(account.kind).type === 'liability'

      return {
        id: account.id,
        name: account.name,
        mask: account.mask,
        kind: account.kind,
        chartAccountNumber: account.chartAccountNumber,
        availableCents: owes ? null : balance,
        owingCents: owes ? balance : null,
      }
    }),
  )
}

/** The bills a caller named, as the pay run needs them. Scoped and open only. */
export async function billsByIds(
  ctx: ActorContext,
  billIds: string[],
): Promise<QueuedBill[]> {
  if (billIds.length === 0) return []

  const queue = await payableQueue(ctx, { limit: 1000 })
  const wanted = new Set(billIds)

  return queue.filter((bill) => wanted.has(bill.id))
}

/** Used by the screen's heading: one number for "what we owe". */
export async function totalPayable(ctx: ActorContext): Promise<number> {
  const [row] = await db
    // Summed in the company's currency (Phase 60): this adds up every open
    // bill on the books, and adding euro to dollars produced a headline figure
    // with a dollar sign on it that was true of neither.
    .select({ total: sql<string>`coalesce(sum(${bills.functionalBalanceCents}), 0)` })
    .from(bills)
    .where(
      scoped(ctx, bills, and(inArray(bills.status, ['open', 'partial'] as const), gt(bills.balanceCents, 0))),
    )

  return Number(row?.total ?? 0)
}
