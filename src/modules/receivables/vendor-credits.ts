import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  billLines,
  bills,
  chartAccounts,
  creditApplications,
  creditNoteLines,
  creditNotes,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import { formatCents } from '@/lib/money'

/**
 * Vendor credits (spec §13: "vendors, bills, **credits**, payments, aging").
 *
 * ## The mirror, and where the mirror stops
 *
 * A vendor credit is a customer credit note reflected: the supplier agreed we
 * owe them less, so the payable falls and the expense that was recognized when
 * the bill arrived is taken back off.
 *
 * ```
 *   Customer credit note        Vendor credit
 *   ─────────────────────       ─────────────────────
 *   Dr  Revenue      100        Dr  Accounts Payable  100
 *       Cr  AR       100            Cr  Expense       100
 * ```
 *
 * It shares `credit_notes` with the customer side rather than getting its own
 * table — one `party` column, the same way `payments` holds both receipts and
 * disbursements. Two tables would mean two copies of the remaining-balance
 * arithmetic, the application rules, and the aging treatment, and the first
 * bug fixed in one would leave the other wrong.
 *
 * ## What deliberately has no mirror
 *
 * There is **no vendor write-off**. A customer write-off says money owed to us
 * will not arrive, which is a loss and an expense. The reflection would be a
 * debt we owe that the supplier stopped chasing — and writing that off as
 * income is a judgement about whether the obligation is really extinguished,
 * not a bookkeeping operation. It needs a person and usually a lawyer, so it
 * is a manual journal entry rather than a button.
 */

export type VendorCreditLineInput = {
  chartAccountId: string
  description: string
  quantityMilli?: number
  unitPriceCents: number
}

export type VendorCreditInput = {
  vendorId: string
  issueDate: string
  /** When set, defaults the lines to this bill's accounts and amounts. */
  billId?: string
  lines?: VendorCreditLineInput[]
  taxCents?: number
  reason?: string
  memo?: string
  number?: string
  /** Apply it to the named bill immediately. Only with `billId`. */
  applyImmediately?: boolean
}

