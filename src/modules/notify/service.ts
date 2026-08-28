import { invoiceSubject } from '@/modules/receivables/sharing'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { transactionalMessages } from '@/db/schema'
import {
  appBaseUrl,
  getTransactionalProvider,
  transactionalSender,
  type TransactionalKind,
  type TransactionalMessage,
} from './transactional'
import { recordOutboundMail } from '@/modules/engagement/outbound'
import { DomainError } from '@/modules/errors'

/**
 * Sending a letter that must arrive (spec §19).
 *
 * Every send is recorded, sent or failed, and **nothing here consults the
 * marketing suppression list**. See `transactional.ts` for why that is the
 * whole point rather than an oversight.
 */

export type SendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; error: string; retryable: boolean }

export type SendInput = {
  to: string
  toName?: string | null
  kind: TransactionalKind
  subject: string
  /** Plain paragraphs. The HTML body is composed from these. */
  body: string[]
  action?: { label: string; url: string }
  /** Small print under the button. */
  footnote?: string
  companyId?: string | null
  reference?: string | null
}

/**
 * How many of one kind may go to one address in an hour.
 *
 * Not primarily about cost. Somebody who can type an address into a forgot-
 * password form can otherwise use this application to post mail to a stranger
 * as fast as they can click, and the stranger's only evidence about who is
 * doing it is our sending domain.
 */
const HOURLY_LIMIT: Record<TransactionalKind, number> = {
  password_reset: 5,
  company_invitation: 20,
  practice_invitation: 20,
  security_alert: 20,
  // Higher, because this one is a business doing its job rather than a
  // credential being handled: a builder sending out Friday's invoices can
  // legitimately send thirty in a minute, all to different addresses. The
  // limit is per address per hour, so it still stops the same customer being
  // mailed the same invoice over and over.
  invoice: 12,
}

export class RateLimitedError extends DomainError {
  readonly status = 429
  constructor(readonly kind: TransactionalKind) {
    super('That has been sent several times already. Check the inbox, including spam, and wait a few minutes.')
    this.name = 'RateLimitedError'
  }
}

