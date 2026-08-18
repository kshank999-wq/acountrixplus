import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { customers, invoices } from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordPayment } from '@/modules/receivables/service'
import { tenderFor, TenderError, type Settlement, type Tender } from './tender'

/**
 * Taking money at the counter (spec §13).
 *
 * The bill is Phase 2's invoice and the payment is Phase 2's `recordPayment`;
 * this file is the thing that stands between them and a person holding a
 * twenty. It is small on purpose — the accounting already existed, and what was
 * missing was the gesture.
 */

export type TakePaymentInput = {
  invoiceId: string
  receivedOn: string
  tenders: Tender[]
  /**
   * Where the money lands.
   *
   * Omitted, it goes to **Undeposited Funds**, which is the honest answer for
   * anything taken across a counter: the notes are in a drawer, not in the
   * bank, and pretending otherwise makes the next bank reconciliation
   * unsolvable. Phase 12's deposit slip is what moves it, when somebody
   * actually walks to the bank.
   */
  financialAccountId?: string
  memo?: string
}

export type TakePaymentResult = {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  settlement: Settlement
  /** One per tender that settled something. */
  paymentIds: string[]
}

/**
 * Settles an invoice at the desk.
 *
 * Each tender becomes its own payment, because they are genuinely different
 * events: the card one will appear on a merchant statement, the cash one will
 * be in a deposit slip, and a bank reconciliation has to be able to match each
 * against the thing it actually turns into. One combined payment would be
 * neither.
 *
 * ## What this does not do
 *
 * It does not take more than is owed. A customer who wants to pay ahead is
 * making a *prepayment*, which is a liability and not a settlement of a bill
 * that does not exist yet — `tenderFor` refuses the non-cash case outright and
 * treats the cash case as change.
 */
export async function takePayment(
  ctx: ActorContext,
  input: TakePaymentInput,
): Promise<TakePaymentResult> {
  requirePermission(ctx, 'accounting:journal')

  const [invoice] = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      balanceCents: invoices.balanceCents,
      customerId: invoices.customerId,
      customerName: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(scoped(ctx, invoices, eq(invoices.id, input.invoiceId)))
    .limit(1)

  if (!invoice) throw new TenderError('No such invoice.')

  if (invoice.status === 'void') {
    throw new TenderError(`Invoice ${invoice.number} was voided. There is nothing to pay.`)
  }

  if (invoice.balanceCents === 0) {
    throw new TenderError(`Invoice ${invoice.number} is already settled.`)
  }

  const settlement = tenderFor(invoice.balanceCents, input.tenders)

  // One payment per tender. `recordPayment` posts and applies each in its own
  // transaction; a failure part-way leaves the earlier tenders recorded, which
  // is the truthful outcome — the card really was charged.
  const paymentIds: string[] = []

  for (const applied of settlement.applied) {
    const payment = await recordPayment(ctx, {
      kind: 'receipt',
      customerId: invoice.customerId,
      paymentDate: input.receivedOn,
      amountCents: applied.amountCents,
      financialAccountId: input.financialAccountId,
      reference: applied.reference ?? undefined,
      memo:
        input.memo ??
        `${applied.kind === 'cash' ? 'Cash' : labelOf(applied.kind)} at the counter — ${invoice.number}`,
      applications: [{ invoiceId: invoice.id, amountCents: applied.amountCents }],
    })

    paymentIds.push(payment.id)
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    customerName: invoice.customerName,
    settlement,
    paymentIds,
  }
}

function labelOf(kind: string): string {
  if (kind === 'gift_card') return 'Gift card'
  if (kind === 'bank_transfer') return 'Bank transfer'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

export type Payable = {
  invoiceId: string
  number: string
  customerName: string
  totalCents: number
  balanceCents: number
  issueDate: string
}

/** What one invoice still owes, for a screen about to take money for it. */
export async function payableInvoice(
  ctx: ActorContext,
  invoiceId: string,
): Promise<Payable | null> {
  requirePermission(ctx, 'accounting:view')

  const [row] = await db
    .select({
      invoiceId: invoices.id,
      number: invoices.number,
      customerName: customers.name,
      totalCents: invoices.totalCents,
      balanceCents: invoices.balanceCents,
      issueDate: invoices.issueDate,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))
    .limit(1)

  if (!row || row.status === 'void') return null

  return {
    invoiceId: row.invoiceId,
    number: row.number,
    customerName: row.customerName,
    totalCents: row.totalCents,
    balanceCents: row.balanceCents,
    issueDate: row.issueDate,
  }
}

export { TenderError } from './tender'
export type { Tender, TenderKind, Settlement } from './tender'
