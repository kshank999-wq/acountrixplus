import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { bills, creditNotes, customers, invoices, payments, vendors } from '@/db/schema'
import { DomainError } from '@/modules/errors'
import { updateCustomer, updateVendor } from '@/modules/receivables/service'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { clashesAmong, type Clash, type PartySide } from './addresses'
import {
  describeMerge,
  EXCLUSIVE_REFERENCES,
  mergeCheck,
  PARTY_REFERENCES,
  type MergeTally,
} from './merge'
import { reasonFor } from '@/modules/corrections/vocabulary'
import { recordAudit } from '@/modules/audit'
import { functionalCurrency } from '@/modules/fx/service'
import { comparableHoldings } from '@/modules/fx/holdings'
import { deactivationCheck } from './changes'

/**
 * The people a business trades with (spec §6, §13).
 *
 * Customers and vendors existed from Phase 2 as a dropdown inside the invoice
 * composer and nothing else — no page listing them, no way to reach one, and
 * no way to change one once created. This is the module that makes them
 * records somebody owns rather than rows somebody accidentally created.
 */

export type PartySummary = {
  id: string
  name: string
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  paymentTermsDays: number
  notes: string | null
  isActive: boolean
  /** Documents still open. What stops them being retired. */
  openDocuments: number
  /**
   * What their open documents come to, in the **home currency** (Phase 56).
   *
   * Functional, not face. This summed `balance_cents` until Phase 56, so a
   * customer with a €2,500 invoice was shown "$2,500.00" and one holding a
   * $1,000 and a €2,500 invoice was shown "$3,500.00" — which Phase 35 called
   * "3,500 of nothing with a dollar sign in front of it" when it fixed the
   * identical bug two queries away.
   */
  balanceCents: number
  /**
   * What is held against them: a customer's overpayment (Phase 53), or the
   * unspent part of a vendor credit (Phase 12).
   */
  heldCreditCents: number
  /**
   * What that figure stands for, when it stands for something (Phase 65).
   *
   * Null when every receipt behind it arrived in the company's own currency —
   * then the number and the truth are the same and there is nothing to add.
   */
  heldCreditNote: string | null
  /** The due date of the oldest thing still unpaid, so the figure has an age. */
  oldestDueDate: string | null
  /** True when any open document is in a currency other than the home one. */
  hasForeignDocuments: boolean
  /** Every document ever, so a quiet record is distinguishable from a new one. */
  documentCount: number
}

export type VendorSummary = PartySummary & {
  taxId: string | null
  is1099Vendor: boolean
}

/** The states a document is in while it is still somebody's business. */
const OPEN_STATUSES = ['open', 'partial'] as const

/**
 * Every customer, with enough about their trading to decide anything.
 *
 * The counts are joined rather than fetched per row. A list screen that runs
 * two queries per customer is one that stops loading at four hundred of them,
 * which is a size a real business reaches in a year.
 */
