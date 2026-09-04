import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  customers,
  depositItems,
  deposits,
  financialAccounts,
  payments,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import {
  createJournalEntry,
  reverseEntry,
  type JournalLineInput,
} from '@/modules/ledger/journal'
import { formatCents } from '@/lib/money'
import { Refusal } from '@/modules/errors'

/**
 * Bank deposits (spec §13).
 *
 * ## What a deposit is for
 *
 * Reconciliation matches the books against a statement, one line at a time.
 * Three cheques banked together are one line at the bank and, without this,
 * three in the books — so the match fails and the difference is a real number
 * nobody can explain.
 *
 * A deposit is the record of which receipts went in the envelope. It posts one
 * entry for the amount the bank actually processed, and the individual
 * customers stay attached to their own payments where the receivable, the
 * statement, and the aging report all still need them.
 *
 * ## The fee
 *
 * A card processor takes its cut before the money arrives. Recording the gross
 * and expensing the fee separately would put a figure on the bank account that
 * the bank never saw. So a fee is a negative line on the deposit: the entry
 * debits the bank for the net, debits the fee account for the cut, and credits
 * Undeposited Funds for the gross the customers actually paid.
 *
 * ```
 *   Dr  Checking                 4 832.19    ← what the statement shows
 *   Dr  Merchant Fees              142.81
 *       Cr  Undeposited Funds              4 975.00    ← what customers paid
 * ```
 */

export type DepositReceiptItem = { paymentId: string; memo?: string }

/**
 * A line that is not a batched receipt: bank interest, an owner contribution,
 * or — with a negative amount — a processing fee.
 */
export type DepositAccountItem = { chartAccountId: string; amountCents: number; memo?: string }

export type DepositItemInput = DepositReceiptItem | DepositAccountItem

export type CreateDepositInput = {
  financialAccountId: string
  depositDate: string
  items: DepositItemInput[]
  number?: string
  reference?: string
  memo?: string
}

function isReceiptItem(item: DepositItemInput): item is DepositReceiptItem {
  return 'paymentId' in item
}

function isAccountItem(item: DepositItemInput): item is DepositAccountItem {
  return !('paymentId' in item)
}

/**
 * Receipts waiting to be banked.
 *
 * A payment is undeposited when it has no financial account — the money
 * arrived and has not been taken anywhere yet. Ones already on a deposit are
 * excluded by the join rather than by a status column, so the list cannot
 * disagree with the deposits that exist.
 */
export async function undepositedReceipts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: payments.id,
      paymentDate: payments.paymentDate,
      amountCents: payments.amountCents,
      reference: payments.reference,
      memo: payments.memo,
      customerName: customers.name,
    })
    .from(payments)
    .leftJoin(customers, eq(customers.id, payments.customerId))
    .leftJoin(depositItems, eq(depositItems.paymentId, payments.id))
    .where(
      scoped(
        ctx,
        payments,
        eq(payments.kind, 'receipt'),
        // Never offer to bank money that was taken back (Phase 52).
        eq(payments.status, 'posted'),
        isNull(payments.financialAccountId),
        isNull(depositItems.id),
      ),
    )
    .orderBy(asc(payments.paymentDate))
}

