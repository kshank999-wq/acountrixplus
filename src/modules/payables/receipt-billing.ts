import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { goodsReceipts, vendors } from '@/db/schema'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createBill, DocumentError } from '@/modules/receivables/service'
import { createJournalEntry } from '@/modules/ledger/journal'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import {
  describeMatch,
  matchVerdict,
  worthMentioning,
  type BillableReceipt,
} from './receipting'

/**
 * Raising the supplier's bill for goods already received (spec §5, §13).
 *
 * ## The entries, and why they are these
 *
 * Ten thousand pounds of timber arrives on Monday. `receiveGoods` posts:
 *
 *     receipt   Dr Inventory              10,000.00   Cr Goods Received Not Invoiced  10,000.00
 *
 * The supplier's invoice arrives on Friday for 10,150.00. This posts:
 *
 *     bill      Dr Goods Received Not Invoiced 10,000.00
 *               Dr Purchase Price Variance        150.00   Cr Accounts Payable  10,150.00
 *
 * `2050` goes back to zero for that delivery, the timber stays on the balance
 * sheet at what it was taken in at, and the 150 shows on the profit and loss
 * as what it is: a cost of buying.
 *
 * **What was happening instead:** the bill could only be coded to an expense or
 * an asset, so it posted `Dr Inventory 10,150 / Cr Accounts Payable 10,150` —
 * counting the timber twice and leaving 10,000 in `2050` that nothing in the
 * application could ever debit.
 *
 * ## Why this is its own entry point
 *
 * `documentLineAccounts` deliberately refuses to offer `2050` on a bill,
 * alongside receivables, payables and accumulated depreciation: *"accounts
 * something else maintains, which nothing may post to by hand"*. That rule is
 * right and stays. **This is the something else.** A caller reaching for this
 * function has named the deliveries it is clearing, so the amount is derived
 * rather than typed, and the receipts are marked in the same transaction.
 */

export type ReceiptBillResult = {
  billId: string
  billNumber: string
  clearedCents: number
  varianceCents: number
  /** Worth a person's attention. Null when it matched, or matched closely. */
  notice: string | null
}

/**
 * Bills a set of goods receipts.
 *
 * Everything about the posting is derived from the receipts themselves except
 * the total, which is what the supplier is asking for. Nothing here accepts a
 * chart account: the two it uses are the two it is allowed to use.
 */