export async function listCustomerSummaries(ctx: ActorContext): Promise<PartySummary[]> {
  requirePermission(ctx, 'crm:view')

  // Phase 35's helper rather than a third inline copy of the same query.
  const home = await functionalCurrency(ctx.companyId)

  const trading = db
    .select({
      customerId: invoices.customerId,
      openDocuments: sql<string>`count(*) filter (where ${inArray(invoices.status, [...OPEN_STATUSES])})`.as(
        'open_documents',
      ),
      /**
       * The **home-currency** balance (Phase 56, and Phase 35's rule).
       *
       * `balance_cents` is what the document says; `functional_balance_cents` is
       * what it is worth on these books. Summing the first across currencies
       * produces a number with no meaning and a currency symbol that lies.
       */
      balanceCents: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}), 0)`.as(
        'balance_cents',
      ),
      /**
       * The oldest thing still unpaid, so the figure carries an age. Filtered
       * to documents with something left on them: a settled invoice from 2019
       * is not what makes an account late.
       */
      oldestDueDate: sql<string | null>`min(${invoices.dueDate}) filter (where ${invoices.balanceCents} > 0)`.as(
        'oldest_due_date',
      ),
      foreignCount: sql<string>`count(*) filter (where ${invoices.currency} <> ${home} and ${invoices.balanceCents} > 0)`.as(
        'foreign_count',
      ),
      documentCount: sql<string>`count(*)`.as('document_count'),
    })
    .from(invoices)
    .where(eq(invoices.companyId, ctx.companyId))
    .groupBy(invoices.customerId)
    .as('trading')

  /**
   * What the business is holding for each customer (Phase 53).
   *
   * A subquery rather than another join onto the grouped invoice rows, for the
   * reason Phase 54 gave when it did the same on the statement picker: joining
   * it alongside `invoices` multiplies the credit by the number of documents.
   * Void receipts hold nothing (Phase 52).
   */
  const heldCredit = db
    .select({
      customerId: payments.customerId,
      /**
       * The **functional** amount, not the face one (Phase 65).
       *
       * `balanceCents` beside it sums `invoices.functional_balance_cents`, and
       * Phase 54 nets one against the other. Summing the face amount here made
       * a €500 overpayment reduce a converted $4,334.00 balance by 500 —
       * subtracting euro from dollars and printing the result with a dollar
       * sign. Both terms are now in the company's own money.
       */
      heldCents: sql<string>`sum(${payments.functionalUnappliedCents})`.as('held_cents'),
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, ctx.companyId),
        eq(payments.status, 'posted'),
        sql`${payments.unappliedCents} > 0`,
      ),
    )
    .groupBy(payments.customerId)
    .as('held_credit')

  /**
   * The same holdings, per currency (Phase 65).
   *
   * A second pass rather than more columns on the subquery above: what the
   * screen sorts and nets on is one figure, and what it *says* is the truth
   * behind it. Rolling both into one grouped row would mean either a row per
   * currency — which multiplies every customer — or a string assembled in SQL.
   */
  const heldByParty = await db
    .select({
      customerId: payments.customerId,
      currency: payments.currency,
      unappliedCents: sql<string>`sum(${payments.unappliedCents})`,
      functionalUnappliedCents: sql<string>`sum(${payments.functionalUnappliedCents})`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, ctx.companyId),
        eq(payments.status, 'posted'),
        sql`${payments.unappliedCents} > 0`,
      ),
    )
    .groupBy(payments.customerId, payments.currency)

  const holdingsByParty = new Map<
    string,
    { currency: string; unappliedCents: number; functionalUnappliedCents: number }[]
  >()
  for (const row of heldByParty) {
    if (!row.customerId) continue
    const list = holdingsByParty.get(row.customerId) ?? []
    list.push({
      currency: row.currency,
      unappliedCents: Number(row.unappliedCents),
      functionalUnappliedCents: Number(row.functionalUnappliedCents),
    })
    holdingsByParty.set(row.customerId, list)
  }

  const rows = await db
    .select({
      customer: customers,
      openDocuments: trading.openDocuments,
      balanceCents: trading.balanceCents,
      oldestDueDate: trading.oldestDueDate,
      foreignCount: trading.foreignCount,
      documentCount: trading.documentCount,
      heldCreditCents: heldCredit.heldCents,
    })
    .from(customers)
    .leftJoin(trading, eq(trading.customerId, customers.id))
    .leftJoin(heldCredit, eq(heldCredit.customerId, customers.id))
    .where(scoped(ctx, customers))
    .orderBy(sql`lower(${customers.name})`)

  return rows.map((row) => ({
    id: row.customer.id,
    name: row.customer.name,
    email: row.customer.email,
    phone: row.customer.phone,
    addressLine1: row.customer.addressLine1,
    addressLine2: row.customer.addressLine2,
    city: row.customer.city,
    region: row.customer.region,
    postalCode: row.customer.postalCode,
    paymentTermsDays: row.customer.paymentTermsDays,
    notes: row.customer.notes,
    isActive: row.customer.isActive,
    openDocuments: Number(row.openDocuments ?? 0),
    balanceCents: Number(row.balanceCents ?? 0),
    heldCreditCents: Number(row.heldCreditCents ?? 0),
    // Null unless some of it arrived in another currency, in which case the
    // figure above is a conversion and Phase 61's rule applies: a converted
    // number shown without saying so is the defect (Phase 65).
    heldCreditNote: comparableHoldings(holdingsByParty.get(row.customer.id) ?? [], home).note,
    oldestDueDate: row.oldestDueDate ?? null,
    hasForeignDocuments: Number(row.foreignCount ?? 0) > 0,
    documentCount: Number(row.documentCount ?? 0),
  }))
}

export async function listVendorSummaries(ctx: ActorContext): Promise<VendorSummary[]> {
  requirePermission(ctx, 'accounting:view')

  // Phase 35's helper rather than a third inline copy of the same query.
  const home = await functionalCurrency(ctx.companyId)

  const trading = db
    .select({
      vendorId: bills.vendorId,
      openDocuments: sql<string>`count(*) filter (where ${inArray(bills.status, [...OPEN_STATUSES])})`.as(
        'open_documents',
      ),
      // The home-currency balance, for the reason on the customer side above.
      balanceCents: sql<string>`coalesce(sum(${bills.functionalBalanceCents}), 0)`.as(
        'balance_cents',
      ),
      oldestDueDate: sql<string | null>`min(${bills.dueDate}) filter (where ${bills.balanceCents} > 0)`.as(
        'oldest_due_date',
      ),
      foreignCount: sql<string>`count(*) filter (where ${bills.currency} <> ${home} and ${bills.balanceCents} > 0)`.as(
        'foreign_count',
      ),
      documentCount: sql<string>`count(*)`.as('document_count'),
    })
    .from(bills)
    .where(eq(bills.companyId, ctx.companyId))
    .groupBy(bills.vendorId)
    .as('trading')

  /**
   * The mirror of a customer's held credit: what a supplier still owes us back
   * (Phase 12). An unspent vendor credit reduces what the next payment run will
   * send them, so a screen showing the gross overstates what is about to leave
   * the bank — the same untruth the customer side told, pointing the other way.
   */
  const unspentCredit = db
    .select({
      vendorId: creditNotes.vendorId,
      /**
       * Functional, not face (Phase 65) — the identical defect one table over.
       * `balanceCents` beside it sums `bills.functional_balance_cents`, so a
       * €500 vendor credit was reducing a converted figure by 500. Phase 63
       * gave credit notes the column that makes this comparable.
       */
      heldCents: sql<string>`sum(${creditNotes.functionalRemainingCents})`.as('held_cents'),
    })
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.companyId, ctx.companyId),
        sql`${creditNotes.vendorId} is not null`,
        sql`${creditNotes.remainingCents} > 0`,
      ),
    )
    .groupBy(creditNotes.vendorId)
    .as('unspent_credit')

  // The same credits per currency, so the figure above can say what it stands
  // for when it is a conversion (Phase 65).
  const creditRows = await db
    .select({
      vendorId: creditNotes.vendorId,
      currency: creditNotes.currency,
      remainingCents: sql<string>`sum(${creditNotes.remainingCents})`,
      functionalRemainingCents: sql<string>`sum(${creditNotes.functionalRemainingCents})`,
    })
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.companyId, ctx.companyId),
        sql`${creditNotes.vendorId} is not null`,
        sql`${creditNotes.remainingCents} > 0`,
      ),
    )
    .groupBy(creditNotes.vendorId, creditNotes.currency)

  const byVendor = new Map<
    string,
    { currency: string; unappliedCents: number; functionalUnappliedCents: number }[]
  >()
  for (const row of creditRows) {
    if (!row.vendorId) continue
    const list = byVendor.get(row.vendorId) ?? []
    list.push({
      currency: row.currency,
      unappliedCents: Number(row.remainingCents),
      functionalUnappliedCents: Number(row.functionalRemainingCents),
    })
    byVendor.set(row.vendorId, list)
  }

  const creditNotesByVendor = new Map<string, string | null>(
    [...byVendor].map(([vendorId, held]) => [
      vendorId,
      comparableHoldings(held, home).note,
    ]),
  )

  const rows = await db
    .select({
      vendor: vendors,
      openDocuments: trading.openDocuments,
      balanceCents: trading.balanceCents,
      oldestDueDate: trading.oldestDueDate,
      foreignCount: trading.foreignCount,
      documentCount: trading.documentCount,
      heldCreditCents: unspentCredit.heldCents,
    })
    .from(vendors)
    .leftJoin(trading, eq(trading.vendorId, vendors.id))
    .leftJoin(unspentCredit, eq(unspentCredit.vendorId, vendors.id))
    .where(scoped(ctx, vendors))
    .orderBy(sql`lower(${vendors.name})`)

  return rows.map((row) => ({
    id: row.vendor.id,
    name: row.vendor.name,
    email: row.vendor.email,
    phone: row.vendor.phone,
    addressLine1: row.vendor.addressLine1,
    addressLine2: row.vendor.addressLine2,
    city: row.vendor.city,
    region: row.vendor.region,
    postalCode: row.vendor.postalCode,
    paymentTermsDays: row.vendor.paymentTermsDays,
    notes: row.vendor.notes,
    isActive: row.vendor.isActive,
    taxId: row.vendor.taxId,
    is1099Vendor: row.vendor.is1099Vendor,
    openDocuments: Number(row.openDocuments ?? 0),
    balanceCents: Number(row.balanceCents ?? 0),
    heldCreditCents: Number(row.heldCreditCents ?? 0),
    heldCreditNote: creditNotesByVendor.get(row.vendor.id) ?? null,
    oldestDueDate: row.oldestDueDate ?? null,
    hasForeignDocuments: Number(row.foreignCount ?? 0) > 0,
    documentCount: Number(row.documentCount ?? 0),
  }))
}

/** One customer, for a screen that is about to change them. */
export async function customerById(ctx: ActorContext, customerId: string) {
  requirePermission(ctx, 'crm:view')

  const [row] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, customerId)))
    .limit(1)

  if (!row) throw new DomainError('That customer is not on these books.')
  return row
}

/** One vendor. */
export async function vendorById(ctx: ActorContext, vendorId: string) {
  requirePermission(ctx, 'accounting:view')

  const [row] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, vendorId)))
    .limit(1)

  if (!row) throw new DomainError('That vendor is not on these books.')
  return row
}

/**
 * Retires a customer, or says what is in the way.
 *
 * An **archive**, not a delete. Every document ever raised still names them,
 * the aging report is unchanged, and nothing about the books moves. What it
 * stops is their appearing in a picker, which is the actual thing somebody
 * means by "we do not work with them any more".
 *
 * Refused while there is open business, and not for tidiness: a customer
 * hidden from every picker while still owing money is a debt nobody will
 * chase. The books stay right and the business quietly stops collecting.
 */
export async function setCustomerActive(
  ctx: ActorContext,
  customerId: string,
  isActive: boolean,
): Promise<{ name: string; isActive: boolean }> {
  requirePermission(ctx, 'crm:manage')

  if (!isActive) {
    const [position] = await db
      .select({
        openDocuments: sql<string>`count(*) filter (where ${inArray(invoices.status, [...OPEN_STATUSES])})`,
        balanceCents: sql<string>`coalesce(sum(${invoices.balanceCents}), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId)))

    const verdict = deactivationCheck({
      openDocuments: Number(position?.openDocuments ?? 0),
      balanceCents: Number(position?.balanceCents ?? 0),
    })

    if (!verdict.ok) throw new DomainError(verdict.message)
  }

  const updated = await updateCustomer(ctx, customerId, { isActive })
  return { name: updated.name, isActive: updated.isActive }
}

