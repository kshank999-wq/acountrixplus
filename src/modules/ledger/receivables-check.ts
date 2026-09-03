import { inArray } from 'drizzle-orm'
import { db } from '@/db'
import { customers, vendors } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { openCreditsAsAt, openDocumentsAsAt } from './settlement-history'
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
 * Both sides are measured **as at the same date** (Phase 108). Until then the
 * ledger walked back to `asOf` and the documents did not, so any date but today
 * reported a fault on healthy books — measured at $45,758.75 on the development
 * database for 31 March. The caveat that stood here said reconstructing a
 * historical document balance "means replaying every payment application, which
 * is a bigger machine than this check justifies"; all four paths that reduce a
 * balance keep a dated row, so it is four sums, and `as-at.ts` does them.
 */
export async function controlAccounts(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<ControlAccountReport> {
  requirePermission(ctx, 'reports:view')

  // Defaulted in one place so both sides ask about the same day. The clock is
  // read here and nowhere below, which keeps every function under this one a
  // function of its arguments.
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const [receivables, payables] = await Promise.all([
    receivablesCheck(ctx, asOf),
    payablesCheck(ctx, asOf),
  ])

  return { receivables, payables, agrees: receivables.agrees && payables.agrees }
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
  asOf: string,
): Promise<ControlAccountCheck> {
  const account = await accountByNumber(ctx.companyId, '1100')

  const ledgerCents = account ? await balanceForAccount(ctx, account.id, { endDate: asOf }) : 0

  // Both sides as at the same date (Phase 108). `openDocumentsAsAt` is shared
  // with the aging report, so the two cannot disagree about which documents
  // were obligations then.
  const [documents, creditRows] = await Promise.all([
    openDocumentsAsAt(ctx, 'invoice', asOf),
    openCreditsAsAt(ctx, 'customer', asOf),
  ])

  // The credit rows carry an id and no name, because they were grouped on the
  // foreign key. Named from the customer table, which also covers a party
  // whose only document is a credit.
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
        documents.map((document) => ({
          id: document.partyId,
          name: document.partyName,
          cents: document.functionalBalanceCents,
          documents: 1,
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

async function payablesCheck(ctx: ActorContext, asOf: string): Promise<ControlAccountCheck> {
  const account = await accountByNumber(ctx.companyId, '2000')

  // A liability read on its normal side, so both figures here are positive when
  // money is owed and the comparison is between two numbers of the same sign.
  const ledgerCents = account ? await balanceForAccount(ctx, account.id, { endDate: asOf }) : 0

  const [documents, creditRows] = await Promise.all([
    openDocumentsAsAt(ctx, 'bill', asOf),
    openCreditsAsAt(ctx, 'vendor', asOf),
  ])

  const names = await partyNames(
    ctx,
    'vendor',
    creditRows.map((row) => row.partyId),
  )

  return assemble('payables', '2000', account?.name ?? 'Accounts Payable', ledgerCents, [
    ...toAmounts(
      'bill',
      documents.map((document) => ({
        id: document.partyId,
        name: document.partyName,
        cents: document.functionalBalanceCents,
        documents: 1,
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
