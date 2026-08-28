import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  checkouts,
  customers,
  depositItems,
  deposits,
  drawerShifts,
  invoices,
  paymentApplications,
  payments,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { convert } from '@/modules/fx/rates'
import {
  listPeriods,
  reverseEntry,
  voidJournalEntry,
} from '@/modules/ledger/journal'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DocumentError } from './service'
import {
  restorationsFor,
  voidability,
  type ClosedPeriod,
  type PaymentTies,
  type Restoration,
  type VoidVerdict,
  type VoidablePayment,
} from './payment-void'

/**
 * Taking a payment back (spec §13, §16, §19, Phase 52).
 *
 * ## Which void this is
 *
 * `voidDocument` cancels an invoice or a bill. This cancels the **payment**,
 * which is a different thing and was missing entirely: there was no status
 * column on `payments`, so there was nowhere to record that a payment did not
 * happen even if somebody had written the code.
 *
 * ## The ledger half
 *
 * Voided or reversed by Phase 51's rule, and reached through
 * `voidJournalEntry` — the **internal** path, inside this transaction, exactly
 * as `voidDocument` does it. `voidEntry`, the person-initiated one, now refuses
 * an entry that belongs to a document, and a payment's entry is one of those.
 * That refusal is the guard working, not an obstacle to route around.
 */

async function closedPeriodsFor(ctx: ActorContext): Promise<ClosedPeriod[]> {
  const periods = await listPeriods(ctx)

  return periods
    .filter((period) => period.status === 'closed')
    .map((period) => ({ periodStart: period.periodStart, periodEnd: period.periodEnd }))
}

/** What else already claims this payment's money. */
async function tiesFor(ctx: ActorContext, payment: { id: string; drawerShiftId: string | null }) {
  const [deposited] = await db
    .select({ number: deposits.number })
    .from(depositItems)
    .innerJoin(deposits, eq(deposits.id, depositItems.depositId))
    .where(
      and(
        eq(depositItems.companyId, ctx.companyId),
        eq(depositItems.paymentId, payment.id),
      ),
    )
    .limit(1)

  const [settled] = await db
    .select({ id: checkouts.id })
    .from(checkouts)
    .where(
      and(
        eq(checkouts.companyId, ctx.companyId),
        eq(checkouts.paymentId, payment.id),
        eq(checkouts.status, 'succeeded'),
      ),
    )
    .limit(1)

  let shift: PaymentTies['shift'] = null
  if (payment.drawerShiftId) {
    const [row] = await db
      .select({ status: drawerShifts.status, openedAt: drawerShifts.openedAt })
      .from(drawerShifts)
      .where(scoped(ctx, drawerShifts, eq(drawerShifts.id, payment.drawerShiftId)))
      .limit(1)

    if (row) {
      shift = {
        label: `the shift opened ${row.openedAt.toISOString().slice(0, 10)}`,
        closed: row.status !== 'open',
      }
    }
  }

  // Documents this payment settled that have since been voided. Restoring a
  // balance onto one would make a cancelled document also claim to be owed.
  const applications = await db
    .select({ invoiceId: paymentApplications.invoiceId, billId: paymentApplications.billId })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.companyId, ctx.companyId),
        eq(paymentApplications.paymentId, payment.id),
      ),
    )

  const invoiceIds = applications.map((a) => a.invoiceId).filter((id): id is string => !!id)
  const billIds = applications.map((a) => a.billId).filter((id): id is string => !!id)

  const voidedDocuments: string[] = []

  if (invoiceIds.length > 0) {
    const rows = await db
      .select({ number: invoices.number, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, invoiceIds)))
    voidedDocuments.push(...rows.filter((r) => r.status === 'void').map((r) => r.number))
  }

  if (billIds.length > 0) {
    const rows = await db
      .select({ number: bills.number, status: bills.status })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.id, billIds)))
    voidedDocuments.push(...rows.filter((r) => r.status === 'void').map((r) => r.number))
  }

  return {
    depositNumber: deposited?.number ?? null,
    shift,
    settledAtProcessor: !!settled,
    voidedDocuments,
  } satisfies PaymentTies
}