/** Retires a vendor. See `setCustomerActive` — the reasoning is the same. */
export async function setVendorActive(
  ctx: ActorContext,
  vendorId: string,
  isActive: boolean,
): Promise<{ name: string; isActive: boolean }> {
  requirePermission(ctx, 'accounting:journal')

  if (!isActive) {
    const [position] = await db
      .select({
        openDocuments: sql<string>`count(*) filter (where ${inArray(bills.status, [...OPEN_STATUSES])})`,
        balanceCents: sql<string>`coalesce(sum(${bills.balanceCents}), 0)`,
      })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, vendorId)))

    const verdict = deactivationCheck({
      openDocuments: Number(position?.openDocuments ?? 0),
      balanceCents: Number(position?.balanceCents ?? 0),
    })

    if (!verdict.ok) throw new DomainError(verdict.message)
  }

  const updated = await updateVendor(ctx, vendorId, { isActive })
  return { name: updated.name, isActive: updated.isActive }
}

/**
 * Every email address shared by two parties on the same side (Phase 94).
 *
 * Reads both registers and hands them to `clashesAmong`, which does the
 * deciding. The grouping is deliberately *not* pushed into SQL: the rule that
 * separates a defect from ordinary business — same side, not merely same
 * address — is the whole judgement of this phase, and it belongs where it can
 * be read and tested rather than inside a `group by`.
 *
 * Active parties only. An archived customer sharing an address with a live one
 * is the *result* of somebody already having tidied the duplicate up, and
 * reporting it would mean the fix never clears the finding.
 */
