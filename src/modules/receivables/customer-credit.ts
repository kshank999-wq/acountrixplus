import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  chartAccounts,
  customers,
  invoices,
  paymentApplications,
  payments,
  refunds,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { convert } from '@/modules/fx/rates'
import { settleHeld } from '@/modules/fx/settlement'
import { ensureFxAccount, rateFor } from '@/modules/fx/service'
import { relieveFunctional } from '@/modules/fx/documents'
import { createJournalEntry } from '@/modules/ledger/journal'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DocumentError } from './service'
import { drawFrom, mayUse } from './overpayment'

/**
 * Spending or refunding what a customer overpaid (spec §13, Phase 53).
 *
 * ## Why this exists at all
 *
 * Because Phase 49 taught the lesson the hard way. `applyVendorCredit` had
 * existed since Phase 12 with no caller anywhere in `src/app`, so a vendor
 * credit with anything left on it was stranded for ever and the screen showed
 * its balance beside no control.
 *
 * Held customer credit is money the business owes somebody. Recording it
 * without an end for it would be the same defect with the sign flipped: a
 * growing liability nothing can clear, which is exactly what Phase 48 found in
 * Goods Received Not Invoiced.
 *
 * ## The two ends
 *
 * - **Applied** to a later invoice: the money stays with the business and
 *   settles something. Dr Customer Overpayments, Cr Accounts Receivable.
 * - **Refunded**: it goes back. Dr Customer Overpayments, Cr the bank.
 *
 * They are different claims and neither is a special case of the other, which
 * is why Phase 52 declined to fold a refund into a void: a void says the
 * payment never happened, a refund says it happened and then went back.
 */

export type HeldCredit = {
  paymentId: string
  customerId: string
  customerName: string
  paymentDate: string
  reference: string | null
  /** What is still held from this receipt. */
  availableCents: number
}

/** What each customer is holding, newest receipt first. */
export async function heldCredits(ctx: ActorContext): Promise<HeldCredit[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      paymentId: payments.id,
      customerId: payments.customerId,
      customerName: customers.name,
      paymentDate: payments.paymentDate,
      reference: payments.reference,
      availableCents: payments.unappliedCents,
    })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId))
    .where(
      scoped(
        ctx,
        payments,
        gt(payments.unappliedCents, 0),
        // A voided receipt holds nothing (Phase 52): the money never arrived.
        eq(payments.status, 'posted'),
      ),
    )
    .orderBy(desc(payments.paymentDate))

  return rows.filter((row): row is HeldCredit => row.customerId !== null)
}

async function overpaymentAccount(companyId: string) {
  const account = await accountByNumber(companyId, SYSTEM_ACCOUNTS.customerOverpayments)
  if (!account) {
    throw new DocumentError('The Customer Overpayments account is missing from the chart.')
  }
  return account
}

/**
 * Puts held credit against an invoice.
 *
 * The application is written onto the **same payment** rather than invented as
 * a new one. The money arrived once; what is happening now is that some of it
 * finally has a document to belong to, which is precisely what a
 * `payment_applications` row says. A second payment row would double the cash
 * on any report that sums receipts.
 */
