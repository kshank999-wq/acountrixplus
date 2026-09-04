import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  chartAccounts,
  creditApplications,
  creditNoteLines,
  creditNotes,
  customers,
  invoiceLines,
  invoiceWriteOffs,
  invoices,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry } from '@/modules/ledger/journal'
import { formatCents } from '@/lib/money'
import { relieveFunctional } from '@/modules/fx/documents'
import { creditableAgainst, functionalAmounts } from '@/modules/fx/denomination'
import { functionalCurrency, rateFor } from '@/modules/fx/service'
import { recoveryFunctional } from '@/modules/fx/ledger'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

/**
 * Credit notes and write-offs (spec §13).
 *
 * ## The distinction the whole file is built around
 *
 * Both reduce a receivable without money arriving. They mean opposite things,
 * and conflating them is the commonest way a set of books hides a collections
 * problem:
 *
 * ```
 *   Credit note              Write-off
 *   ─────────────────────    ─────────────────────
 *   Dr  Revenue      100     Dr  Bad Debt     100
 *       Cr  AR       100         Cr  AR       100
 *
 *   "They owe less."         "They owe it and will not pay."
 *   Revenue was never        Revenue stays. The loss is a
 *   earned.                  cost of doing business.
 * ```
 *
 * A company that writes bad debt off as a credit note reports lower revenue and
 * no bad debt at all. Its margin looks unchanged, and the fact that a customer
 * stopped paying never appears anywhere. So these are two operations with two
 * shapes, and neither can be reached through the other.
 */

export type CreditNoteLineInput = {
  chartAccountId: string
  description: string
  quantityMilli?: number
  unitPriceCents: number
}

export type CreditNoteInput = {
  customerId: string
  issueDate: string
  /** When set, defaults the lines to this invoice's accounts and amounts. */
  invoiceId?: string
  lines?: CreditNoteLineInput[]
  taxCents?: number
  reason?: string
  memo?: string
  number?: string
  /** Apply it to the named invoice immediately. Only with `invoiceId`. */
  applyImmediately?: boolean
}

/**
 * Issues a credit note.
 *
 * Posts `Dr` the revenue accounts, `Cr` Accounts Receivable — the exact mirror
 * of the invoice entry. Reversing to *the same accounts the revenue landed on*
 * is what makes a credited sale disappear from the right revenue line rather
 * than from a single "sales returns" bucket that tells nobody which product
 * was returned.
 */