export async function sharedAddresses(ctx: ActorContext): Promise<Clash[]> {
  requirePermission(ctx, 'accounting:view')

  const [asCustomers, asVendors] = await Promise.all([
    db
      .select({ id: customers.id, name: customers.name, email: customers.email })
      .from(customers)
      .where(scoped(ctx, customers, eq(customers.isActive, true))),
    db
      .select({ id: vendors.id, name: vendors.name, email: vendors.email })
      .from(vendors)
      .where(scoped(ctx, vendors, eq(vendors.isActive, true))),
  ])

  return clashesAmong([
    ...asCustomers.map((row) => ({ side: 'customer' as const, ...row })),
    ...asVendors.map((row) => ({ side: 'vendor' as const, ...row })),
  ])
}

/**
 * Puts two records of one business together (Phase 96).
 *
 * Everything on the loser moves to the winner, the loser is archived pointing
 * at the winner, and both records' histories say so. One transaction: a merge
 * that committed half its tables would be exactly the silent data loss the
 * reference registry exists to prevent, and there is no undo to reach for.
 *
 * The tables are driven off `PARTY_REFERENCES` rather than written out here, so
 * the list a test verifies against the database catalogue is the same list this
 * function walks. Two lists would mean the verified one could be right while
 * the used one was wrong.
 *
 * `sql.raw` on the table and column: they come from that module-level constant,
 * never from a caller, and the tripwire test proves every entry names something
 * the database actually has. The party ids are still bound, as ids from a
 * request always must be.
 */
