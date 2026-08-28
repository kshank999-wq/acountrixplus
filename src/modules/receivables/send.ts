import { randomBytes } from 'node:crypto'
import { and, eq, asc, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  companies,
  companyProfiles,
  customers,
  invoiceLines,
  invoices,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError, logUnexpected } from '@/modules/errors'
import { formatCents } from '@/lib/money'
import { sendInvoiceEmail } from '@/modules/notify/service'
import { appBaseUrl } from '@/modules/notify/transactional'
import { logCommunication } from '@/modules/engagement/communications'
import {
  customerFacingInvoice,
  sendability,
  type CustomerFacingInvoice,
} from './sharing'

/**
 * Getting an invoice to the customer who owes it (spec §13, §19).
 *
 * Phase 41 made a business able to raise an invoice. Nobody pays one they
 * never received, and until now the only way to get one out of the system was
 * to be signed in, open the PDF route, download it and attach it to an email
 * by hand.
 *
 * ## A link, not a copy
 *
 * The customer gets a link to a page that renders the **live** record.
 * `modules/pdf/invoice.ts` set out the reason when invoice PDFs were built and
 * it still decides this: a stored copy would be a second answer to *how much
 * does this customer owe*, and there is one ledger. So the balance somebody
 * opens in October is what is outstanding in October, not what it was in
 * March — which is what a customer reconciling their own payables needs, and
 * it means a part payment does not require a reissue.
 *
 * What is recorded is the **communication**: who it went to, when, how many
 * times. That is evidence of asking, which is a different claim from evidence
 * of the amount, and only the first one needed storing.
 */

export class SendInvoiceError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'SendInvoiceError'
  }
}

/**
 * 32 bytes of randomness, url-safe.
 *
 * Long because it is the *only* thing protecting the invoice: there is no
 * second factor on the public route, and a token somebody can walk is a
 * customer list.
 */
function mintShareToken(): string {
  return randomBytes(24).toString('base64url')
}

export type SendResult = {
  to: string
  isReminder: boolean
  url: string
  delivered: boolean
  /** The provider's own words when it refused. Null when it took the message. */
  error: string | null
}

/**
 * Sends an invoice, or says why it cannot.
 *
 * The token is minted on the first send and never rotated, so a link filed in
 * somebody's inbox two years ago still opens. Deliberately not minted at
 * creation: a live door onto an invoice nobody asked to share is a door open
 * for no reason.
 */
export async function sendInvoice(
  ctx: ActorContext,
  invoiceId: string,
  opts: { to?: string | null } = {},
): Promise<SendResult> {
  // The same permission that raises one. Somebody trusted to create a debt is
  // trusted to ask for it.
  requirePermission(ctx, 'accounting:journal')

  const [row] = await db
    .select({ invoice: invoices, customer: customers, company: companies })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(companies, eq(companies.id, invoices.companyId))
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))
    .limit(1)

  if (!row) throw new SendInvoiceError('That invoice is not on these books.')

  const verdict = sendability({
    invoice: row.invoice,
    customer: { name: row.customer.name, email: row.customer.email },
    override: opts.to,
  })

  if (!verdict.ok) throw new SendInvoiceError(verdict.reason)

  const token = row.invoice.shareToken ?? mintShareToken()
  const isReminder = row.invoice.sendCount > 0

  // The row is updated *before* the send, not after.
  //
  // A message that leaves and is not recorded is worse than one recorded and
  // not sent: the first has a customer holding an invoice the business does
  // not know it sent, and the second shows up in the delivery log as a
  // failure somebody can act on. So the token exists and the count moves
  // first, and the outcome is reported honestly either way.
  await db
    .update(invoices)
    .set({
      shareToken: token,
      sentAt: new Date(),
      sentTo: verdict.to,
      sendCount: sql`${invoices.sendCount} + 1`,
      updatedAt: new Date(),
    })
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))

  const outcome = await sendInvoiceEmail({
    to: verdict.to,
    toName: row.customer.name,
    companyId: ctx.companyId,
    companyName: row.company.name,
    invoiceNumber: row.invoice.number,
    amountDue: formatCents(row.invoice.balanceCents, row.invoice.currency),
    dueDate: row.invoice.dueDate,
    token,
    isReminder,
    reference: `invoice:${invoiceId}`,
  })

  // Filed on the customer's timeline when they are linked to a CRM record.
  // Many are not — a customer created from the invoice screen has no
  // organization — and the transactional message row is the record in that
  // case, which is where Phase 24 already looks for failures.
  if (row.customer.organizationId) {
    await logCommunication(ctx, {
      organizationId: row.customer.organizationId,
      channel: 'email',
      direction: 'outbound',
      summary: `${isReminder ? 'Reminded about' : 'Sent'} invoice ${row.invoice.number} — ${formatCents(row.invoice.balanceCents, row.invoice.currency)}`,
      body: `To ${verdict.to}.`,
      transactionalMessageId: outcome.ok ? outcome.messageId : null,
    }).catch(() => {
      // A timeline entry is a nicety; the invoice has been sent either way and
      // failing the whole call over it would be the wrong trade.
    })
  }

  await recordAudit(ctx, {
    action: 'invoice.send',
    entityType: 'invoice',
    entityId: invoiceId,
    after: { to: verdict.to, isReminder, delivered: outcome.ok },
  })

  return {
    to: verdict.to,
    isReminder,
    url: `${appBaseUrl()}/i/${token}`,
    delivered: outcome.ok,
    error: outcome.ok ? null : outcome.error,
  }
}

