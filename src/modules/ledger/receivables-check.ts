import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, creditNotes, customers, invoices, vendors } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { balanceForAccount } from './balances'
import { accountByNumber } from '@/modules/coa/service'
import {
  composition,
  reconcile,
  type ControlAccount,
  type DocumentKind,
  type PartyAmount,
} from './control-account'

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
 *
 * ## What Phase 106 corrected
 *
 * The subledger side was summed from open **invoices** alone, and invoices are
 * not the only document that posts to `1100`. A credit note credits it the
 * moment it is issued — `applyCredit` posts no entry, because the money already
 * moved — so between issuing a credit and applying it this check reported a
 * *fault* on a state the application fully supports. `2000` had the same hole
 * from the other side, via vendor credits.
 *
 * Which document moves which account, and in which direction, now lives in
 * `control-account.ts` as declared data, so the next document type to post at a
 * control account has to answer the question rather than default to invisible.
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
  /**
   * What the subledger figure is made of (Phase 106).
   *
   * "2 invoices worth $1,000.00, 1 credit note less $300.00". Carried even when
   * the two agree, because the figure is no longer just the invoices and a
   * reader who remembers when it was should be able to see why it differs.
   */
  composition: string
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

/**
 * Credit notes with something still on them, by party.
 *
 * `party` rather than a separate table: customer credit notes and vendor
 * credits are the same row shape in `credit_notes`, told apart by that column,
 * which is why both control accounts read from here.
 *
 * `functional_remaining_cents` for the same reason the document sides use
 * `functional_balance_cents` — the ledger half of this comparison is always in
 * the company's own money, and summing a euro credit's face value against a
 * dollar control account would report every foreign customer as a discrepancy
 * (Phase 35, Phase 65).
 */
async function openCredits(
  ctx: ActorContext,
  party: 'customer' | 'vendor',
): Promise<Array<{ partyId: string | null; cents: number; documents: number }>> {
  const partyColumn = party === 'customer' ? creditNotes.customerId : creditNotes.vendorId

  const rows = await db
    .select({
      partyId: partyColumn,
      cents: sql<string>`coalesce(sum(${creditNotes.functionalRemainingCents}), 0)`,
      documents: sql<string>`count(${creditNotes.id})`,
    })
    .from(creditNotes)
    .where(
      scoped(
        ctx,
        creditNotes,
        and(
          eq(creditNotes.party, party),
          ne(creditNotes.status, 'void'),
          sql`${creditNotes.remainingCents} > 0`,
        ),
      ),
    )
    .groupBy(partyColumn)

  return rows.map((row) => ({
    partyId: row.partyId,
    cents: Number(row.cents),
    documents: Number(row.documents),
  }))
}

/**
 * Turns one control account's documents into the shape the core reconciles.
 *
 * The two sides differ only in which tables they read, so the assembly and
 * every decision about signs, netting and wording is shared — which is the
 * point: the payables hole existed because the two functions were written twice
 * and only one of them was ever revisited.
 */
function toAmounts(
  kind: DocumentKind,
  rows: Array<{ id: string; name: string; cents: number; documents: number }>,
): PartyAmount[] {
  return rows.map((row) => ({ ...row, kind }))
}

function assemble(
  account: ControlAccount,
  accountNumber: string,
  accountName: string,
  ledgerCents: number,
  amounts: PartyAmount[],
): ControlAccountCheck {
  const result = reconcile(account, ledgerCents, amounts)

  return {
    accountNumber,
    accountName,
    ledgerCents: result.ledgerCents,
    subledgerCents: result.subledgerCents,
    differenceCents: result.differenceCents,
    agrees: result.agrees,
    documents: result.documents,
    parties: result.parties.map((party) => ({
      id: party.id,
      name: party.name,
      balanceCents: party.balanceCents,
    })),
    composition: composition(result),
  }
}

async function receivablesCheck(
  ctx: ActorContext,
  asOf?: string,
): Promise<ControlAccountCheck> {
  const account = await accountByNumber(ctx.companyId, '1100')

  const ledgerCents = account ? await balanceForAccount(ctx, account.id, { endDate: asOf }) : 0

  const [invoiceRows, creditRows] = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.name,
        cents: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}), 0)`,
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
      .groupBy(customers.id, customers.name),
    openCredits(ctx, 'customer'),
  ])

  // The credit rows carry an id and no name, because they were grouped on the
  // foreign key. Named from the invoice rows where possible, and from the
  // customer table where the only document a party has is a credit.
  const names = await partyNames(
    ctx,
    'customer',
    creditRows.map((row) => row.partyId),
  )

  return assemble(
    'receivables',
    '1100',
    account?.name ?? 'Accounts Receivable',
    ledgerCents,
    [
      ...toAmounts(
        'invoice',
        invoiceRows.map((row) => ({
          id: row.id,
          name: row.name,
          cents: Number(row.cents),
          documents: Number(row.documents),
        })),
      ),
      ...toAmounts(
        'credit_note',
        creditRows
          .filter((row): row is typeof row & { partyId: string } => row.partyId !== null)
          .map((row) => ({
            id: row.partyId,
            name: names.get(row.partyId) ?? 'Unknown customer',
            cents: row.cents,
            documents: row.documents,
          })),
      ),
    ],
  )
}

async function payablesCheck(ctx: ActorContext, asOf?: string): Promise<ControlAccountCheck> {
  const account = await accountByNumber(ctx.companyId, '2000')

  // A liability read on its normal side, so both figures here are positive when
  // money is owed and the comparison is between two numbers of the same sign.
  const ledgerCents = account ? await balanceForAccount(ctx, account.id, { endDate: asOf }) : 0

  const [billRows, creditRows] = await Promise.all([
    db
      .select({
        id: vendors.id,
        name: vendors.name,
        cents: sql<string>`coalesce(sum(${bills.functionalBalanceCents}), 0)`,
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
      .groupBy(vendors.id, vendors.name),
    openCredits(ctx, 'vendor'),
  ])

  const names = await partyNames(
    ctx,
    'vendor',
    creditRows.map((row) => row.partyId),
  )

  return assemble('payables', '2000', account?.name ?? 'Accounts Payable', ledgerCents, [
    ...toAmounts(
      'bill',
      billRows.map((row) => ({
        id: row.id,
        name: row.name,
        cents: Number(row.cents),
        documents: Number(row.documents),
      })),
    ),
    ...toAmounts(
      'vendor_credit',
      creditRows
        .filter((row): row is typeof row & { partyId: string } => row.partyId !== null)
        .map((row) => ({
          id: row.partyId,
          name: names.get(row.partyId) ?? 'Unknown supplier',
          cents: row.cents,
          documents: row.documents,
        })),
    ),
  ])
}

/** Names for parties known only by id, so a credit-only party is still named. */
async function partyNames(
  ctx: ActorContext,
  party: 'customer' | 'vendor',
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const wanted = ids.filter((id): id is string => id !== null)
  if (wanted.length === 0) return new Map()

  const table = party === 'customer' ? customers : vendors
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(scoped(ctx, table, inArray(table.id, wanted)))

  return new Map(rows.map((row) => [row.id, row.name]))
}