export async function mergeParties(
  ctx: ActorContext,
  input: { side: PartySide; winnerId: string; loserId: string; reason?: string | null },
): Promise<{ winnerName: string; loserName: string; moved: MergeTally[] }> {
  requirePermission(ctx, input.side === 'customer' ? 'crm:manage' : 'accounting:journal')

  const verdict = reasonFor({ kind: 'party.merge', reason: input.reason })
  if (!verdict.ok) throw new DomainError(verdict.why)

  const table = input.side === 'customer' ? customers : vendors
  const references = PARTY_REFERENCES[input.side]

  const [winner, loser] = await Promise.all(
    [input.winnerId, input.loserId].map(async (id) => {
      const [row] = await db
        .select({ id: table.id, name: table.name, isActive: table.isActive })
        .from(table)
        .where(scoped(ctx, table, eq(table.id, id)))
      return row
    }),
  )

  if (!winner || !loser) {
    throw new DomainError('One of those records no longer exists. Reload the page and try again.')
  }

  /**
   * The tables where both already hold a row that must be unique.
   *
   * Asked before the merge rather than caught afterwards: the database would
   * refuse with a constraint name, and "subcontractors_vendor_unique" is not a
   * sentence anybody can act on (Phase 47).
   */
  const collisions: string[] = []
  for (const ref of EXCLUSIVE_REFERENCES) {
    if (!references.some((one) => one.table === ref.table && one.column === ref.column)) continue

    const [row] = await db.execute(
      sql`select count(*)::int as n from ${sql.raw(`"${ref.table}"`)}
          where ${sql.raw(`"${ref.column}"`)} in (${winner.id}, ${loser.id})`,
    )
    if (Number((row as { n: number }).n) > 1) collisions.push(ref.table.replace(/_/g, ' '))
  }

  const check = mergeCheck({
    side: input.side,
    winner: { ...winner, standing: 'trading' },
    loser: { ...loser, standing: 'trading' },
    collisions,
  })
  if (!check.ok) throw new DomainError(check.why)

  return db.transaction(async (tx) => {
    const moved: MergeTally[] = []

    for (const ref of references) {
      const result = await tx.execute(
        sql`update ${sql.raw(`"${ref.table}"`)}
            set ${sql.raw(`"${ref.column}"`)} = ${winner.id}
            where ${sql.raw(`"${ref.column}"`)} = ${loser.id}
              and "company_id" = ${ctx.companyId}`,
      )
      const rows = (result as unknown as { count?: number }).count ?? 0
      if (rows > 0) moved.push({ table: ref.table, rows })
    }

    await tx
      .update(table)
      .set({ isActive: false, mergedIntoId: winner.id })
      .where(and(eq(table.companyId, ctx.companyId), eq(table.id, loser.id)))

    /**
     * Recorded on **both** records, not once.
     *
     * Somebody opening the surviving record months later needs to know it
     * absorbed another — otherwise its history begins mid-story with documents
     * that were never raised against it. Phase 71 renders both.
     */
    const shared = {
      side: input.side,
      reason: verdict.reason,
      moved,
      winner: { id: winner.id, name: winner.name },
      loser: { id: loser.id, name: loser.name },
    }
    const entityType = input.side === 'customer' ? 'customer' : 'vendor'

    await recordAudit(
      ctx,
      { action: 'party.merge', entityType, entityId: winner.id, after: { ...shared, role: 'absorbed' } },
      tx,
    )
    await recordAudit(
      ctx,
      {
        action: 'party.merge',
        entityType,
        entityId: loser.id,
        before: { isActive: true },
        after: { ...shared, role: 'merged_away', isActive: false },
      },
      tx,
    )

    return { winnerName: winner.name, loserName: loser.name, moved }
  })
}