export async function createDeposit(ctx: ActorContext, input: CreateDepositInput) {
  requirePermission(ctx, 'accounting:journal')

  if (input.items.length === 0) {
    throw new Refusal('A deposit needs at least one item.')
  }

  const [account] = await db
    .select()
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
    .limit(1)

  if (!account) throw new Error('Financial account not found')

  const undepositedAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.undepositedFunds)
  if (!undepositedAccount) {
    throw new Refusal('The Undeposited Funds account is missing from the chart.')
  }

  const paymentIds = input.items.filter(isReceiptItem).map((item) => item.paymentId)
  const otherItems = input.items.filter(isAccountItem)

  // Read the receipts before the transaction opens so the amounts come from
  // the payments rather than from whatever the caller believed they were.
  const receipts = paymentIds.length
    ? await db
        .select({
          id: payments.id,
          amountCents: payments.amountCents,
          financialAccountId: payments.financialAccountId,
        })
        .from(payments)
        .where(
          scoped(ctx, payments, inArray(payments.id, paymentIds), eq(payments.status, 'posted')),
        )
    : []

  if (receipts.length !== paymentIds.length) {
    throw new Refusal('One or more of those receipts could not be found.')
  }

  const alreadyBanked = receipts.find((receipt) => receipt.financialAccountId !== null)
  if (alreadyBanked) {
    throw new Refusal(
      'One of those receipts already went straight to a bank account, so it is not ' +
        'waiting to be deposited.',
    )
  }

  const receiptsCents = receipts.reduce((sum, receipt) => sum + receipt.amountCents, 0)
  const otherCents = otherItems.reduce((sum, item) => sum + item.amountCents, 0)
  const totalCents = receiptsCents + otherCents

  if (totalCents <= 0) {
    throw new Refusal(
      `The deposit comes to ${formatCents(totalCents)}. A deposit has to add up to more than nothing — ` +
        'check whether a fee was entered larger than the receipts it was taken from.',
    )
  }

  const amountById = new Map(receipts.map((receipt) => [receipt.id, receipt.amountCents]))

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextDepositNumber(ctx, tx))

    const [deposit] = await tx
      .insert(deposits)
      .values({
        companyId: ctx.companyId,
        financialAccountId: input.financialAccountId,
        number,
        depositDate: input.depositDate,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        receiptsCents,
        totalCents,
        createdBy: ctx.userId,
      })
      .returning()

    // The unique index on `payment_id` is what actually stops a cheque being
    // banked twice: two concurrent deposits both pass the read above, and one
    // of them fails here. Inside the transaction, so the loser rolls back
    // whole rather than leaving a deposit with half its items.
    await tx.insert(depositItems).values(
      input.items.map((item) =>
        isReceiptItem(item)
          ? {
              companyId: ctx.companyId,
              depositId: deposit.id,
              paymentId: item.paymentId,
              chartAccountId: null,
              amountCents: amountById.get(item.paymentId) ?? 0,
              memo: item.memo ?? null,
            }
          : {
              companyId: ctx.companyId,
              depositId: deposit.id,
              paymentId: null,
              chartAccountId: item.chartAccountId,
              amountCents: item.amountCents,
              memo: item.memo ?? null,
            },
      ),
    )

    // Dr the bank for what it processed; Cr Undeposited Funds for the gross the
    // customers paid; the other lines take up the difference on whichever side
    // their sign puts them.
    const lines: JournalLineInput[] = [
      {
        chartAccountId: account.chartAccountId,
        debitCents: totalCents,
        memo: `Deposit ${number}`,
      },
    ]

    if (receiptsCents > 0) {
      lines.push({
        chartAccountId: undepositedAccount.id,
        creditCents: receiptsCents,
        memo: `${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`,
      })
    }

    for (const item of otherItems) {
      lines.push(
        item.amountCents > 0
          ? {
              chartAccountId: item.chartAccountId,
              creditCents: item.amountCents,
              memo: item.memo ?? null,
            }
          : {
              chartAccountId: item.chartAccountId,
              debitCents: -item.amountCents,
              memo: item.memo ?? null,
            },
      )
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.depositDate,
        memo: input.memo ?? `Deposit ${number} to ${account.name}`,
        source: 'manual',
        sourceType: 'deposit',
        sourceId: deposit.id,
        lines,
      },
      tx,
    )

    await tx.update(deposits).set({ journalEntryId: entry.id }).where(eq(deposits.id, deposit.id))

    await recordAudit(
      ctx,
      {
        action: 'deposit.create',
        entityType: 'deposit',
        entityId: deposit.id,
        after: {
          number,
          totalCents,
          receipts: receipts.length,
          financialAccountId: input.financialAccountId,
        },
      },
      tx,
    )

    return { ...deposit, journalEntryId: entry.id }
  })
}

/**
 * Unwinds a deposit.
 *
 * Reversing rather than deleting: the entry may already have been reconciled,
 * and a period may since have closed over it. The items go, because the
 * receipts have to become depositable again, and the deposit row stays as the
 * history of a trip to the bank that was undone.
 */