export async function createVendorCredit(ctx: ActorContext, input: VendorCreditInput) {
  requirePermission(ctx, 'accounting:journal')

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, input.vendorId)))
    .limit(1)

  if (!vendor) throw new Error('Vendor not found')

  const apAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsPayable)
  if (!apAccount) throw new Error('Accounts Payable is missing from the chart.')

  let bill: typeof bills.$inferSelect | null = null

  if (input.billId) {
    const [row] = await db
      .select()
      .from(bills)
      .where(scoped(ctx, bills, eq(bills.id, input.billId)))
      .limit(1)

    if (!row) throw new Error('Bill not found')
    if (row.vendorId !== input.vendorId) {
      throw new Error('That bill belongs to a different vendor.')
    }
    if (row.status === 'void') throw new Error('That bill is voided.')
    bill = row
  }

  // Defaulting to the bill's own lines is what makes the credit land on the
  // expense account the cost was booked to. A single "purchase returns"
  // account would balance and tell nobody which cost went away.
  const lines = input.lines?.length
    ? input.lines.map((line, index) => ({
        ...line,
        quantityMilli: line.quantityMilli ?? 1000,
        amountCents: Math.round(((line.quantityMilli ?? 1000) * line.unitPriceCents) / 1000),
        sortOrder: index,
      }))
    : await defaultLinesFromBill(ctx, bill)

  if (lines.length === 0) {
    throw new Error('A vendor credit needs at least one line, or a bill to credit.')
  }

  for (const line of lines) {
    if (line.amountCents <= 0) {
      throw new Error('Vendor credit amounts are positive; the direction is what makes it a credit.')
    }
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxCents = input.taxCents ?? 0
  const totalCents = subtotalCents + taxCents

  if (bill && totalCents > bill.totalCents) {
    throw new Error(
      `A credit of ${formatCents(totalCents)} is more than bill ${bill.number} was for ` +
        `(${formatCents(bill.totalCents)}).`,
    )
  }

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextVendorCreditNumber(ctx, tx))

    const [note] = await tx
      .insert(creditNotes)
      .values({
        companyId: ctx.companyId,
        party: 'vendor',
        customerId: null,
        vendorId: input.vendorId,
        number,
        issueDate: input.issueDate,
        invoiceId: null,
        billId: bill?.id ?? null,
        status: 'open',
        subtotalCents,
        taxCents,
        totalCents,
        remainingCents: totalCents,
        reason: input.reason ?? null,
        memo: input.memo ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(creditNoteLines).values(
      lines.map((line) => ({
        companyId: ctx.companyId,
        creditNoteId: note.id,
        chartAccountId: line.chartAccountId,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        amountCents: line.amountCents,
        sortOrder: line.sortOrder,
      })),
    )

    // The mirror of the bill entry: payable down, expense back out.
    const journalLineInputs = [
      { chartAccountId: apAccount.id, debitCents: totalCents, memo: `Vendor credit ${number}` },
      ...lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        creditCents: line.amountCents,
        memo: line.description,
      })),
    ]

    if (taxCents > 0) {
      const taxAccount = await accountByNumber(ctx.companyId, '2200', tx)
      if (!taxAccount) throw new Error('Sales Tax Payable is missing from the chart.')
      journalLineInputs.push({
        chartAccountId: taxAccount.id,
        creditCents: taxCents,
        memo: 'Tax credited',
      })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.issueDate,
        memo: `Vendor credit ${number} — ${vendor.name}`,
        // Sourced as `bill` so the cash-basis transformation removes it with
        // the bills, which is the whole point: on a cash basis neither the
        // cost nor its reversal ever happened.
        source: 'bill',
        sourceType: 'vendor_credit',
        sourceId: note.id,
        lines: journalLineInputs,
      },
      tx,
    )

    await tx.update(creditNotes).set({ journalEntryId: entry.id }).where(eq(creditNotes.id, note.id))

    await recordAudit(
      ctx,
      {
        action: 'vendor_credit.create',
        entityType: 'credit_note',
        entityId: note.id,
        after: {
          number,
          vendor: vendor.name,
          totalCents,
          againstBill: bill?.number ?? null,
          reason: input.reason ?? null,
        },
      },
      tx,
    )

    if (input.applyImmediately && bill) {
      const applied = await applyVendorCreditWithin(ctx, tx, {
        creditNoteId: note.id,
        billId: bill.id,
        amountCents: Math.min(totalCents, bill.balanceCents),
        appliedOn: input.issueDate,
      })

      // `note` was read before the application ran, so its `remainingCents` is
      // the figure from before. Returning it would tell the caller the credit
      // is fully available at the moment it was spent.
      return {
        ...note,
        journalEntryId: entry.id,
        remainingCents: applied.creditRemainingCents,
        status: applied.creditRemainingCents === 0 ? ('applied' as const) : note.status,
      }
    }

    return { ...note, journalEntryId: entry.id }
  })
}

async function defaultLinesFromBill(ctx: ActorContext, bill: typeof bills.$inferSelect | null) {
  if (!bill) return []

  const rows = await db
    .select()
    .from(billLines)
    .where(and(eq(billLines.companyId, ctx.companyId), eq(billLines.billId, bill.id)))
    .orderBy(asc(billLines.sortOrder))

  return rows.map((row, index) => ({
    chartAccountId: row.chartAccountId,
    description: row.description,
    quantityMilli: row.quantityMilli,
    unitPriceCents: row.unitPriceCents,
    amountCents: row.amountCents,
    sortOrder: index,
  }))
}

/**
 * Applies an open vendor credit to a bill.
 *
 * No journal entry, for the same reason the customer side posts none: the
 * credit already moved the payable when it was issued, and applying it only
 * decides which bill the reduction belongs to.
 */
export async function applyVendorCredit(
  ctx: ActorContext,
  input: { creditNoteId: string; billId: string; amountCents: number; appliedOn: string },
) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction((tx) => applyVendorCreditWithin(ctx, tx, input))
}

