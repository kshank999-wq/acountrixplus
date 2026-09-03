import { and, eq, gt, isNotNull, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  creditApplications,
  creditNotes,
  customers,
  invoiceWriteOffs,
  invoices,
  paymentApplications,
  payments,
  retainerApplications,
  vendors,
} from '@/db/schema'
import { scoped, type ActorContext } from '@/modules/tenancy/context'
import { convert, RATE_ONE } from '@/modules/fx/rates'
import { balanceAsAt, wasOpenAt, type AsAtBalance, type Settlement, type SettlementKind } from './as-at'

/**
 * What has settled a document since a date (spec §13, §19, Phase 108).
 *
 * Fetches what `as-at.ts` decides with. The four queries mirror
 * `SETTLEMENT_PATHS` one for one, and the test that keeps them honest asserts
 * that every declared path is read here — because the defect this phase fixes
 * came from a set of paths nothing enumerated.
 *
 * ## Why the amounts convert at the *document's* rate
 *
 * None of the four tables stores a functional amount; each records what was
 * settled in the document's own currency. Converting at the document's own
 * rate is not an approximation — it is the right answer, and the reason is the
 * shape of Phase 35's realised gain:
 *
 * Before a foreign invoice is settled, both the ledger and the document carry
 * it at the rate it was raised at. The difference between that and the rate on
 * the settlement day is booked as a **realised gain or loss in a separate entry
 * dated on the settlement**. So a report as at a date *before* the settlement
 * excludes that entry from the ledger side, and must exclude it from the
 * document side too — which is exactly what converting at the document's own
 * rate does.
 */

/** A document to restore, with the rate its own books were kept at. */
export type RestorableDocument = {
  id: string
  exchangeRateMillionths: number
}

const cents = (value: unknown) => Number(value ?? 0)

/**
 * Settlements after `asOf`, keyed by document id.
 *
 * Only rows strictly after the date are fetched: a payment dated on `asOf` is
 * money received that day, so a report as at that date already reflects it.
 * `balanceAsAt` applies the same rule, so the two cannot disagree about the
 * boundary.
 */
export async function settlementsAfter(
  ctx: ActorContext,
  kind: 'invoice' | 'bill',
  asOf: string,
  documents: RestorableDocument[],
): Promise<Map<string, Settlement[]>> {
  const byId = new Map(documents.map((document) => [document.id, document]))
  if (byId.size === 0) return new Map()

  const documentColumn = <T extends { invoiceId: unknown; billId: unknown }>(table: T) =>
    (kind === 'invoice' ? table.invoiceId : table.billId) as never

  const [paid, credited, writtenOff, drawn] = await Promise.all([
    db
      .select({
        documentId: documentColumn(paymentApplications),
        on: payments.paymentDate,
        cents: paymentApplications.amountCents,
      })
      .from(paymentApplications)
      .innerJoin(payments, eq(payments.id, paymentApplications.paymentId))
      .where(
        scoped(
          ctx,
          paymentApplications,
          and(
            isNotNull(documentColumn(paymentApplications)),
            gt(payments.paymentDate, asOf),
            // A voided payment put the balance back, so it never reduced it.
            sql`${payments.status} <> 'void'`,
          ),
        ),
      ),
    db
      .select({
        documentId: documentColumn(creditApplications),
        on: creditApplications.appliedOn,
        cents: creditApplications.amountCents,
      })
      .from(creditApplications)
      .where(
        scoped(
          ctx,
          creditApplications,
          and(
            isNotNull(documentColumn(creditApplications)),
            gt(creditApplications.appliedOn, asOf),
          ),
        ),
      ),
    // Write-offs and retainer draws exist for invoices only; a bill is not
    // written off and a client retainer never settles one.
    kind === 'invoice'
      ? db
          .select({
            documentId: invoiceWriteOffs.invoiceId,
            on: invoiceWriteOffs.writtenOffOn,
            cents: invoiceWriteOffs.amountCents,
          })
          .from(invoiceWriteOffs)
          .where(scoped(ctx, invoiceWriteOffs, gt(invoiceWriteOffs.writtenOffOn, asOf)))
      : Promise.resolve([]),
    kind === 'invoice'
      ? db
          .select({
            documentId: retainerApplications.invoiceId,
            on: retainerApplications.appliedOn,
            cents: retainerApplications.amountCents,
          })
          .from(retainerApplications)
          .where(scoped(ctx, retainerApplications, gt(retainerApplications.appliedOn, asOf)))
      : Promise.resolve([]),
  ])

  const settlements = new Map<string, Settlement[]>()

  const add = (
    rows: Array<{ documentId: unknown; on: unknown; cents: unknown }>,
    settlementKind: SettlementKind,
  ) => {
    for (const row of rows) {
      const documentId = row.documentId as string | null
      if (!documentId) continue
      const document = byId.get(documentId)
      if (!document) continue

      const face = cents(row.cents)
      const list = settlements.get(documentId) ?? []
      list.push({
        kind: settlementKind,
        on: String(row.on),
        cents: face,
        functionalCents: convert(face, document.exchangeRateMillionths),
      })
      settlements.set(documentId, list)
    }
  }

  add(paid, 'payment')
  add(credited, 'credit_note')
  add(writtenOff as never[], 'write_off')
  add(drawn as never[], 'retainer')

  return settlements
}