export async function createCreditNote(ctx: ActorContext, input: CreditNoteInput) {
  requirePermission(ctx, 'accounting:journal')

  const [customer] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
    .limit(1)

  if (!customer) throw missing('customer')

  const arAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsReceivable)
  if (!arAccount) throw new Refusal('Accounts Receivable is missing from the chart.')

  let invoice: typeof invoices.$inferSelect | null = null

  if (input.invoiceId) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(scoped(ctx, invoices, eq(invoices.id, input.invoiceId)))
      .limit(1)

    if (!row) throw missing('invoice')
    if (row.customerId !== input.customerId) {
      throw new Refusal('That invoice belongs to a different customer.')
    }
    if (row.status === 'void') throw new Refusal('That invoice is voided.')
    invoice = row
  }

  // Lines default to the invoice's own, so the reversal lands where the
  // revenue did without anybody having to look it up and retype it.
  const lines = input.lines?.length
    ? input.lines.map((line, index) => ({
        ...line,
        quantityMilli: line.quantityMilli ?? 1000,
        amountCents: Math.round(((line.quantityMilli ?? 1000) * line.unitPriceCents) / 1000),
        sortOrder: index,
      }))
    : await defaultLinesFromInvoice(ctx, invoice)

  if (lines.length === 0) {
    throw new Refusal('A credit note needs at least one line, or an invoice to credit.')
  }

  for (const line of lines) {
    if (line.amountCents <= 0) {
      throw new Refusal('Credit note amounts are positive; the direction is what makes it a credit.')
    }
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxCents = input.taxCents ?? (input.lines?.length ? 0 : (invoice?.taxCents ?? 0))
  const totalCents = subtotalCents + taxCents

  /**
   * A credit note is denominated in the document it credits (Phase 63).
   *
   * Inherited rather than chosen: it reverses part of a document that already
   * exists, and the customer's own ledger will show €500 against that invoice.
   * Standalone — a goodwill gesture before the next invoice exists — it is in
   * the company's own currency, which is the only one available.
   *
   * The rate is the one on this note's issue date, fixed here and never
   * recomputed, exactly as `createInvoice` fixes an invoice's. Deliberately
   * *not* the invoice's own rate: this is a document raised today, and dating
   * its conversion to something that happened in March would put a rate in the
   * books that nobody chose today.
   */
  const home = await functionalCurrency(ctx.companyId)
  const currency = invoice?.currency ?? home
  const { rateMillionths } = await rateFor(ctx, currency, input.issueDate)

  // One rule, shared with the invoice and the bill this reverses: each line
  // converts on its own and the total is their sum, so the entry balances by
  // construction (Phase 63).
  const functional = functionalAmounts({
    lineCents: lines.map((line) => line.amountCents),
    taxCents,
    rateMillionths,
  })

  if (invoice && totalCents > invoice.totalCents) {
    throw new Refusal(
      `A credit of ${formatCents(totalCents)} is more than invoice ${invoice.number} was for ` +
        `(${formatCents(invoice.totalCents)}).`,
    )
  }

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextCreditNumber(ctx, tx))

    const [note] = await tx
      .insert(creditNotes)
      .values({
        companyId: ctx.companyId,
        party: 'customer',
        customerId: input.customerId,
        vendorId: null,
        number,
        issueDate: input.issueDate,
        invoiceId: invoice?.id ?? null,
        billId: null,
        status: 'open',
        subtotalCents,
        taxCents,
        totalCents,
        remainingCents: totalCents,
        currency,
        exchangeRateMillionths: rateMillionths,
        functionalTotalCents: functional.functionalTotalCents,
        functionalRemainingCents: functional.functionalTotalCents,
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

    // The mirror of the invoice entry: revenue back out, receivable down.
    // In the company's currency, because that is what a ledger is in. The
    // per-line figures are the converted ones, so the entry balances against
    // `functionalTotalCents` exactly rather than to within a cent (Phase 63).
    const journalLineInputs = [
      ...lines.map((line, index) => ({
        chartAccountId: line.chartAccountId,
        debitCents: functional.lineCents[index],
        memo: line.description,
      })),
      {
        chartAccountId: arAccount.id,
        creditCents: functional.functionalTotalCents,
        memo: `Credit note ${number}`,
      },
    ]

    if (taxCents > 0) {
      const taxAccount = await accountByNumber(ctx.companyId, '2200', tx)
      if (!taxAccount) throw new Refusal('Sales Tax Payable is missing from the chart.')
      journalLineInputs.splice(lines.length, 0, {
        chartAccountId: taxAccount.id,
        debitCents: functional.functionalTaxCents,
        memo: 'Sales tax credited',
      })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.issueDate,
        memo: `Credit note ${number} — ${customer.name}`,
        source: 'invoice',
        sourceType: 'credit_note',
        sourceId: note.id,
        lines: journalLineInputs,
      },
      tx,
    )

    await tx
      .update(creditNotes)
      .set({ journalEntryId: entry.id })
      .where(eq(creditNotes.id, note.id))

    await recordAudit(
      ctx,
      {
        action: 'credit_note.create',
        entityType: 'credit_note',
        entityId: note.id,
        after: {
          number,
          customer: customer.name,
          totalCents,
          againstInvoice: invoice?.number ?? null,
          reason: input.reason ?? null,
        },
      },
      tx,
    )

    if (input.applyImmediately && invoice) {
      const applied = await applyCreditWithin(ctx, tx, {
        creditNoteId: note.id,
        invoiceId: invoice.id,
        amountCents: Math.min(totalCents, invoice.balanceCents),
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

/** An invoice's own lines, as the default content of a credit against it. */
async function defaultLinesFromInvoice(
  ctx: ActorContext,
  invoice: typeof invoices.$inferSelect | null,
) {
  if (!invoice) return []

  const rows = await db
    .select()
    .from(invoiceLines)
    .where(and(eq(invoiceLines.companyId, ctx.companyId), eq(invoiceLines.invoiceId, invoice.id)))
    .orderBy(asc(invoiceLines.sortOrder))

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
 * Applies an open credit to an invoice.
 *
 * No journal entry: the credit note already moved the receivable when it was
 * issued. Applying it is bookkeeping *within* Accounts Receivable — which
 * invoice the reduction belongs to — and posting a second entry would halve
 * the receivable twice.
 */
export async function applyCredit(
  ctx: ActorContext,
  input: { creditNoteId: string; invoiceId: string; amountCents: number; appliedOn: string },
) {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction((tx) => applyCreditWithin(ctx, tx, input))
}

async function applyCreditWithin(
  ctx: ActorContext,
  tx: Executor,
  input: { creditNoteId: string; invoiceId: string; amountCents: number; appliedOn: string },
) {
  if (input.amountCents <= 0) throw new Refusal('An application must be greater than zero.')

  const [note] = await tx
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, input.creditNoteId), eq(creditNotes.companyId, ctx.companyId)))
    .limit(1)

  if (!note) throw missing('creditNote')
  if (note.party !== 'customer') {
    throw new Refusal('That is a vendor credit. It cannot be applied to an invoice.')
  }
  if (note.status === 'void') throw new Refusal('That credit note is voided.')

  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)))
    .limit(1)

  if (!invoice) throw missing('invoice')
  if (invoice.customerId !== note.customerId) {
    throw new Refusal('A credit can only be applied to the same customer’s invoice.')
  }

  /**
   * The two have to agree (Phase 63), where this used to refuse any foreign
   * invoice outright. A credit reduces what a document says is owed, and it
   * can only do that in the currency the document is in — Phase 62's rule, one
   * document over.
   *
   * No journal entry is posted here: the credit note's own entry already moved
   * the receivable, and this is an allocation between the two. `relieveFunctional`
   * below takes the invoice's functional balance down at the *invoice's* rate,
   * which is what keeps the control account agreeing with the subledger.
   */
  const verdict = creditableAgainst({
    creditNumber: note.number,
    creditCurrency: note.currency,
    documentNumber: invoice.number,
    documentCurrency: invoice.currency,
  })
  if (!verdict.ok) throw new Error(verdict.reason)

  if (input.amountCents > note.remainingCents) {
    throw new Refusal(
      `Only ${formatCents(note.remainingCents)} of credit note ${note.number} is left to apply.`,
    )
  }
  if (input.amountCents > invoice.balanceCents) {
    throw new Refusal(
      `Invoice ${invoice.number} has a balance of ${formatCents(invoice.balanceCents)}, ` +
        `so ${formatCents(input.amountCents)} cannot be applied to it.`,
    )
  }

  await tx.insert(creditApplications).values({
    companyId: ctx.companyId,
    creditNoteId: note.id,
    invoiceId: invoice.id,
    amountCents: input.amountCents,
    appliedOn: input.appliedOn,
  })

  const noteRemaining = note.remainingCents - input.amountCents
  // Both halves of what is left, moved together. A note whose face amount is
  // spent but whose functional amount is not would put credit the business does
  // not have on every screen that sums in the company's own currency — which is
  // the defect this phase exists to close, one column over.
  //
  // `relieveFunctional` is the invoice's rule, borrowed rather than rewritten:
  // the last application takes whatever functional remainder is left, so the two
  // columns reach zero on the same application and no cent is stranded.
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

  const invoiceBalance = invoice.balanceCents - input.amountCents
  await tx
    .update(invoices)
    .set({
      balanceCents: invoiceBalance,
      functionalBalanceCents: relieveFunctional(invoice, input.amountCents)
        .functionalBalanceCents,
      status: invoiceBalance === 0 ? 'paid' : 'partial',
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoice.id))

  await recordAudit(
    ctx,
    {
      action: 'credit_note.apply',
      entityType: 'credit_note',
      entityId: note.id,
      after: {
        invoice: invoice.number,
        amountCents: input.amountCents,
        creditRemainingCents: noteRemaining,
      },
    },
    tx,
  )

  return {
    creditRemainingCents: noteRemaining,
    creditFunctionalRemainingCents: noteFunctional.functionalBalanceCents,
    invoiceBalanceCents: invoiceBalance,
  }
}