export type PaymentRow = VoidablePayment & {
  partyName: string | null
  financialAccountId: string | null
  voidReason: string | null
  /** What it settled, and what putting it back would do to each document. */
  restorations: Restoration[]
  /** Whether it may be taken back, and why not when it may not. */
  verdict: VoidVerdict
}

/**
 * What has been received and paid, with what each one may still be undone to.
 *
 * Payments have never been listed anywhere. They are recorded from the invoices
 * screen and the payables screen and then vanish into balances — so "did that
 * $1,500 go in twice?" was a question with no screen behind it.
 */
export async function listPayments(
  ctx: ActorContext,
  opts: { limit?: number; today?: string } = {},
): Promise<PaymentRow[]> {
  requirePermission(ctx, 'accounting:view')

  const today = opts.today ?? new Date().toISOString().slice(0, 10)

  const rows = await db
    .select({
      id: payments.id,
      kind: payments.kind,
      paymentDate: payments.paymentDate,
      amountCents: payments.amountCents,
      status: payments.status,
      reference: payments.reference,
      voidReason: payments.voidReason,
      financialAccountId: payments.financialAccountId,
      drawerShiftId: payments.drawerShiftId,
      customerName: customers.name,
      vendorName: vendors.name,
    })
    .from(payments)
    .leftJoin(customers, eq(customers.id, payments.customerId))
    .leftJoin(vendors, eq(vendors.id, payments.vendorId))
    .where(scoped(ctx, payments))
    .orderBy(desc(payments.paymentDate), desc(payments.createdAt))
    .limit(opts.limit ?? 100)

  const closedPeriods = await closedPeriodsFor(ctx)

  return Promise.all(
    rows.map(async (row) => {
      const payment: VoidablePayment = {
        id: row.id,
        kind: row.kind,
        paymentDate: row.paymentDate,
        amountCents: row.amountCents,
        status: row.status,
        reference: row.reference,
      }

      const ties = await tiesFor(ctx, { id: row.id, drawerShiftId: row.drawerShiftId })

      return {
        ...payment,
        partyName: row.customerName ?? row.vendorName ?? null,
        financialAccountId: row.financialAccountId,
        voidReason: row.voidReason,
        restorations: await restorationsForPayment(ctx, row.id, row.kind),
        verdict: voidability({ payment, ties, closedPeriods, today }),
      }
    }),
  )
}

/** What each document this payment settled would go back to. */
async function restorationsForPayment(
  ctx: ActorContext,
  paymentId: string,
  kind: 'receipt' | 'disbursement',
): Promise<Restoration[]> {
  const table = kind === 'receipt' ? invoices : bills
  const idColumn = kind === 'receipt' ? paymentApplications.invoiceId : paymentApplications.billId

  const rows = await db
    .select({
      documentId: table.id,
      number: table.number,
      amountCents: paymentApplications.amountCents,
      balanceCents: table.balanceCents,
      totalCents: table.totalCents,
    })
    .from(paymentApplications)
    .innerJoin(table, eq(table.id, idColumn))
    .where(
      and(
        eq(paymentApplications.companyId, ctx.companyId),
        eq(paymentApplications.paymentId, paymentId),
      ),
    )

  return restorationsFor(rows)
}

export type VoidResult = {
  amountCents: number
  restorations: Restoration[]
  ledger: 'void' | 'reverse'
  reversalNumber?: number
}

/**
 * Voids a payment and puts back everything it settled.
 *
 * ## Why the applications stay
 *
 * They are the record of what this payment settled, and deleting them would
 * leave a void payment stating an amount with nothing saying where it went.
 * Every reader that sums them excludes void payments instead — cash-basis
 * reporting above all, where a voided receipt left in place would report
 * revenue that was never received.
 */