async function applyVendorCreditWithin(
  ctx: ActorContext,
  tx: Executor,
  input: { creditNoteId: string; billId: string; amountCents: number; appliedOn: string },
) {
  if (input.amountCents <= 0) throw new Error('An application must be greater than zero.')

  const [note] = await tx
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, input.creditNoteId), eq(creditNotes.companyId, ctx.companyId)))
    .limit(1)

  if (!note) throw new Error('Vendor credit not found')
  if (note.party !== 'vendor') {
    throw new Error('That is a customer credit note. It cannot be applied to a bill.')
  }
  if (note.status === 'void') throw new Error('That vendor credit is voided.')

  const [bill] = await tx
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.companyId, ctx.companyId)))
    .limit(1)

  if (!bill) throw new Error('Bill not found')
  if (bill.vendorId !== note.vendorId) {
    throw new Error('A credit can only be applied to the same vendor’s bill.')
  }

  if (input.amountCents > note.remainingCents) {
    throw new Error(
      `Only ${formatCents(note.remainingCents)} of vendor credit ${note.number} is left to apply.`,
    )
  }
  if (input.amountCents > bill.balanceCents) {
    throw new Error(
      `Bill ${bill.number} has a balance of ${formatCents(bill.balanceCents)}, ` +
        `so ${formatCents(input.amountCents)} cannot be applied to it.`,
    )
  }

  await tx.insert(creditApplications).values({
    companyId: ctx.companyId,
    creditNoteId: note.id,
    invoiceId: null,
    billId: bill.id,
    amountCents: input.amountCents,
    appliedOn: input.appliedOn,
  })

  const noteRemaining = note.remainingCents - input.amountCents
  await tx
    .update(creditNotes)
    .set({
      remainingCents: noteRemaining,
      status: noteRemaining === 0 ? 'applied' : 'open',
      updatedAt: new Date(),
    })
    .where(eq(creditNotes.id, note.id))

  const billBalance = bill.balanceCents - input.amountCents
  await tx
    .update(bills)
    .set({
      balanceCents: billBalance,
      status: billBalance === 0 ? 'paid' : 'partial',
      updatedAt: new Date(),
    })
    .where(eq(bills.id, bill.id))

  await recordAudit(
    ctx,
    {
      action: 'vendor_credit.apply',
      entityType: 'credit_note',
      entityId: note.id,
      after: {
        bill: bill.number,
        amountCents: input.amountCents,
        creditRemainingCents: noteRemaining,
      },
    },
    tx,
  )

  return { creditRemainingCents: noteRemaining, billBalanceCents: billBalance }
}

export async function listVendorCredits(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: creditNotes.id,
      number: creditNotes.number,
      issueDate: creditNotes.issueDate,
      vendorId: creditNotes.vendorId,
      vendorName: vendors.name,
      status: creditNotes.status,
      totalCents: creditNotes.totalCents,
      remainingCents: creditNotes.remainingCents,
      reason: creditNotes.reason,
    })
    .from(creditNotes)
    .innerJoin(vendors, eq(vendors.id, creditNotes.vendorId))
    .where(scoped(ctx, creditNotes, eq(creditNotes.party, 'vendor')))
    .orderBy(desc(creditNotes.issueDate), desc(creditNotes.number))
    .limit(opts.limit ?? 50)
}

/** The accounts a vendor credit may be raised against, for the UI. */
export async function vendorCreditableAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({ id: chartAccounts.id, number: chartAccounts.number, name: chartAccounts.name })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        sql`${chartAccounts.type} IN ('cogs', 'expense', 'other_expense')`,
      ),
    )
    .orderBy(asc(chartAccounts.number))
}

async function nextVendorCreditNumber(ctx: ActorContext, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(creditNotes)
    .where(and(eq(creditNotes.companyId, ctx.companyId), eq(creditNotes.party, 'vendor')))

  return `VC-${1001 + Number(row?.count ?? 0)}`
}