/**
 * Writes an invoice off as uncollectable.
 *
 * `Dr` Bad Debt, `Cr` Accounts Receivable. The revenue stays where it is,
 * because it was earned — what is being recorded is that the money will not
 * arrive, and that is an expense.
 *
 * A reason is required and enforced by a database CHECK as well as here. A
 * write-off with no stated reason is an unexplained loss, and by the time
 * anybody asks about it the person who did it has forgotten.
 */
export async function writeOffInvoice(
  ctx: ActorContext,
  invoiceId: string,
  input: { writtenOffOn: string; reason: string; amountCents?: number },
) {
  requirePermission(ctx, 'accounting:journal')

  if (!input.reason.trim()) {
    throw new Refusal('Say why it is being written off. An unexplained loss is worse than a loss.')
  }

  const [invoice] = await db
    .select()
    .from(invoices)
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))
    .limit(1)

  if (!invoice) throw missing('invoice')
  if (invoice.status === 'void') {
    throw new Refusal('That invoice is voided — there is nothing owed to write off.')
  }
  if (invoice.balanceCents <= 0) {
    throw new Refusal(`Invoice ${invoice.number} is settled. There is nothing to write off.`)
  }

  const amountCents = input.amountCents ?? invoice.balanceCents

  if (amountCents > invoice.balanceCents) {
    throw new Refusal(
      `Invoice ${invoice.number} has ${formatCents(invoice.balanceCents, invoice.currency)} ` +
        `outstanding, so ${formatCents(amountCents, invoice.currency)} cannot be written off.`,
    )
  }

  const [arAccount, badDebtAccount] = await Promise.all([
    accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsReceivable),
    accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.badDebt),
  ])

  if (!arAccount) throw new Refusal('Accounts Receivable is missing from the chart.')
  if (!badDebtAccount) {
    throw new Refusal('Bad Debt (6025) is missing from the chart of accounts.')
  }

  // A write-off is the one balance reduction that converts exactly: one amount,
  // two lines, nothing to spread a rounded cent across. So a foreign invoice
  // can be written off — the loss is the *home* amount the books were carrying,
  // at the rate the invoice was raised at. Re-converting at today's rate here
  // would fold a currency movement into the bad debt, and nobody decided to
  // recognise one (Phase 35).
  const relief = relieveFunctional(invoice, amountCents)
  const lossCents = relief.functionalCents

  return db.transaction(async (tx) => {
    const [writeOff] = await tx
      .insert(invoiceWriteOffs)
      .values({
        companyId: ctx.companyId,
        invoiceId: invoice.id,
        writtenOffOn: input.writtenOffOn,
        amountCents,
        // Phase 127. `lossCents` is what goes to the ledger and was thrown away
        // the moment it had been posted, so a recovery had nothing to reverse
        // but the face amount. Kept now, with the currency it is not in.
        currency: invoice.currency,
        functionalAmountCents: lossCents,
        reason: input.reason.trim(),
        createdBy: ctx.userId,
      })
      .returning()

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.writtenOffOn,
        memo: `Write-off of invoice ${invoice.number} — ${input.reason.trim()}`,
        source: 'adjusting',
        sourceType: 'invoice_write_off',
        sourceId: writeOff.id,
        lines: [
          { chartAccountId: badDebtAccount.id, debitCents: lossCents },
          { chartAccountId: arAccount.id, creditCents: lossCents },
        ],
      },
      tx,
    )

    await tx
      .update(invoiceWriteOffs)
      .set({ journalEntryId: entry.id })
      .where(eq(invoiceWriteOffs.id, writeOff.id))

    const balance = invoice.balanceCents - amountCents

    await tx
      .update(invoices)
      .set({
        balanceCents: balance,
        functionalBalanceCents: relief.functionalBalanceCents,
        // `written_off` rather than `paid`. Nobody paid, and a status saying
        // they did would erase the fact from every report that reads it.
        status: balance === 0 ? 'written_off' : 'partial',
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id))

    await recordAudit(
      ctx,
      {
        action: 'invoice.write_off',
        entityType: 'invoice',
        entityId: invoice.id,
        before: { balanceCents: invoice.balanceCents, status: invoice.status },
        after: { amountCents, reason: input.reason.trim(), status: balance === 0 ? 'written_off' : 'partial' },
      },
      tx,
    )

    return { ...writeOff, journalEntryId: entry.id }
  })
}

