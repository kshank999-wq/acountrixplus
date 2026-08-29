import { randomBytes } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bills,
  companies,
  companyProfiles,
  paymentApplications,
  payments,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'
import { formatCents } from '@/lib/money'
import { sendRemittanceEmail } from '@/modules/notify/service'
import { appBaseUrl } from '@/modules/notify/transactional'
import { logCommunication } from '@/modules/engagement/communications'
import {
  remittanceSummaryLine,
  sendability,
  supplierFacingRemittance,
  type SupplierFacingRemittance,
} from './remittance'

/**
 * Getting a remittance advice to the supplier who was paid (spec §13, §19).
 *
 * The decision itself is in `remittance.ts` with no database. This is the half
 * that touches the world: reading what the payment settled, sending it, and
 * recording that it went.
 *
 * ## No freezing, unlike a statement
 *
 * Phase 55 froze a statement because a statement is a claim about a moment and
 * the books move underneath it. This is a claim about a **payment**, and a
 * posted payment does not change — its applications are written once and the
 * amount is what left the bank. So the page reads live and is stable anyway.
 *
 * The one exception is the interesting one: Phase 52 made a payment voidable,
 * and reading live is exactly what lets the page tell a supplier their advice
 * describes money that came back. A snapshot would have gone on claiming the
 * payment stood.
 */

export class RemittanceError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'RemittanceError'
  }
}

/**
 * 32 bytes of randomness, url-safe.
 *
 * Long for Phase 42's reason: it is the *only* thing protecting the document,
 * there is no second factor on the public route, and a token somebody can walk
 * is a list of who a business pays and how much.
 */
function mintShareToken(): string {
  return randomBytes(24).toString('base64url')
}

export type RemittanceSendResult = {
  to: string
  isResend: boolean
  url: string
  delivered: boolean
  error: string | null
}

async function loadPayment(ctx: ActorContext, paymentId: string) {
  const [row] = await db
    .select({
      payment: payments,
      vendor: vendors,
      company: companies,
      profile: companyProfiles,
    })
    .from(payments)
    .leftJoin(vendors, eq(vendors.id, payments.vendorId))
    .innerJoin(companies, eq(companies.id, payments.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, payments.companyId))
    .where(scoped(ctx, payments, eq(payments.id, paymentId)))
    .limit(1)

  if (!row) throw new RemittanceError('That payment is not on these books.')
  return row
}

/** What this payment settled, oldest bill first — the order a ledger reads in. */
async function settledBills(companyId: string, paymentId: string) {
  return db
    .select({
      vendorReference: bills.vendorReference,
      number: bills.number,
      issueDate: bills.issueDate,
      dueDate: bills.dueDate,
      amountCents: paymentApplications.amountCents,
      currency: bills.currency,
    })
    .from(paymentApplications)
    .innerJoin(bills, eq(bills.id, paymentApplications.billId))
    .where(
      sql`${paymentApplications.companyId} = ${companyId} and ${paymentApplications.paymentId} = ${paymentId}`,
    )
    .orderBy(asc(bills.issueDate), asc(bills.number))
}

function viewOf(
  row: Awaited<ReturnType<typeof loadPayment>>,
  bills: Awaited<ReturnType<typeof settledBills>>,
): SupplierFacingRemittance {
  return supplierFacingRemittance({
    payment: {
      kind: row.payment.kind,
      status: row.payment.status,
      paymentDate: row.payment.paymentDate,
      amountCents: row.payment.amountCents,
      /**
       * Read from the payment, since Phase 62 (it kept the currency it had
       * always known).
       *
       * This used to derive it again here as `bills[0]?.currency ?? company`,
       * which is the same rule `documentCurrency` applies when the payment is
       * recorded — two answers to one question, agreeing today with nothing
       * making them keep agreeing.
       */
      currency: row.payment.currency,
      reference: row.payment.reference,
      voidedAt: row.payment.voidedAt,
      voidReason: row.payment.voidReason,
    },
    bills: bills.map((bill) => ({
      vendorReference: bill.vendorReference,
      number: bill.number,
      issueDate: bill.issueDate,
      dueDate: bill.dueDate,
      amountCents: bill.amountCents,
    })),
    supplier: { name: row.vendor?.name ?? '', email: row.vendor?.email ?? null },
    company: {
      name: row.company.name,
      email: row.profile?.email ?? null,
      phone: row.profile?.phone ?? null,
      addressLine: row.profile?.addressLine1 ?? null,
    },
  })
}

/**
 * Sends a remittance advice, or says why it cannot.
 *
 * Gated on `accounting:view`, like sending a statement and unlike making the
 * payment. Telling somebody what they were already paid asserts nothing new —
 * the money has gone, and every figure on the advice is a fact already in the
 * books. Requiring the permission that *moves money* in order to describe money
 * that already moved would put the gate in the wrong place.
 */