export async function applyCredit(
  ctx: ActorContext,
  input: { paymentId: string; invoiceId: string; amountCents?: number; appliedOn: string },
): Promise<{ appliedCents: number; remainingCents: number; invoiceNumber: string }> {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(scoped(ctx, payments, eq(payments.id, input.paymentId)))
      .limit(1)

    if (!payment) throw new DocumentError('That payment is not on these books.')
    if (payment.status === 'void') throw new DocumentError('That payment has been voided.')
    if (payment.unappliedCents <= 0) {
      throw new DocumentError('That receipt has nothing left over to apply.')
    }

    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(scoped(ctx, invoices, eq(invoices.id, input.invoiceId)))
      .limit(1)

    if (!invoice) throw new DocumentError('That invoice is not on these books.')
    if (invoice.status === 'void') throw new DocumentError('That invoice has been voided.')

    // A credit from one customer cannot settle another's invoice. Offering it
    // would be offering a refusal, and doing it would move money between two
    // people's accounts.
    if (invoice.customerId !== payment.customerId) {
      throw new DocumentError('That credit belongs to a different customer.')
    }

    const amountCents =
      input.amountCents ??
      drawFrom({ availableCents: payment.unappliedCents, dueCents: invoice.balanceCents })

    const permitted = mayUse({
      use: 'apply',
      amountCents,
      availableCents: payment.unappliedCents,
      dueCents: invoice.balanceCents,
    })
    if (!permitted.ok) throw new DocumentError(permitted.why)

    const balanceAfter = invoice.balanceCents - amountCents

    /**
     * The settlement, in the company's own money (Phase 114).
     *
     * Two balances are being moved and they are carried at **two different
     * rates**: the invoice at the rate it was raised at, the held credit at the
     * rate the money arrived at. `settleHeld` is the rule Phase 68 wrote for
     * exactly this, and `refundCredit` a few hundred lines below has used it
     * since — while this function converted both sides at the invoice's rate
     * and posted no difference at all.
     *
     * The rates need not be different currencies to differ: a euro receipt in
     * January and a euro invoice in June are the same currency at two rates,
     * which is the ordinary case.
     */
    const relief = relieveFunctional(invoice, amountCents)
    const release = relieveFunctional(
      {
        balanceCents: payment.unappliedCents,
        exchangeRateMillionths: payment.exchangeRateMillionths,
        functionalBalanceCents: payment.functionalUnappliedCents,
      },
      amountCents,
    )
    const settlement = settleHeld({
      releasedCents: release.functionalCents,
      relievedCents: relief.functionalCents,
    })

    await tx
      .update(invoices)
      .set({
        balanceCents: balanceAfter,
        // What `relieveFunctional` worked out above, not a second conversion:
        // computing it twice is two answers to what this invoice gives up, and
        // its rule that the last relief takes the whole remaining functional
        // balance is the one that stops a stranded cent.
        functionalBalanceCents: relief.functionalBalanceCents,
        status: balanceAfter === 0 ? 'paid' : 'partial',
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoice.id))

    await tx.insert(paymentApplications).values({
      companyId: ctx.companyId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      billId: null,
      amountCents,
      // The day the credit was spent, which is the day the journal entry above
      // is dated and — months after the money arrived — not the payment's own
      // date (Phase 113). Writing the payment's date here is what put a July
      // credit's revenue into a closed March on a cash basis.
      appliedOn: input.appliedOn,
    })

    /**
     * The claim is conditional on there still being enough held, so two people
     * applying the same credit at once produce one application and the second
     * finds nothing — the database arbitrates, as it does everywhere in this
     * system two people can act at once.
     */
    const claimed = await tx
      .update(payments)
      .set({
        unappliedCents: payment.unappliedCents - amountCents,
        // Both halves together (Phase 65). `relieveFunctional` is the rule the
        // invoice and the credit note already use: the last draw takes whatever
        // functional remainder is left, so the two columns reach zero on the
        // same movement and neither strands a cent behind the other.
        //
        // `release` from above rather than the same call written again
        // (Phase 114): it is the same question — what does the held credit give
        // up — and the entry now debits the liability by exactly this, so a
        // second call is a second place for the two to drift apart.
        functionalUnappliedCents: release.functionalBalanceCents,
      })
      .where(
        and(
          eq(payments.id, payment.id),
          eq(payments.unappliedCents, payment.unappliedCents),
        ),
      )
      .returning({ id: payments.id })

    if (claimed.length === 0) {
      throw new DocumentError('That credit was applied by somebody else a moment ago.')
    }

    const held = await overpaymentAccount(ctx.companyId)
    const control = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsReceivable)
    if (!control) throw new DocumentError('The Accounts Receivable account is missing.')

    const fxAccount = settlement.realisedCents === 0 ? null : await ensureFxAccount(ctx, tx)

    await createJournalEntry(
      ctx,
      {
        entryDate: input.appliedOn,
        memo: `Credit applied to ${invoice.number}`,
        source: 'payment',
        sourceType: 'payment',
        sourceId: payment.id,
        lines: [
          // The liability at what it has been carried at since the money came
          // in, the receivable at what the invoice was raised at, and the
          // difference where a difference belongs: it is a rate movement
          // between two dates, not revenue, because nothing more was sold.
          { chartAccountId: held.id, debitCents: settlement.releasedCents },
          { chartAccountId: control.id, creditCents: settlement.relievedCents },
          ...(fxAccount
            ? [
                settlement.realisedCents > 0
                  ? {
                      chartAccountId: fxAccount,
                      creditCents: settlement.realisedCents,
                      memo: 'Exchange gain',
                    }
                  : {
                      chartAccountId: fxAccount,
                      debitCents: -settlement.realisedCents,
                      memo: 'Exchange loss',
                    },
              ]
            : []),
        ],
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'payment.credit_applied',
        entityType: 'payment',
        entityId: payment.id,
        after: { invoiceNumber: invoice.number, amountCents },
      },
      tx,
    )

    return {
      appliedCents: amountCents,
      remainingCents: payment.unappliedCents - amountCents,
      invoiceNumber: invoice.number,
    }
  })
}

/**
 * Gives held credit back.
 *
 * Phase 52's named follow-up, and deliberately not folded into a void: a void
 * says the payment never happened, and a refund says it happened and then went
 * the other way. Conflating them would let somebody erase a receipt the
 * customer's own bank statement still shows.
 *
 * The refund is **not** a `payments` row. A payment is money arriving against
 * a document, and this is money leaving against a liability — recording it as
 * a negative receipt would break the check constraint that keeps payment
 * amounts positive, and would make every report that sums receipts wrong by
 * twice the refund.
 */
