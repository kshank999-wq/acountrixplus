import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, customers, invoices, vendors } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { balanceForAccount } from './balances'
import { accountByNumber } from '@/modules/coa/service'

/**
 * Does the balance sheet agree with the people it names? (spec §13, §19)
 *
 * ## Why this exists
 *
 * Accounts Receivable is a *control account*: the ledger's one-line summary of
 * a subledger made of customers. The two are maintained by different code —
 * the ledger by journal entries, the subledger by invoices and the payments
 * applied to them — and they are supposed to agree exactly.
 *
 * When they do not, the failure is quiet and nasty. The balance sheet says
 * £365 is owed; the aging report says nothing is owed; both are internally
 * consistent, and neither mentions the other. Nobody chases the money, because
 * the report a person would chase from does not know about it.
 *
 * **This is not a hypothetical.** Phases 29 and 30 gave appointments and repair
 * orders their own posting: `Dr 1100 / Cr revenue`, with no invoice behind it.
 * Both worked, both balanced, both were tested — and both produced exactly that
 * split. A garage owner could read £365 of receivables off the balance sheet
 * and have no way to find out who owed it. This check is what would have caught
 * it on the first day, and is why Phase 31 both fixes the cause and adds the
 * detector.
 *
 * The same argument applies to Accounts Payable, so both are here.
 */

export type ControlAccountCheck = {
  /** The account this summarises: '1100' or '2000'. */
  accountNumber: string
  accountName: string
  /** What the ledger says, from posted journal lines. */
  ledgerCents: number
  /** What the subledger says, from the documents themselves. */
  subledgerCents: number
  differenceCents: number
  agrees: boolean
  /** How many open documents make up the subledger side. */
  documents: number
  /**
   * Named parties holding a balance, worst first.
   *
   * Included so a difference is actionable rather than merely alarming: the
   * first question after "they disagree" is always "by how much, and against
   * whom".
   */
  /**
   * Who owes it, in the books' own currency (Phase 35).
   *
   * `functional_balance_cents` rather than `balance_cents`: the ledger side of
   * this comparison is always functional, and summing a euro invoice's face
   * value against a dollar control account would report every foreign customer
   * as a discrepancy the moment they were invoiced.
   */
  parties: Array<{ id: string; name: string; balanceCents: number }>
}

export type ControlAccountReport = {
  receivables: ControlAccountCheck
  payables: ControlAccountCheck
  /** True only when both sides agree. */
  agrees: boolean
}

/**
 * Both control accounts, against the documents behind them.
 *
 * `asOf` is a parameter and never a clock read, like every other report in this
 * application: an accountant checking last month's close needs last month's
 * answer, not today's.
 *
 * One caveat is worth stating rather than hiding. The ledger side is measured
 * **as at a date**, while the subledger side is the balance a document carries
 * **now** — invoices do not keep a history of what they were owed on an
 * arbitrary past date. So an `asOf` in the past compares a historical ledger
 * with a present subledger, and will differ by anything paid since. Left this
 * way deliberately: reconstructing historical document balances means replaying
 * every payment application, which is a bigger machine than this check
 * justifies, and the honest default — today — is the one anybody actually runs.
 */
export async function controlAccounts(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<ControlAccountReport> {
  requirePermission(ctx, 'reports:view')

  const [receivables, payables] = await Promise.all([
    receivablesCheck(ctx, opts.asOf),
    payablesCheck(ctx, opts.asOf),
  ])

  return { receivables, payables, agrees: receivables.agrees && payables.agrees }
}

/** Statuses that still owe something. A void document owes nothing by definition. */
const OPEN_INVOICE_STATUSES = ['open', 'partial', 'written_off'] as const

async function receivablesCheck(
  ctx: ActorContext,
  asOf?: string,
): Promise<ControlAccountCheck> {
  const account = await accountByNumber(ctx.companyId, '1100')

  const ledgerCents = account ? await balanceForAccount(ctx, account.id, { endDate: asOf }) : 0

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      balanceCents: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}), 0)`,
      documents: sql<string>`count(${invoices.id})`,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      scoped(
        ctx,
        invoices,
        and(
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          ne(invoices.balanceCents, 0),
        ),
      ),
    )
    .groupBy(customers.id, customers.name)
    .orderBy(sql`coalesce(sum(${invoices.functionalBalanceCents}), 0) desc`)

  const parties = rows.map((row) => ({
    id: row.id,
    name: row.name,
    balanceCents: Number(row.balanceCents),
  }))

  const subledgerCents = parties.reduce((sum, row) => sum + row.balanceCents, 0)

  return {
    accountNumber: '1100',
    accountName: account?.name ?? 'Accounts Receivable',
    ledgerCents,
    subledgerCents,
    differenceCents: ledgerCents - subledgerCents,
    agrees: ledgerCents === subledgerCents,
    documents: rows.reduce((sum, row) => sum + Number(row.documents), 0),
    parties,
  }
}

async function payablesCheck(ctx: ActorContext, asOf?: string): Promise<ControlAccountCheck> {
  const account = await accountByNumber(ctx.companyId, '2000')

  // A liability read on its normal side, so both figures here are positive when
  // money is owed and the comparison is between two numbers of the same sign.
  const ledgerCents = account ? await balanceForAccount(ctx, account.id, { endDate: asOf }) : 0

  const rows = await db
    .select({
      id: vendors.id,
      name: vendors.name,
      balanceCents: sql<string>`coalesce(sum(${bills.functionalBalanceCents}), 0)`,
      documents: sql<string>`count(${bills.id})`,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(
      scoped(
        ctx,
        bills,
        and(inArray(bills.status, ['open', 'partial']), ne(bills.balanceCents, 0)),
      ),
    )
    .groupBy(vendors.id, vendors.name)
    .orderBy(sql`coalesce(sum(${bills.functionalBalanceCents}), 0) desc`)

  const parties = rows.map((row) => ({
    id: row.id,
    name: row.name,
    balanceCents: Number(row.balanceCents),
  }))

  const subledgerCents = parties.reduce((sum, row) => sum + row.balanceCents, 0)

  return {
    accountNumber: '2000',
    accountName: account?.name ?? 'Accounts Payable',
    ledgerCents,
    subledgerCents,
    differenceCents: ledgerCents - subledgerCents,
    agrees: ledgerCents === subledgerCents,
    documents: rows.reduce((sum, row) => sum + Number(row.documents), 0),
    parties,
  }
}