export async function billReceipts(
  ctx: ActorContext,
  input: {
    vendorId: string
    receiptIds: string[]
    /** What the supplier is asking for, net of tax. */
    billedCents: number
    issueDate: string
    dueDate?: string
    /** The number printed on their invoice (Phase 47). */
    vendorReference?: string | null
    taxCents?: number
    memo?: string
  },
): Promise<ReceiptBillResult> {
  requirePermission(ctx, 'accounting:journal')

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, input.vendorId)))
    .limit(1)

  if (!vendor) throw new DocumentError('That supplier is not on these books.')

  const receipts = await db
    .select()
    .from(goodsReceipts)
    .where(
      scoped(
        ctx,
        goodsReceipts,
        // `inArray` rather than a hand-built ANY(...): postgres-js does not
        // bind an array through `= ANY`, and concatenating ids into SQL is an
        // injection waiting for the day one of them is not a uuid.
        inArray(goodsReceipts.id, input.receiptIds.length > 0 ? input.receiptIds : ['']),
      ),
    )

  const comparable: BillableReceipt[] = receipts.map((receipt) => ({
    id: receipt.id,
    number: receipt.number,
    vendorId: receipt.vendorId,
    totalCents: receipt.totalCents,
    billId: receipt.billId,
  }))

  // Every id asked for has to have come back. One that did not belongs to
  // another company or does not exist, and silently billing the rest would
  // clear less than the caller believes.
  if (comparable.length !== input.receiptIds.length) {
    throw new DocumentError('One of those deliveries could not be found on these books.')
  }

  const verdict = matchVerdict({
    receipts: comparable,
    billedCents: input.billedCents,
    vendorId: input.vendorId,
  })

  if (verdict.action === 'refuse') throw new DocumentError(verdict.why)

  const grni = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced)
  if (!grni) {
    throw new DocumentError(
      'The Goods Received Not Invoiced account (2050) is missing from the chart, so a delivery cannot be cleared.',
    )
  }

  const variance =
    verdict.varianceCents !== 0
      ? await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.purchasePriceVariance)
      : null

  if (verdict.varianceCents !== 0 && !variance) {
    throw new DocumentError(
      'The Purchase Price Variance account (5450) is missing from the chart, so the difference has nowhere to go.',
    )
  }

  const numbers = comparable.map((receipt) => receipt.number).join(', ')

  // The bill is for what the supplier is asking, coded entirely to the
  // clearing account. Anything else would make the payable disagree with the
  // document, and the payable is what gets paid.
  const bill = await createBill(ctx, {
    vendorId: input.vendorId,
    vendorReference: input.vendorReference,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    taxCents: input.taxCents ?? 0,
    memo: input.memo ?? `Invoice for ${numbers}`,
    /**
     * Phase 47's resemblance question, already answered (Phase 48).
     *
     * A supplier delivering the same order twice in a week sends two invoices
     * for the same amount, and Phase 47 refuses the second unless somebody
     * says "it is a different bill". Choosing a *different delivery* is that
     * answer: these are two bills because they are for two deliveries, and the
     * deliveries are named on the bill and on the entry.
     *
     * This does not weaken the rule. The same *delivery* still cannot be
     * billed twice — `matchVerdict` refuses it above, and the conditional
     * claim below refuses it again under a race. What is waived is only the
     * heuristic that exists for bills typed by hand with nothing to tell them
     * apart, and here there is something.
     */
    acknowledgeDuplicate: true,
    lines: [
      {
        chartAccountId: grni.id,
        description: `Goods received on ${numbers}`,
        unitPriceCents: input.billedCents,
      },
    ],
  })

  /**
   * The difference, as its own entry.
   *
   * Not a second line on the bill. An undercharge needs a *credit* to variance,
   * and a bill line is always a debit — `journal_lines_single_side` refuses a
   * negative one, correctly. Making it a separate entry handles both directions
   * with positive lines, and is the truer record anyway: the supplier's
   * document says what they asked for, and this says what the books did about
   * the difference.
   *
   * Posted after the bill rather than inside it, so a failure here leaves the
   * payable right and the clearing account out — which is the state the new
   * `inventory.goods_received` check exists to find and name.
   */
  if (variance && verdict.varianceCents !== 0) {
    const overcharged = verdict.varianceCents > 0
    const amount = Math.abs(verdict.varianceCents)

    await createJournalEntry(
      ctx,
      {
        entryDate: input.issueDate,
        memo: `Price difference on ${numbers} — ${vendor.name}`,
        source: 'bill',
        sourceType: 'bill',
        sourceId: bill.id,
        lines: overcharged
          ? [
              { chartAccountId: variance.id, debitCents: amount, memo: 'Billed above cost' },
              { chartAccountId: grni.id, creditCents: amount, memo: `Clearing ${numbers}` },
            ]
          : [
              { chartAccountId: grni.id, debitCents: amount, memo: `Clearing ${numbers}` },
              { chartAccountId: variance.id, creditCents: amount, memo: 'Billed below cost' },
            ],
      },
      db,
    )
  }

  // Claimed only while still unclaimed. Two people billing the same delivery
  // at once means one of them writes nothing and the receipts stay attached to
  // the bill that got there first — the database arbitrates, as it does
  // everywhere in this system two people can act at once.
  const claimed = await db
    .update(goodsReceipts)
    .set({ billId: bill.id })
    .where(
      and(
        eq(goodsReceipts.companyId, ctx.companyId),
        inArray(
          goodsReceipts.id,
          comparable.map((receipt) => receipt.id),
        ),
        // The condition that makes this safe under a race.
        isNull(goodsReceipts.billId),
      ),
    )
    .returning({ id: goodsReceipts.id })

  if (claimed.length !== comparable.length) {
    throw new DocumentError(
      'One of those deliveries was billed by somebody else a moment ago. Nothing was posted twice — check the bill list and try again.',
    )
  }

  await recordAudit(ctx, {
    action: 'bill.create',
    entityType: 'bill',
    entityId: bill.id,
    after: {
      number: bill.number,
      vendor: vendor.name,
      clearedCents: verdict.clearedCents,
      varianceCents: verdict.varianceCents,
      receipts: comparable.map((receipt) => receipt.number),
    },
  })

  return {
    billId: bill.id,
    billNumber: bill.number,
    clearedCents: verdict.clearedCents,
    varianceCents: verdict.varianceCents,
    notice: worthMentioning(verdict) ? describeMatch(verdict) : null,
  }
}

/**
 * What `2050` should hold, from the receipts rather than from the ledger.
 *
 * The right-hand side of the integrity check this phase adds. Deliberately
 * computed the long way round — summing the deliveries nobody has billed —
 * because a check that derived both sides from the ledger would agree with
 * itself and prove nothing.
 */
export async function unbilledReceiptValue(
  ctx: ActorContext,
): Promise<{ count: number; totalCents: number }> {
  const rows = await db
    .select({ totalCents: goodsReceipts.totalCents })
    .from(goodsReceipts)
    .where(scoped(ctx, goodsReceipts, isNull(goodsReceipts.billId)))

  return {
    count: rows.length,
    totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0),
  }
}