/**
 * What a merge would move, before anybody commits to it (Phase 96).
 *
 * `merge.ts` says an operation that cannot be undone should show its work
 * first, and this is what makes that true rather than aspirational: the same
 * counts, from the same registry, that the merge itself will walk.
 *
 * Counting rows rather than moving them, so it is safe to call on opening a
 * panel. It reads slightly stale by the time somebody presses the button — a
 * colleague may raise an invoice in between — which is honest for a preview and
 * is why the merge recounts as it goes rather than trusting these numbers.
 */
export async function mergePreview(
  ctx: ActorContext,
  input: { side: PartySide; winnerId: string; loserId: string },
): Promise<{ tally: MergeTally[]; line: string }> {
  requirePermission(ctx, input.side === 'customer' ? 'crm:manage' : 'accounting:journal')

  const table = input.side === 'customer' ? customers : vendors

  const [winner, loser] = await Promise.all(
    [input.winnerId, input.loserId].map(async (id) => {
      const [row] = await db
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(scoped(ctx, table, eq(table.id, id)))
      return row
    }),
  )

  if (!winner || !loser) {
    throw new DomainError('One of those records no longer exists. Reload the page and try again.')
  }

  const tally: MergeTally[] = []
  for (const ref of PARTY_REFERENCES[input.side]) {
    const [row] = await db.execute(
      sql`select count(*)::int as n from ${sql.raw(`"${ref.table}"`)}
          where ${sql.raw(`"${ref.column}"`)} = ${loser.id}
            and "company_id" = ${ctx.companyId}`,
    )
    const rows = Number((row as { n: number }).n)
    if (rows > 0) tally.push({ table: ref.table, rows })
  }

  return {
    tally,
    line: describeMerge({
      side: input.side,
      winnerName: winner.name,
      loserName: loser.name,
      tally,
    }),
  }
}