/**
 * Records that a written-off debt was paid after all.
 *
 * Reverses the bad-debt expense rather than recognizing new revenue — the
 * revenue was recognized when the invoice was raised and never taken back.
 * Recognizing it again here would count the same sale twice.
 */
export async function recoverWriteOff(
  ctx: ActorContext,
  writeOffId: string,
  input: { recoveredOn: string; amountCents: number; financialAccountId: string },
) {
  requirePermission(ctx, 'accounting:journal')

  const [writeOff] = await db
    .select()
    .from(invoiceWriteOffs)
    .where(scoped(ctx, invoiceWriteOffs, eq(invoiceWriteOffs.id, writeOffId)))
    .limit(1)

  if (!writeOff) throw missing('writeOff')
  if (writeOff.recoveredOn) throw new Refusal('That write-off has already been recovered.')
  if (input.amountCents <= 0) throw new Refusal('A recovery must be greater than zero.')
  if (input.amountCents > writeOff.amountCents) {
    throw new Refusal(
      `Only ${formatCents(writeOff.amountCents, writeOff.currency)} was written off, so ` +
        `${formatCents(input.amountCents, writeOff.currency)} cannot be recovered.`,
    )
  }

  const { financialAccounts } = await import('@/db/schema')
  const [bank] = await db
    .select()
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
    .limit(1)

  if (!bank) throw missing('financialAccount')

  const badDebtAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.badDebt)
  if (!badDebtAccount) throw new Refusal('Bad Debt (6025) is missing from the chart of accounts.')

  /**
   * What comes off bad debt (Phase 127).
   *
   * Until this, both lines posted `input.amountCents` — the *invoice's* amount,
   * against an expense `writeOffInvoice` had raised in the company's own money.
   * A fully recovered €2,500 write-off therefore credited $2,500 against a
   * $2,750 debit and left $250 of loss on the profit and loss forever, while
   * `badDebtSummary` reported that nothing had been lost at all.
   *
   * At the write-off's own carried rate, and taking the whole remainder on the
   * last of it, for the two reasons `relieveFunctional` gives: a later rate
   * would fold a currency movement into bad debt, and rounding three
   * part-recoveries need not sum back to what was written off.
   */
  const recovery = recoveryFunctional(
    {
      amountCents: writeOff.amountCents,
      functionalAmountCents: writeOff.functionalAmountCents,
      recoveredCents: writeOff.recoveredCents ?? 0,
      functionalRecoveredCents: writeOff.functionalRecoveredCents,
    },
    input.amountCents,
  )

  return db.transaction(async (tx) => {
    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.recoveredOn,
        memo: `Recovery of a written-off debt`,
        source: 'adjusting',
        sourceType: 'write_off_recovery',
        sourceId: writeOff.id,
        lines: [
          { chartAccountId: bank.chartAccountId, debitCents: recovery.functionalCents },
          // Back out the expense. Not revenue — that was recognized when the
          // invoice was raised and never reversed.
          { chartAccountId: badDebtAccount.id, creditCents: recovery.functionalCents },
        ],
      },
      tx,
    )

    await tx
      .update(invoiceWriteOffs)
      .set({
        recoveredOn: input.recoveredOn,
        recoveredCents: input.amountCents,
        // Moves with the face figure and is never re-derived from it (Phase 116).
        functionalRecoveredCents: writeOff.functionalRecoveredCents + recovery.functionalCents,
        recoveryJournalEntryId: entry.id,
      })
      .where(eq(invoiceWriteOffs.id, writeOff.id))

    await recordAudit(
      ctx,
      {
        action: 'invoice.write_off_recovered',
        entityType: 'invoice',
        entityId: writeOff.invoiceId,
        after: {
          recoveredOn: input.recoveredOn,
          amountCents: input.amountCents,
          functionalCents: recovery.functionalCents,
        },
      },
      tx,
    )

    return { ...writeOff, recoveryJournalEntryId: entry.id }
  })
}