export async function sendTransactional(
  input: SendInput,
  exec: Executor = db,
): Promise<SendOutcome> {
  const email = input.to.trim().toLowerCase()

  const [recent] = await exec
    .select({ count: sql<string>`count(*)` })
    .from(transactionalMessages)
    .where(
      and(
        eq(transactionalMessages.email, email),
        eq(transactionalMessages.kind, input.kind),
        gte(transactionalMessages.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    )

  if (Number(recent?.count ?? 0) >= HOURLY_LIMIT[input.kind]) {
    throw new RateLimitedError(input.kind)
  }

  const sender = transactionalSender()
  const message: TransactionalMessage = {
    to: email,
    toName: input.toName ?? null,
    ...sender,
    subject: input.subject,
    kind: input.kind,
    reference: input.reference ?? null,
    text: renderText(input),
    html: renderHtml(input),
  }

  const provider = getTransactionalProvider()
  const result = await provider.send(message)

  const [record] = await exec
    .insert(transactionalMessages)
    .values({
      companyId: input.companyId ?? null,
      kind: input.kind,
      email,
      subject: input.subject,
      outcome: result.ok ? 'sent' : 'failed',
      providerKey: provider.key,
      providerMessageId: result.ok ? result.providerMessageId : null,
      error: result.ok ? null : result.error,
      reference: input.reference ?? null,
    })
    .returning({ id: transactionalMessages.id })

  // Filed against whoever it went to, when the address belongs to a contact
  // this company knows (Phase 22). Never throws and never blocks the send:
  // the letter is what matters, and a missing timeline entry is not worth
  // failing a password reset for.
  if (input.companyId) {
    await recordOutboundMail(
      {
        companyId: input.companyId,
        email,
        subject: input.subject,
        transactionalMessageId: record.id,
        delivered: result.ok,
      },
      exec,
    )
  }

  return result.ok
    ? { ok: true, messageId: result.providerMessageId }
    : { ok: false, error: result.error, retryable: result.retryable }
}

/**
 * The text part, and the source of truth for the HTML one.
 *
 * The URL is written out in full rather than hidden behind the button, because
 * a person deciding whether a link is genuine needs to be able to read where it
 * goes — and because a mail client that strips HTML should not leave somebody
 * with a letter that says "click the button" and no button.
 */
function renderText(input: SendInput): string {
  const parts = [...input.body]
  if (input.action) parts.push(`${input.action.label}:`, input.action.url)
  if (input.footnote) parts.push(input.footnote)
  return parts.join('\n\n')
}

function renderHtml(input: SendInput): string {
  const paragraphs = input.body
    .map((line) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(line)}</p>`)
    .join('')

  const button = input.action
    ? `<p style="margin:0 0 16px"><a href="${escapeHtml(input.action.url)}" ` +
      `style="display:inline-block;padding:10px 18px;background:#0f5132;color:#fff;` +
      `border-radius:6px;text-decoration:none;font-weight:600">` +
      `${escapeHtml(input.action.label)}</a></p>` +
      // The bare URL as well, for the reasons in `renderText`.
      `<p style="margin:0 0 16px;font-size:12px;color:#555;word-break:break-all">` +
      `${escapeHtml(input.action.url)}</p>`
    : ''

  const footnote = input.footnote
    ? `<p style="margin:0;font-size:12px;color:#555;line-height:1.5">${escapeHtml(input.footnote)}</p>`
    : ''

  return (
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;` +
    `max-width:520px;margin:0 auto;padding:24px;color:#111">` +
    paragraphs +
    button +
    footnote +
    `</div>`
  )
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// --- The letters ------------------------------------------------------------

export function resetUrl(token: string): string {
  return `${appBaseUrl()}/reset?token=${encodeURIComponent(token)}`
}

export function invitationUrl(token: string): string {
  return `${appBaseUrl()}/invite?token=${encodeURIComponent(token)}`
}

/** Where a customer opens the invoice they were sent (Phase 42). */
export function invoiceUrl(token: string): string {
  return `${appBaseUrl()}/i/${encodeURIComponent(token)}`
}

/**
 * Sends an invoice to the customer who owes it.
 *
 * A link rather than an attachment. The page renders the **live** record, so
 * the balance somebody opens in October is what is still outstanding in
 * October rather than what it was in March — which is the number a customer
 * chasing their own accounts payable actually needs, and the reason
 * `modules/pdf/invoice.ts` refused to snapshot in the first place.
 */
export async function sendInvoiceEmail(input: {
  to: string
  toName: string | null
  companyId: string
  companyName: string
  invoiceNumber: string
  amountDue: string
  dueDate: string
  token: string
  isReminder: boolean
  reference: string
}): Promise<SendOutcome> {
  return sendTransactional({
    to: input.to,
    toName: input.toName,
    companyId: input.companyId,
    kind: 'invoice',
    subject: invoiceSubject({
      companyName: input.companyName,
      number: input.invoiceNumber,
      isReminder: input.isReminder,
    }),
    body: [
      input.toName ? `Hello ${input.toName},` : 'Hello,',
      input.isReminder
        ? `Invoice ${input.invoiceNumber} from ${input.companyName} is still outstanding: ` +
          `${input.amountDue}, due ${input.dueDate}.`
        : `Here is invoice ${input.invoiceNumber} from ${input.companyName} for ` +
          `${input.amountDue}, due ${input.dueDate}.`,
    ],
    action: { label: 'View the invoice', url: invoiceUrl(input.token) },
    footnote:
      'The link shows what is currently outstanding, so it stays right after a part payment. ' +
      'Reply to this message if anything on it looks wrong.',
    reference: input.reference,
  })
}

export async function sendPasswordReset(input: {
  to: string
  toName: string
  token: string
  expiresAt: Date
  reference: string
  /**
   * A company the recipient belongs to, so the *failure* has somewhere to be
   * seen (Phase 38).
   *
   * A reset is a pre-authentication act and has no tenant of its own, so this
   * was null and `failedDeliveries` — which filters on `company_id = $1` —
   * could never match it. The consequence only became visible once mail could
   * genuinely fail: every failed reset, the one letter whose loss locks
   * somebody out, was invisible to every operator.
   *
   * Attributed to a company the person is already a member of, which leaks
   * nothing: that operator can see the address on the member list anyway. It
   * is deliberately not shown to every tenant, which is the other way to make
   * a null-tenant row visible and would publish "this address asked for a
   * reset" to strangers.
   */
  companyId?: string | null
}): Promise<SendOutcome> {
  const minutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000))

  return sendTransactional({
    to: input.to,
    toName: input.toName,
    companyId: input.companyId ?? null,
    kind: 'password_reset',
    subject: 'Reset your Accountrix Plus password',
    body: [
      `Hello ${input.toName},`,
      'Somebody asked to reset the password on this account. If that was you, use the link below.',
    ],
    action: { label: 'Choose a new password', url: resetUrl(input.token) },
    footnote:
      `This link works once and expires in ${minutes} minutes. ` +
      'If you did not ask for it, you can ignore this — your password has not changed, and nobody ' +
      'can use this link without your inbox. ' +
      // Said plainly, because somebody with two-factor turned on should not be
      // frightened into thinking a reset request has bypassed it.
      'Resetting a password does not switch off two-factor authentication.',
    reference: input.reference,
  })
}

export async function sendCompanyInvitation(input: {
  to: string
  toName: string | null
  companyName: string
  inviterName: string
  role: string
  token: string
  companyId: string
  reference: string
}): Promise<SendOutcome> {
  return sendTransactional({
    to: input.to,
    toName: input.toName,
    kind: 'company_invitation',
    subject: `${input.inviterName} invited you to ${input.companyName}`,
    body: [
      input.toName ? `Hello ${input.toName},` : 'Hello,',
      `${input.inviterName} has invited you to work on ${input.companyName}’s books as ${input.role}.`,
      'You will choose your own password — nobody else has set one for you, and nobody else knows it.',
    ],
    action: { label: 'Accept the invitation', url: invitationUrl(input.token) },
    footnote:
      'This link works once and expires in a week. If you were not expecting it, ignore it — ' +
      'nothing happens until you accept.',
    companyId: input.companyId,
    reference: input.reference,
  })
}

export async function sendPracticeInvitation(input: {
  to: string
  toName: string | null
  practiceName: string
  inviterName: string
  token: string
  reference: string
}): Promise<SendOutcome> {
  return sendTransactional({
    to: input.to,
    toName: input.toName,
    kind: 'practice_invitation',
    subject: `${input.inviterName} invited you to ${input.practiceName}`,
    body: [
      input.toName ? `Hello ${input.toName},` : 'Hello,',
      `${input.inviterName} has invited you to join ${input.practiceName} on Accountrix Plus.`,
      'You will choose your own password. You will be able to work on the books of every client ' +
        'the practice acts for, within whatever each of them has agreed to.',
    ],
    action: { label: 'Accept the invitation', url: invitationUrl(input.token) },
    footnote: 'This link works once and expires in a week.',
    reference: input.reference,
  })
}

/**
 * Transactional mail that failed to arrive.
 *
 * Surfaced rather than suppressed. A campaign that bounces means stop mailing
 * that address; a password reset that bounces means somebody is locked out of
 * their books and nobody has noticed.
 */
export async function failedDeliveries(
  companyId: string,
  limit = 20,
  exec: Executor = db,
  /**
   * Only failures since this instant (Phase 24).
   *
   * The daily digest needs a window or it reports the same bounce every
   * morning for ever. Omitted by the screen, which wants all of them.
   */
  since?: Date,
) {
  return exec
    .select({
      id: transactionalMessages.id,
      kind: transactionalMessages.kind,
      email: transactionalMessages.email,
      subject: transactionalMessages.subject,
      error: transactionalMessages.error,
      createdAt: transactionalMessages.createdAt,
    })
    .from(transactionalMessages)
    .where(
      and(
        eq(transactionalMessages.companyId, companyId),
        eq(transactionalMessages.outcome, 'failed'),
        since ? gte(transactionalMessages.createdAt, since) : undefined,
      ),
    )
    .orderBy(desc(transactionalMessages.createdAt))
    .limit(limit)
}
