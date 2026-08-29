import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  billLines,
  bills,
  chartAccounts,
  creditApplications,
  creditNoteLines,
  creditNotes,
  financialAccounts,
  refunds,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import { formatCents } from '@/lib/money'
import { relieveFunctional } from '@/modules/fx/documents'
import { creditableAgainst, functionalAmounts } from '@/modules/fx/denomination'
import { recoverHeld } from '@/modules/fx/settlement'
import { convert } from '@/modules/fx/rates'
import { ensureFxAccount, functionalCurrency, rateFor } from '@/modules/fx/service'
import { mayUse } from './overpayment'
import { DomainError } from '@/modules/errors'

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

  if (!vendor) throw new DomainError('Vendor not found')

  const apAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsPayable)
  if (!apAccount) throw new Error('Accounts Payable is missing from the chart.')

  let bill: typeof bills.$inferSelect | null = null

  if (input.billId) {
    const [row] = await db
      .select()
      .from(bills)
      .where(scoped(ctx, bills, eq(bills.id, input.billId)))
      .limit(1)

    if (!row) throw new DomainError('Bill not found')
    if (row.vendorId !== input.vendorId) {
      throw new DomainError('That bill belongs to a different vendor.')
    }
    if (row.status === 'void') throw new DomainError('That bill is voided.')
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
    throw new DomainError('A vendor credit needs at least one line, or a bill to credit.')
  }

  for (const line of lines) {
    if (line.amountCents <= 0) {
      throw new DomainError('Vendor credit amounts are positive; the direction is what makes it a credit.')
    }
  }

  /**
   * Denominated in the bill it credits (Phase 63), at the rate on this
   * credit's own issue date. The customer-side reasoning applies unchanged: a
   * credit reverses part of a document that already exists, and the supplier's
   * ledger will show €500 against that bill.
   */
  const home = await functionalCurrency(ctx.companyId)
  const currency = bill?.currency ?? home
  const { rateMillionths } = await rateFor(ctx, currency, input.issueDate)

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxCents = input.taxCents ?? 0
  const totalCents = subtotalCents + taxCents

  // One rule, shared with the bill this reverses (Phase 63).
  const functional = functionalAmounts({
    lineCents: lines.map((line) => line.amountCents),
    taxCents,
    rateMillionths,
  })

  if (bill && totalCents > bill.totalCents) {
    throw new DomainError(
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
        currency,
        exchangeRateMillionths: rateMillionths,
        functionalTotalCents: functional.functionalTotalCents,
        functionalRemainingCents: functional.functionalTotalCents,
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
    // In the company's currency, because that is what a ledger is in, and per
    // line so the entry balances against `functionalTotalCents` exactly.
    const journalLineInputs = [
      {
        chartAccountId: apAccount.id,
        debitCents: functional.functionalTotalCents,
        memo: `Vendor credit ${number}`,
      },
      ...lines.map((line, index) => ({
        chartAccountId: line.chartAccountId,
        creditCents: functional.lineCents[index],
        memo: line.description,
      })),
    ]

    if (taxCents > 0) {
      const taxAccount = await accountByNumber(ctx.companyId, '2200', tx)
      if (!taxAccount) throw new Error('Sales Tax Payable is missing from the chart.')
      journalLineInputs.push({
        chartAccountId: taxAccount.id,
        creditCents: functional.functionalTaxCents,
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
        functionalRemainingCents: applied.creditFunctionalRemainingCents,
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
  if (input.amountCents <= 0) throw new DomainError('An application must be greater than zero.')

  const [note] = await tx
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, input.creditNoteId), eq(creditNotes.companyId, ctx.companyId)))
    .limit(1)

  if (!note) throw new DomainError('Vendor credit not found')
  if (note.party !== 'vendor') {
    throw new DomainError('That is a customer credit note. It cannot be applied to a bill.')
  }
  if (note.status === 'void') throw new DomainError('That vendor credit is voided.')

  const [bill] = await tx
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.companyId, ctx.companyId)))
    .limit(1)

  if (!bill) throw new DomainError('Bill not found')
  if (bill.vendorId !== note.vendorId) {
    throw new DomainError('A credit can only be applied to the same vendor’s bill.')
  }

  /** The two have to agree (Phase 63) — Phase 62's rule, one document over. */
  const verdict = creditableAgainst({
    creditNumber: note.number,
    creditCurrency: note.currency,
    documentNumber: bill.number,
    documentCurrency: bill.currency,
  })
  if (!verdict.ok) throw new DomainError(verdict.reason)

  if (input.amountCents > note.remainingCents) {
    throw new DomainError(
      `Only ${formatCents(note.remainingCents)} of vendor credit ${note.number} is left to apply.`,
    )
  }
  if (input.amountCents > bill.balanceCents) {
    throw new DomainError(
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
  // Both halves together, for the reason the customer side does it: a note whose
  // face amount is spent but whose functional amount is not shows credit the
  // business does not have (Phase 63).
  const noteFunctional = relieveFunctional(
    {
      balanceCents: note.remainingCents,
      exchangeRateMillionths: note.exchangeRateMillionths,
      functionalBalanceCents: note.functionalRemainingCents,
    },
    input.amountCents,
  )
  await tx
    .update(creditNotes)
    .set({
      remainingCents: noteRemaining,
      functionalRemainingCents: noteFunctional.functionalBalanceCents,
      status: noteRemaining === 0 ? 'applied' : 'open',
      updatedAt: new Date(),
    })
    .where(eq(creditNotes.id, note.id))

  const billBalance = bill.balanceCents - input.amountCents
  await tx
    .update(bills)
    .set({
      balanceCents: billBalance,
      functionalBalanceCents: relieveFunctional(bill, input.amountCents).functionalBalanceCents,
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

  return {
    creditRemainingCents: noteRemaining,
    creditFunctionalRemainingCents: noteFunctional.functionalBalanceCents,
    billBalanceCents: billBalance,
  }
}

/**
 * Takes the money back from a supplier (spec §13, Phase 68).
 *
 * ## The balance nobody could spend
 *
 * A vendor credit posts `Dr Accounts Payable / Cr Expense` when it is issued.
 * Applying it to a bill posts nothing — it only decides which bill the
 * reduction belongs to. So an unapplied credit is a **debit sitting in
 * payables**: money the supplier owes back, netted against everything else the
 * business owes them.
 *
 * While there are more bills coming that is exactly right, and it is why
 * `splitReceipt` has refused an over-payment to a supplier since Phase 53 —
 * "raise a vendor credit for the difference instead". But when the relationship
 * ends, no bill ever arrives to apply it to, and the remedy is advice nobody can
 * take. The credit stays in payables for ever, quietly understating what the
 * business owes its other suppliers.
 *
 * ADR 0067 named this as the mirror of the retainer it had just fixed, and it is
 * the same lesson a third time: **a balance with no way out becomes a wrong
 * number and stays one.**
 *
 * ## Why this is not `refundRetainer` with the words changed
 *
 * The two are the same settlement with the debit and the credit swapped. A
 * retainer is a liability, so giving it back debits the liability and credits
 * the bank. A vendor credit is an asset, so getting it back debits the bank and
 * credits the payable — which flips the sign of the realised gain.
 *
 * A euro that got dearer is a **loss** on money held for somebody else and a
 * **gain** on money somebody else holds for you. `recoverHeld` is the half of
 * Phase 66's core that says so; handing these amounts to `settleHeld` would
 * return the right magnitude with the wrong sign, in an entry that still
 * balances.
 */
export async function refundVendorCredit(
  ctx: ActorContext,
  input: {
    creditNoteId: string
    /** In the credit's own currency — the supplier returns what they took. */
    amountCents: number
    financialAccountId: string
    refundedOn: string
    reference?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const [note] = await tx
      .select()
      .from(creditNotes)
      .where(scoped(ctx, creditNotes, eq(creditNotes.id, input.creditNoteId)))
      .limit(1)

    if (!note) throw new DomainError('That vendor credit is not on these books.')
    if (note.party !== 'vendor') {
      throw new DomainError('That is a customer credit note. A customer is refunded from their payment.')
    }
    if (note.status === 'void') throw new DomainError('That vendor credit is voided.')

    // Phase 53's verdict, shared with both of the other refunds rather than
    // restated, and naming the currency since Phase 67.
    const permitted = mayUse({
      use: 'refund',
      amountCents: input.amountCents,
      availableCents: note.remainingCents,
      currency: note.currency,
      // Reused from the customer side, so it has to be told whose money this
      // is — otherwise it calls a supplier a customer (Phase 68).
      holder: 'this supplier',
    })
    if (!permitted.ok) throw new DomainError(permitted.why)

    const [account] = await tx
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
      .limit(1)

    if (!account) throw new DomainError('That account is not on these books.')

    const apAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsPayable, tx)
    if (!apAccount) throw new Error('Accounts Payable is missing from the chart.')

    /**
     * What actually lands in the bank, at the rate on the day it lands — the
     * figure the statement will show. Not the credit's rate, which is what the
     * *books* have been carrying it at since it was raised.
     */
    const { rateMillionths } = await rateFor(ctx, note.currency, input.refundedOn, tx)
    const receivedCents = convert(input.amountCents, rateMillionths)

    // The last recovery takes the whole functional remainder, so the credit
    // cannot reach zero on one column and not the other (Phase 66's rule).
    const relief = relieveFunctional(
      {
        balanceCents: note.remainingCents,
        exchangeRateMillionths: note.exchangeRateMillionths,
        functionalBalanceCents: note.functionalRemainingCents,
      },
      input.amountCents,
    )
    const recovery = recoverHeld({
      receivedCents,
      relievedCents: relief.functionalCents,
    })

    const fxAccount = recovery.realisedCents === 0 ? null : await ensureFxAccount(ctx, tx)

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.refundedOn,
        memo: input.reference
          ? `Vendor credit ${note.number} refunded — ${input.reference}`
          : `Vendor credit ${note.number} refunded`,
        // Not `bill`: this one is cash, and the cash-basis transformation must
        // keep it where it strips the credit that created the balance.
        source: 'payment',
        sourceType: 'vendor_credit_refund',
        sourceId: note.id,
        lines: [
          { chartAccountId: account.chartAccountId, debitCents: recovery.receivedCents },
          { chartAccountId: apAccount.id, creditCents: recovery.relievedCents },
          ...(fxAccount
            ? [
                recovery.realisedCents > 0
                  ? {
                      chartAccountId: fxAccount,
                      creditCents: recovery.realisedCents,
                      memo: 'Exchange gain',
                    }
                  : {
                      chartAccountId: fxAccount,
                      debitCents: -recovery.realisedCents,
                      memo: 'Exchange loss',
                    },
              ]
            : []),
        ],
      },
      tx,
    )

    await tx.insert(refunds).values({
      companyId: ctx.companyId,
      subjectType: 'credit_note',
      subjectId: note.id,
      // The only one of the three that comes in rather than goes out, which is
      // the whole reason the column exists.
      direction: 'in',
      amountCents: input.amountCents,
      currency: note.currency,
      carriedCents: recovery.relievedCents,
      cashCents: recovery.receivedCents,
      realisedCents: recovery.realisedCents,
      exchangeRateMillionths: rateMillionths,
      refundedOn: input.refundedOn,
      reference: input.reference ?? null,
      financialAccountId: input.financialAccountId,
      journalEntryId: entry.id,
      createdBy: ctx.userId,
    })

    const remainingCents = note.remainingCents - input.amountCents

    // Conditional on what was read, so two people recovering the same credit at
    // once produce one recovery and the second finds nothing.
    const claimed = await tx
      .update(creditNotes)
      .set({
        remainingCents,
        functionalRemainingCents: relief.functionalBalanceCents,
        // 'applied' is what a spent credit is called here whether it was spent
        // against a bill or taken back in cash — both mean nothing is left.
        status: remainingCents === 0 ? 'applied' : 'open',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditNotes.id, note.id),
          eq(creditNotes.remainingCents, note.remainingCents),
        ),
      )
      .returning({ id: creditNotes.id })

    if (claimed.length === 0) {
      throw new DomainError('That vendor credit was used by somebody else a moment ago.')
    }

    await recordAudit(
      ctx,
      {
        action: 'vendor_credit.refund',
        entityType: 'credit_note',
        entityId: note.id,
        after: {
          number: note.number,
          currency: note.currency,
          amountCents: input.amountCents,
          receivedCents: recovery.receivedCents,
          relievedCents: recovery.relievedCents,
          realisedCents: recovery.realisedCents,
        },
      },
      tx,
    )

    return {
      refundedCents: input.amountCents,
      currency: note.currency,
      receivedCents: recovery.receivedCents,
      realisedCents: recovery.realisedCents,
      remainingCents,
      number: note.number,
    }
  })
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
      currency: creditNotes.currency,
      totalCents: creditNotes.totalCents,
      remainingCents: creditNotes.remainingCents,
      functionalRemainingCents: creditNotes.functionalRemainingCents,
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