// --- Queries ---------------------------------------------------------------

export async function listCreditNotes(
  ctx: ActorContext,
  opts: { customerId?: string; openOnly?: boolean; limit?: number } = {},
) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: creditNotes.id,
      number: creditNotes.number,
      issueDate: creditNotes.issueDate,
      customerId: creditNotes.customerId,
      customerName: customers.name,
      status: creditNotes.status,
      currency: creditNotes.currency,
      totalCents: creditNotes.totalCents,
      remainingCents: creditNotes.remainingCents,
      // What is left, in the company's own money. The screens need both: the
      // customer is owed the foreign figure, and only the functional one may be
      // added to another note's.
      functionalRemainingCents: creditNotes.functionalRemainingCents,
      reason: creditNotes.reason,
    })
    .from(creditNotes)
    .innerJoin(customers, eq(customers.id, creditNotes.customerId))
    .where(
      scoped(
        ctx,
        creditNotes,
        eq(creditNotes.party, 'customer'),
        opts.customerId ? eq(creditNotes.customerId, opts.customerId) : undefined,
        opts.openOnly ? sql`${creditNotes.remainingCents} > 0` : undefined,
      ),
    )
    .orderBy(desc(creditNotes.issueDate))
    .limit(opts.limit ?? 50)
}

export async function listWriteOffs(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: invoiceWriteOffs.id,
      invoiceId: invoiceWriteOffs.invoiceId,
      invoiceNumber: invoices.number,
      // Phase 125 read this off the joined invoice, because the write-off had
      // no currency column of its own. Phase 127 gave it one — the row now says
      // what it is denominated in rather than being asked to prove it.
      currency: invoiceWriteOffs.currency,
      customerName: customers.name,
      writtenOffOn: invoiceWriteOffs.writtenOffOn,
      amountCents: invoiceWriteOffs.amountCents,
      reason: invoiceWriteOffs.reason,
      recoveredOn: invoiceWriteOffs.recoveredOn,
      recoveredCents: invoiceWriteOffs.recoveredCents,
    })
    .from(invoiceWriteOffs)
    .innerJoin(invoices, eq(invoices.id, invoiceWriteOffs.invoiceId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(scoped(ctx, invoiceWriteOffs))
    .orderBy(desc(invoiceWriteOffs.writtenOffOn))
    .limit(opts.limit ?? 50)
}

/**
 * Bad debt written off in a period, net of anything recovered.
 *
 * In the company's own money, since Phase 127. It summed `amount_cents` and
 * `recovered_cents` — each in its own invoice's currency — and printed the
 * result with one symbol, which ADR 0125 recorded in `NAME_COLLISIONS` as
 * unfixable until the table had a functional twin. It has one now, so this
 * reads it: the figure a roll-up may add is the figure the ledger carries, and
 * it now agrees with the profit and loss it sits beside.
 */
export async function badDebtSummary(
  ctx: ActorContext,
  range: { startDate: string; endDate: string },
) {
  requirePermission(ctx, 'reports:financial')

  const [row] = await db
    .select({
      count: sql<string>`count(*)`,
      writtenOffCents: sql<string>`coalesce(sum(${invoiceWriteOffs.functionalAmountCents}), 0)`,
      recoveredCents: sql<string>`coalesce(sum(${invoiceWriteOffs.functionalRecoveredCents}), 0)`,
    })
    .from(invoiceWriteOffs)
    .where(
      scoped(
        ctx,
        invoiceWriteOffs,
        sql`${invoiceWriteOffs.writtenOffOn} BETWEEN ${range.startDate} AND ${range.endDate}`,
      ),
    )

  const writtenOffCents = Number(row?.writtenOffCents ?? 0)
  const recoveredCents = Number(row?.recoveredCents ?? 0)

  return {
    count: Number(row?.count ?? 0),
    writtenOffCents,
    recoveredCents,
    netCents: writtenOffCents - recoveredCents,
  }
}

async function nextCreditNumber(ctx: ActorContext, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(creditNotes)
    // Scoped to the customer side since Phase 12: the table holds vendor
    // credits too, and counting them here would skip CN numbers every time a
    // vendor credit was raised.
    .where(and(eq(creditNotes.companyId, ctx.companyId), eq(creditNotes.party, 'customer')))

  return `CN-${1001 + Number(row?.count ?? 0)}`
}

/** The accounts a credit note may be raised against, for the UI. */
export async function creditableAccounts(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({ id: chartAccounts.id, number: chartAccounts.number, name: chartAccounts.name })
    .from(chartAccounts)
    .where(
      scoped(ctx, chartAccounts, sql`${chartAccounts.type} IN ('revenue', 'other_income')`),
    )
    .orderBy(asc(chartAccounts.number))
}