export async function sendRemittance(
  ctx: ActorContext,
  paymentId: string,
  opts: { to?: string | null } = {},
): Promise<RemittanceSendResult> {
  requirePermission(ctx, 'accounting:view')

  const row = await loadPayment(ctx, paymentId)

  const verdict = sendability({
    payment: {
      kind: row.payment.kind,
      status: row.payment.status,
      amountCents: row.payment.amountCents,
      voidedAt: row.payment.voidedAt,
    },
    supplier: row.vendor ? { name: row.vendor.name, email: row.vendor.email } : null,
    sendCount: row.payment.remittanceSendCount,
    override: opts.to,
  })

  if (!verdict.ok) throw new RemittanceError(verdict.reason)

  const token = row.payment.shareToken ?? mintShareToken()
  const settled = await settledBills(ctx.companyId, paymentId)
  const view = viewOf(row, settled)

  // Recorded before the send, for Phase 42's reason: a message that leaves and
  // is not recorded leaves a supplier holding an advice the business does not
  // know it sent, while one recorded and not sent shows up in the delivery log
  // as a failure somebody can act on.
  await db
    .update(payments)
    .set({
      shareToken: token,
      remittanceSentAt: new Date(),
      remittanceSentTo: verdict.to,
      remittanceSendCount: sql`${payments.remittanceSendCount} + 1`,
    })
    .where(scoped(ctx, payments, eq(payments.id, paymentId)))

  const outcome = await sendRemittanceEmail({
    to: verdict.to,
    toName: row.vendor?.name ?? null,
    companyId: ctx.companyId,
    companyName: row.company.name,
    amount: formatCents(view.amountCents, view.currency),
    summary: remittanceSummaryLine({ remittance: view, companyName: row.company.name }),
    token,
    isResend: verdict.isResend,
    reference: `remittance:${paymentId}`,
  })

  if (row.vendor?.organizationId) {
    await logCommunication(ctx, {
      organizationId: row.vendor.organizationId,
      channel: 'email',
      direction: 'outbound',
      summary:
        `${verdict.isResend ? 'Resent' : 'Sent'} remittance advice — ` +
        `${formatCents(view.amountCents, view.currency)} against ${view.bills.length} ` +
        `${view.bills.length === 1 ? 'invoice' : 'invoices'}`,
      body: `To ${verdict.to}.`,
      transactionalMessageId: outcome.ok ? outcome.messageId : null,
    }).catch(() => {
      // A timeline entry is a nicety; the advice has gone either way.
    })
  }

  await recordAudit(ctx, {
    action: 'remittance.send',
    entityType: 'payment',
    entityId: paymentId,
    after: {
      to: verdict.to,
      amountCents: view.amountCents,
      bills: view.bills.length,
      isResend: verdict.isResend,
      delivered: outcome.ok,
    },
  })

  return {
    to: verdict.to,
    isResend: verdict.isResend,
    url: `${appBaseUrl()}/r/${token}`,
    delivered: outcome.ok,
    error: outcome.ok ? null : outcome.error,
  }
}

/**
 * Mints the link without sending anything.
 *
 * For the business that would rather paste it into their own email, and for the
 * supplier with no address on file — which is what `sendability` tells them to
 * do. Deliberately does not touch `remittanceSentAt`: handing somebody a link
 * is not the same event as posting the advice.
 */
export async function remittanceLinkFor(
  ctx: ActorContext,
  paymentId: string,
): Promise<string> {
  requirePermission(ctx, 'accounting:view')

  const [payment] = await db
    .select({ id: payments.id, kind: payments.kind, shareToken: payments.shareToken })
    .from(payments)
    .where(scoped(ctx, payments, eq(payments.id, paymentId)))
    .limit(1)

  if (!payment) throw new RemittanceError('That payment is not on these books.')
  if (payment.kind !== 'disbursement') {
    throw new RemittanceError(
      'A remittance advice is for money you paid out. This is money received.',
    )
  }

  if (payment.shareToken) return `${appBaseUrl()}/r/${payment.shareToken}`

  const token = mintShareToken()
  await db
    .update(payments)
    .set({ shareToken: token })
    .where(scoped(ctx, payments, eq(payments.id, paymentId)))

  return `${appBaseUrl()}/r/${token}`
}

/**
 * What the public page renders, looked up by token alone.
 *
 * No `ActorContext`: whoever holds the link is looking at it, and there is no
 * session. The token is the whole of the authorisation, which is why it is 32
 * bytes and why this returns the allowlisted projection rather than the rows.
 */
export async function remittanceByToken(
  token: string,
): Promise<SupplierFacingRemittance | null> {
  const trimmed = token.trim()
  if (!trimmed) return null

  const [row] = await db
    .select({
      payment: payments,
      vendor: vendors,
      company: companies,
      profile: companyProfiles,
    })
    .from(payments)
    .leftJoin(vendors, eq(vendors.id, payments.vendorId))
    .innerJoin(companies, eq(companies.id, payments.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, payments.companyId))
    .where(eq(payments.shareToken, trimmed))
    .limit(1)

  if (!row) return null

  const settled = await settledBills(row.payment.companyId, row.payment.id)
  return viewOf(row, settled)
}