export async function voidDeposit(
  ctx: ActorContext,
  depositId: string,
  reversalDate: string,
  /**
   * Optional (Phase 70). Unbanking a deposit is on the "need not say why" side
   * of `corrections/vocabulary`'s rule: the receipts on it were recorded
   * individually and go back to waiting, so nothing left the business. A reason
   * given anyway is kept.
   */
  reason?: string | null,
) {
  requirePermission(ctx, 'accounting:journal')

  const [deposit] = await db
    .select()
    .from(deposits)
    .where(scoped(ctx, deposits, eq(deposits.id, depositId)))
    .limit(1)

  if (!deposit) throw new Error('Deposit not found')
  if (deposit.voidedAt) throw new Refusal(`Deposit ${deposit.number} has already been reversed.`)

  if (deposit.journalEntryId) {
    await reverseEntry(ctx, deposit.journalEntryId, reversalDate)
  }

  return db.transaction(async (tx) => {
    await tx.delete(depositItems).where(eq(depositItems.depositId, depositId))

    const [updated] = await tx
      .update(deposits)
      .set({ voidedAt: new Date(), voidedBy: ctx.userId })
      .where(eq(deposits.id, depositId))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'deposit.void',
        entityType: 'deposit',
        entityId: depositId,
        before: { number: deposit.number, totalCents: deposit.totalCents },
        after: { reason: reason ?? null },
      },
      tx,
    )

    return updated
  })
}

export async function listDeposits(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: deposits.id,
      number: deposits.number,
      depositDate: deposits.depositDate,
      totalCents: deposits.totalCents,
      receiptsCents: deposits.receiptsCents,
      memo: deposits.memo,
      voidedAt: deposits.voidedAt,
      accountName: financialAccounts.name,
    })
    .from(deposits)
    .innerJoin(financialAccounts, eq(financialAccounts.id, deposits.financialAccountId))
    .where(scoped(ctx, deposits))
    .orderBy(desc(deposits.depositDate), desc(deposits.number))
    .limit(opts.limit ?? 50)
}

export async function depositWithItems(ctx: ActorContext, depositId: string) {
  requirePermission(ctx, 'accounting:view')

  const [deposit] = await db
    .select()
    .from(deposits)
    .where(scoped(ctx, deposits, eq(deposits.id, depositId)))
    .limit(1)

  if (!deposit) throw new Error('Deposit not found')

  const items = await db
    .select({
      id: depositItems.id,
      amountCents: depositItems.amountCents,
      memo: depositItems.memo,
      paymentId: depositItems.paymentId,
      paymentDate: payments.paymentDate,
      customerName: customers.name,
      accountNumber: chartAccounts.number,
      accountName: chartAccounts.name,
    })
    .from(depositItems)
    .leftJoin(payments, eq(payments.id, depositItems.paymentId))
    .leftJoin(customers, eq(customers.id, payments.customerId))
    .leftJoin(chartAccounts, eq(chartAccounts.id, depositItems.chartAccountId))
    .where(and(eq(depositItems.companyId, ctx.companyId), eq(depositItems.depositId, depositId)))

  return { deposit, items }
}

/** The bank accounts a deposit may be made into. */
export async function depositableAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({ id: financialAccounts.id, name: financialAccounts.name })
    .from(financialAccounts)
    .where(
      scoped(
        ctx,
        financialAccounts,
        eq(financialAccounts.isActive, true),
        // A deposit goes into an account money can sit in. Paying a credit
        // card down is a payment, not a deposit.
        sql`${financialAccounts.kind} IN ('checking', 'savings', 'cash')`,
      ),
    )
    .orderBy(asc(financialAccounts.name))
}

/** The accounts a non-receipt deposit line may be posted against, for the UI. */
export async function depositLineAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({ id: chartAccounts.id, number: chartAccounts.number, name: chartAccounts.name })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        eq(chartAccounts.isActive, true),
        // Anything but the cash accounts themselves: a deposit already knows
        // which bank it went to, and a second bank line would make it a
        // transfer wearing a deposit's clothes.
        sql`coalesce(${chartAccounts.subtype}, '') NOT IN ('bank', 'cash', 'undeposited_funds')`,
      ),
    )
    .orderBy(asc(chartAccounts.number))
}

async function nextDepositNumber(ctx: ActorContext, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(deposits)
    .where(eq(deposits.companyId, ctx.companyId))

  return `DEP-${1001 + Number(row?.count ?? 0)}`
}