/**
 * Mints the link without sending anything.
 *
 * For the business that would rather paste it into their own email, or send it
 * by text. Same token the email would have used, so the two do not diverge.
 */
export async function shareLinkFor(ctx: ActorContext, invoiceId: string): Promise<string> {
  requirePermission(ctx, 'accounting:journal')

  const [invoice] = await db
    .select({ id: invoices.id, shareToken: invoices.shareToken, status: invoices.status })
    .from(invoices)
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))
    .limit(1)

  if (!invoice) throw new SendInvoiceError('That invoice is not on these books.')
  if (invoice.status === 'void') {
    throw new SendInvoiceError('This invoice has been voided. Raise a new one instead.')
  }

  if (invoice.shareToken) return `${appBaseUrl()}/i/${invoice.shareToken}`

  const token = mintShareToken()
  await db
    .update(invoices)
    .set({ shareToken: token, updatedAt: new Date() })
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))

  await recordAudit(ctx, {
    action: 'invoice.share',
    entityType: 'invoice',
    entityId: invoiceId,
    after: { linkCreated: true },
  })

  return `${appBaseUrl()}/i/${token}`
}

/**
 * Stops a link working.
 *
 * The invoice is untouched — this is about the door, not the debt. Sending it
 * again mints a new token, so a link that went to the wrong address can be
 * killed without crediting anything.
 */
export async function revokeShareLink(ctx: ActorContext, invoiceId: string): Promise<void> {
  requirePermission(ctx, 'accounting:journal')

  const result = await db
    .update(invoices)
    .set({ shareToken: null, updatedAt: new Date() })
    .where(scoped(ctx, invoices, eq(invoices.id, invoiceId)))
    .returning({ id: invoices.id })

  if (result.length === 0) throw new SendInvoiceError('That invoice is not on these books.')

  await recordAudit(ctx, {
    action: 'invoice.share',
    entityType: 'invoice',
    entityId: invoiceId,
    after: { linkRevoked: true },
  })
}

export type PublicInvoice = {
  view: CustomerFacingInvoice
  /** For the PDF route, which needs to find the same row again. */
  invoiceId: string
  companyId: string
}

/**
 * Resolves a share link, or null.
 *
 * **No `ActorContext`.** This is the one read in the module that is not scoped
 * to a tenant, because the caller is a stranger holding a link and there is no
 * actor to scope to. The token is what stands in for one, which is why it is
 * unique across every company and why what comes back is the allowlisted
 * projection rather than the row.
 *
 * A voided invoice resolves to nothing. Somebody who was sent a bill that was
 * later cancelled should find a dead link rather than a document they might
 * still pay.
 */
export async function invoiceByShareToken(token: string): Promise<PublicInvoice | null> {
  if (!token.trim()) return null

  const [row] = await db
    .select({ invoice: invoices, customer: customers, company: companies, profile: companyProfiles })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(companies, eq(companies.id, invoices.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, invoices.companyId))
    .where(and(eq(invoices.shareToken, token), sql`${invoices.status} <> 'void'`))
    .limit(1)

  if (!row) return null

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, row.invoice.id))
    .orderBy(asc(invoiceLines.sortOrder))

  return {
    invoiceId: row.invoice.id,
    companyId: row.invoice.companyId,
    view: customerFacingInvoice({
      invoice: row.invoice,
      lines: lines.map((line) => ({
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        amountCents: line.amountCents,
      })),
      customer: { name: row.customer.name, email: row.customer.email },
      company: {
        name: row.company.name,
        email: row.profile?.email ?? null,
        phone: row.profile?.phone ?? null,
        addressLine: row.profile?.addressLine1 ?? null,
      },
      asOf: new Date().toISOString().slice(0, 10),
    }),
  }
}

/**
 * Notes that somebody opened the link.
 *
 * Best-effort and never blocks the render: a page that fails to load because a
 * counter could not be written would be a worse product than one whose view
 * count is occasionally short.
 *
 * The failure is **logged**, though, rather than dropped. Written as a bare
 * `.catch(() => {})` this silently never worked at all — a raw `Date` inside a
 * `sql` template loses its type and the driver refuses it — and a swallowed
 * error is how a feature stays broken for a year.
 *
 * `now()` is the database's clock, which is also the honest one for "when did
 * somebody open this": it is the same clock every other row on this table is
 * stamped with.
 */
export async function recordInvoiceView(token: string): Promise<void> {
  try {
    await db
      .update(invoices)
      .set({
        firstViewedAt: sql`coalesce(${invoices.firstViewedAt}, now())`,
        lastViewedAt: sql`now()`,
        viewCount: sql`${invoices.viewCount} + 1`,
      })
      .where(eq(invoices.shareToken, token))
  } catch (error) {
    logUnexpected(error, 'recording an invoice view')
  }
}