export async function voidPayment(
  ctx: ActorContext,
  input: { paymentId: string; reason: string },
): Promise<VoidResult> {
  requirePermission(ctx, 'accounting:journal')

  const reason = input.reason.trim()
  if (!reason) {
    throw new DocumentError(
      'Say why this payment is being taken back. A void with no reason is a hole somebody has ' +
        'to reconstruct from dates six months later.',
    )
  }

  const [row] = await db
    .select()
    .from(payments)
    .where(scoped(ctx, payments, eq(payments.id, input.paymentId)))
    .limit(1)

  if (!row) throw new DocumentError('That payment is not on these books.')

  const payment: VoidablePayment = {
    id: row.id,
    kind: row.kind,
    paymentDate: row.paymentDate,
    amountCents: row.amountCents,
    status: row.status,
    reference: row.reference,
  }

  const [ties, closedPeriods] = await Promise.all([
    tiesFor(ctx, { id: row.id, drawerShiftId: row.drawerShiftId }),
    closedPeriodsFor(ctx),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const verdict = voidability({ payment, ties, closedPeriods, today })

  if (!verdict.ok) throw new DocumentError(verdict.why)

  const restorations = await restorationsForPayment(ctx, row.id, row.kind)
  const table = row.kind === 'receipt' ? invoices : bills

  let reversalNumber: number | undefined

  await db.transaction(async (tx) => {
    /**
     * The claim is conditional on the payment still being posted, so two
     * people pressing at once produce one void and the second finds nothing to
     * claim — the database arbitrates, as it does everywhere in this system
     * two people can act at once.
     */
    const claimed = await tx
      .update(payments)
      .set({
        status: 'void',
        voidedAt: new Date(),
        voidedBy: ctx.userId,
        voidReason: reason,
      })
      .where(and(eq(payments.id, row.id), eq(payments.status, 'posted')))
      .returning({ id: payments.id })

    if (claimed.length === 0) {
      throw new DocumentError('That payment was voided by somebody else a moment ago.')
    }

    for (const restoration of restorations) {
      const [document] = await tx
        .select()
        .from(table)
        .where(and(eq(table.id, restoration.documentId), eq(table.companyId, ctx.companyId)))
        .limit(1)

      /**
       * The functional balance is recomputed from the restored balance at the
       * document's own rate rather than added back application by application.
       *
       * `payment_applications` stores the amount in the *document's* currency
       * and never the functional amount that was relieved, so there is nothing
       * exact to add back. Converting the restored balance at the rate the
       * document was raised at is the same arithmetic that set it in the first
       * place, and it is the invariant the FX module actually wants: what is
       * still owed, carried at the rate it was booked at.
       */
      await tx
        .update(table)
        .set({
          balanceCents: restoration.balanceAfterCents,
          functionalBalanceCents: convert(
            restoration.balanceAfterCents,
            document.exchangeRateMillionths,
          ),
          status: restoration.status,
          updatedAt: new Date(),
        })
        .where(and(eq(table.id, restoration.documentId), eq(table.companyId, ctx.companyId)))
    }

    if (row.journalEntryId) {
      if (verdict.ledger === 'reverse') {
        const reversal = await reverseEntry(
          ctx,
          row.journalEntryId,
          verdict.reversalDate ?? today,
          `Reversal — payment voided: ${reason}`,
        )
        reversalNumber = reversal.entryNumber
      } else {
        await voidJournalEntry(ctx, row.journalEntryId, tx)
      }
    }

    await recordAudit(
      ctx,
      {
        action: 'payment.void',
        entityType: 'payment',
        entityId: row.id,
        before: { status: 'posted', amountCents: row.amountCents },
        after: {
          status: 'void',
          reason,
          ledger: verdict.ledger,
          restored: restorations.map((r) => r.number),
        },
      },
      tx,
    )
  })

  return {
    amountCents: row.amountCents,
    restorations,
    ledger: verdict.ledger,
    reversalNumber,
  }
}