/**
 * Credit notes with something still on them **as at a date**, by party.
 *
 * A credit note reduces the control account when it is issued (Phase 106) and
 * its `remaining_cents` falls later, as it is applied to particular invoices.
 * So a report as at March must count a credit issued in March at what was still
 * unapplied *then* — and put back anything applied since, exactly as the
 * invoice side puts back the matching reduction. Restoring only one of the two
 * would move the subledger by the application amount and reintroduce the
 * disagreement this phase exists to remove.
 */
export async function openCreditsAsAt(
  ctx: ActorContext,
  party: 'customer' | 'vendor',
  asOf: string,
): Promise<Array<{ partyId: string | null; cents: number; documents: number }>> {
  const partyColumn = party === 'customer' ? creditNotes.customerId : creditNotes.vendorId

  const notes = await db
    .select({
      id: creditNotes.id,
      partyId: partyColumn,
      remaining: creditNotes.functionalRemainingCents,
      rate: creditNotes.exchangeRateMillionths,
    })
    .from(creditNotes)
    .where(
      scoped(
        ctx,
        creditNotes,
        and(
          eq(creditNotes.party, party),
          sql`${creditNotes.status} <> 'void'`,
          lte(creditNotes.issueDate, asOf),
        ),
      ),
    )

  if (notes.length === 0) return []

  const applied = await db
    .select({
      creditNoteId: creditApplications.creditNoteId,
      cents: sql<string>`coalesce(sum(${creditApplications.amountCents}), 0)`,
    })
    .from(creditApplications)
    .where(scoped(ctx, creditApplications, gt(creditApplications.appliedOn, asOf)))
    .groupBy(creditApplications.creditNoteId)

  const since = new Map(applied.map((row) => [row.creditNoteId, cents(row.cents)]))
  const byParty = new Map<string | null, { cents: number; documents: number }>()

  for (const note of notes) {
    const restored =
      cents(note.remaining) + convert(since.get(note.id) ?? 0, note.rate ?? RATE_ONE)
    if (restored === 0) continue

    const existing = byParty.get(note.partyId) ?? { cents: 0, documents: 0 }
    existing.cents += restored
    existing.documents += 1
    byParty.set(note.partyId, existing)
  }

  return [...byParty.entries()].map(([partyId, sums]) => ({ partyId, ...sums }))
}

/** One document as it stood on the date asked about. */
export type OpenDocumentAsAt = {
  id: string
  partyId: string
  partyName: string
  issueDate: string
  dueDate: string
  currency: string
  /** In the document's own currency, as at the date. */
  balanceCents: number
  /** In the company's own currency, as at the date. */
  functionalBalanceCents: number
  /** What was put back to get here. Empty for a report asked about today. */
  restored: AsAtBalance['undone']
}

/**
 * Every document that was an obligation on `asOf`, at what it owed then.
 *
 * **One query for both readers.** The aging report and the control-account
 * check each used to select their own open documents with their own status
 * filter, and this whole family of defects — Phases 106, 107 and this one —
 * came from those two answering the same question differently. There is one
 * answer now, and they share it.
 *
 * The status filter is deliberately wide: everything except a draft (never an
 * obligation) and a void (erased from both sides of the books, see `as-at.ts`).
 * A **paid** or **written-off** document is included, because it was open
 * before it was settled, and excluding it is precisely how a historical aging
 * came to show $1,241.94 where $49,791.94 was outstanding.
 */
export async function openDocumentsAsAt(
  ctx: ActorContext,
  kind: 'invoice' | 'bill',
  asOf: string,
): Promise<OpenDocumentAsAt[]> {
  const rows =
    kind === 'invoice'
      ? await db
          .select({
            id: invoices.id,
            partyId: customers.id,
            partyName: customers.name,
            issueDate: invoices.issueDate,
            dueDate: invoices.dueDate,
            currency: invoices.currency,
            balanceCents: invoices.balanceCents,
            functionalBalanceCents: invoices.functionalBalanceCents,
            rate: invoices.exchangeRateMillionths,
          })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .where(
            scoped(ctx, invoices, sql`${invoices.status} not in ('draft', 'void')`, lte(invoices.issueDate, asOf)),
          )
      : await db
          .select({
            id: bills.id,
            partyId: vendors.id,
            partyName: vendors.name,
            issueDate: bills.issueDate,
            dueDate: bills.dueDate,
            currency: bills.currency,
            balanceCents: bills.balanceCents,
            functionalBalanceCents: bills.functionalBalanceCents,
            rate: bills.exchangeRateMillionths,
          })
          .from(bills)
          .innerJoin(vendors, eq(vendors.id, bills.vendorId))
          .where(
            scoped(ctx, bills, sql`${bills.status} not in ('draft', 'void')`, lte(bills.issueDate, asOf)),
          )

  const settlements = await settlementsAfter(
    ctx,
    kind,
    asOf,
    rows.map((row) => ({ id: row.id, exchangeRateMillionths: row.rate ?? RATE_ONE })),
  )

  return rows
    .map((row) => {
      const restored = balanceAsAt(
        {
          balanceCents: cents(row.balanceCents),
          functionalBalanceCents: cents(row.functionalBalanceCents),
        },
        settlements.get(row.id) ?? [],
        asOf,
      )

      return {
        id: row.id,
        partyId: row.partyId,
        partyName: row.partyName,
        issueDate: row.issueDate,
        dueDate: row.dueDate,
        currency: row.currency,
        balanceCents: restored.balanceCents,
        functionalBalanceCents: restored.functionalBalanceCents,
        restored: restored.undone,
      }
    })
    .filter((document) => wasOpenAt(document, { ...document, undone: [] }, asOf))
}