export async function refundCredit(
  ctx: ActorContext,
  input: {
    paymentId: string
    amountCents: number
    financialAccountId: string
    refundedOn: string
    reference?: string
  },
): Promise<{ refundedCents: number; remainingCents: number; customerName: string }> {
  requirePermission(ctx, 'accounting:journal')

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(scoped(ctx, payments, eq(payments.id, input.paymentId)))
      .limit(1)

    if (!payment) throw new DocumentError('That payment is not on these books.')
    if (payment.status === 'void') throw new DocumentError('That payment has been voided.')

    const permitted = mayUse({
      use: 'refund',
      amountCents: input.amountCents,
      availableCents: payment.unappliedCents,
      // In the money the customer sent, so a euro overpayment is refused in
      // euro rather than as a bare number (Phase 67).
      currency: payment.currency,
    })
    if (!permitted.ok) throw new DocumentError(permitted.why)

    /**
     * The three amounts a refund actually is (Phase 67).
     *
     * This posted `Dr held / Cr bank` at the **face amount** from Phase 53 until
     * now, which was right while every holding was in the company's own money.
     * Phase 62 let a receipt arrive in euro; Phase 65 taught the column below to
     * carry what it was worth and left this entry alone. Refunding €500 posted
     * 50000 to a dollar ledger and released 50000 of a liability carried at
     * 54175 — leaving $41.75 of somebody else's money on the balance sheet for
     * ever.
     *
     * `paidCents` uses the rate on the day the money leaves, because that is
     * what the bank actually gives up and what the statement will say.
     */
    const { rateMillionths } = await rateFor(ctx, payment.currency, input.refundedOn, tx)
    const paidCents = convert(input.amountCents, rateMillionths)

    const release = relieveFunctional(
      {
        balanceCents: payment.unappliedCents,
        exchangeRateMillionths: payment.exchangeRateMillionths,
        functionalBalanceCents: payment.functionalUnappliedCents,
      },
      input.amountCents,
    )
    const settlement = settleHeld({
      releasedCents: release.functionalCents,
      relievedCents: paidCents,
    })

    const claimed = await tx
      .update(payments)
      .set({
        unappliedCents: payment.unappliedCents - input.amountCents,
        // Refunding it releases the same functional share (Phase 65).
        functionalUnappliedCents: release.functionalBalanceCents,
      })
      .where(
        and(
          eq(payments.id, payment.id),
          eq(payments.unappliedCents, payment.unappliedCents),
        ),
      )
      .returning({ id: payments.id })

    if (claimed.length === 0) {
      throw new DocumentError('That credit was used by somebody else a moment ago.')
    }

    const [account] = await tx
      .select({ chartAccountId: chartAccounts.id, number: chartAccounts.number })
      .from(chartAccounts)
      .innerJoin(
        sql`financial_accounts`,
        sql`financial_accounts.chart_account_id = ${chartAccounts.id}`,
      )
      .where(
        and(
          eq(chartAccounts.companyId, ctx.companyId),
          sql`financial_accounts.id = ${input.financialAccountId}`,
        ),
      )
      .limit(1)

    if (!account) throw new DocumentError('That account is not on these books.')

    const held = await overpaymentAccount(ctx.companyId)

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.refundedOn,
        memo: input.reference
          ? `Refund of overpayment — ${input.reference}`
          : 'Refund of overpayment',
        source: 'payment',
        sourceType: 'payment',
        sourceId: payment.id,
        // The liability at what it was carried at, the bank at what actually
        // left it, and the gap named where a gap belongs (Phase 67).
        lines: [
          { chartAccountId: held.id, debitCents: settlement.releasedCents },
          { chartAccountId: account.chartAccountId, creditCents: paidCents },
          ...(settlement.realisedCents === 0
            ? []
            : [
                settlement.realisedCents > 0
                  ? {
                      chartAccountId: await ensureFxAccount(ctx, tx),
                      creditCents: settlement.realisedCents,
                      memo: 'Exchange gain',
                    }
                  : {
                      chartAccountId: await ensureFxAccount(ctx, tx),
                      debitCents: -settlement.realisedCents,
                      memo: 'Exchange loss',
                    },
              ]),
        ],
      },
      tx,
    )

    /**
     * Written down, which it was not before Phase 68.
     *
     * This posted a journal entry and nothing else, so the only record that a
     * refund had happened was `unapplied_cents` being smaller than it was — a
     * figure that an application also moves. Reconciling the bank line against
     * the reason for it meant reading the ledger backwards.
     */
    await tx.insert(refunds).values({
      companyId: ctx.companyId,
      subjectType: 'payment',
      subjectId: payment.id,
      direction: 'out',
      amountCents: input.amountCents,
      currency: payment.currency,
      carriedCents: settlement.releasedCents,
      cashCents: paidCents,
      realisedCents: settlement.realisedCents,
      exchangeRateMillionths: rateMillionths,
      refundedOn: input.refundedOn,
      reference: input.reference ?? null,
      financialAccountId: input.financialAccountId,
      journalEntryId: entry.id,
      createdBy: ctx.userId,
    })

    const [customer] = await tx
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, payment.customerId!))
      .limit(1)

    await recordAudit(
      ctx,
      {
        action: 'payment.credit_refunded',
        entityType: 'payment',
        entityId: payment.id,
        after: { amountCents: input.amountCents, reference: input.reference ?? null },
      },
      tx,
    )

    return {
      refundedCents: input.amountCents,
      remainingCents: payment.unappliedCents - input.amountCents,
      customerName: customer?.name ?? 'the customer',
    }
  })
}
