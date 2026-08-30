import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { companies, companyProfiles, customerStatements, customers } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { letterheadFor } from '@/modules/brand/letterhead'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { DomainError } from '@/modules/errors'
import { formatCents } from '@/lib/money'
import { sendStatementEmail } from '@/modules/notify/service'
import { appBaseUrl } from '@/modules/notify/transactional'
import { logCommunication } from '@/modules/engagement/communications'
import {
  customerFacingStatement,
  sendability,
  statementSummaryLine,
  type CustomerFacingStatement,
  type StatementLineFacts,
} from './statement-sharing'

/**
 * Getting a statement to the customer it is about (spec §13, §19).
 *
 * ## What was wrong
 *
 * Phase 11 built statements: two kinds, the figures frozen at save time, and a
 * `sent_at` column so the business could answer "what did we send them, and
 * when". **Nothing ever wrote to `sent_at`.** There was no send.
 *
 * `sent_to` was worse. `saveStatement` filled it in with the customer's address
 * at *save* time, so the screen showed a statement, a date, and an email
 * address — and a business reading that row would reasonably conclude the
 * customer had been told. On the demo books, five statements were saved, four
 * carried an address, and none of them had ever gone anywhere.
 *
 * Phase 54 then computed the netted position and froze a sentence onto the row
 * addressed to a customer with no way of reading it.
 *
 * ## The send happens before the record is trusted, not after
 *
 * Phase 42 set the order and it holds here: the token is minted and the counter
 * moves **first**, then the message goes. A message that leaves and is not
 * recorded is worse than one recorded and not sent — the first leaves a
 * customer holding a document the business does not know it sent, and the
 * second shows up in the delivery log as a failure somebody can act on.
 */

export class SendStatementError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'SendStatementError'
  }
}

/**
 * 32 bytes of randomness, url-safe.
 *
 * Long for the reason Phase 42 gave: it is the *only* thing protecting the
 * document, there is no second factor on the public route, and a token
 * somebody can walk is a customer list.
 */
function mintShareToken(): string {
  return randomBytes(24).toString('base64url')
}

export type StatementSendResult = {
  to: string
  isResend: boolean
  url: string
  delivered: boolean
  /** The provider's own words when it refused. Null when it took the message. */
  error: string | null
}

import type { CurrencyPosition } from './settlement-currency'

/** The shape `figures` is written in by `saveStatement`. */
type FrozenFigures = {
  lines?: StatementLineFacts[]
  heldCreditCents?: number
  dueCents?: number
  ourDebtCents?: number
  positionNote?: string | null
  /** Per currency, since Phase 62. Absent on anything frozen before it. */
  positions?: CurrencyPosition[]
}

async function loadStatement(ctx: ActorContext, statementId: string) {
  const [row] = await db
    .select({
      statement: customerStatements,
      customer: customers,
      company: companies,
      profile: companyProfiles,
    })
    .from(customerStatements)
    .innerJoin(customers, eq(customers.id, customerStatements.customerId))
    .innerJoin(companies, eq(companies.id, customerStatements.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, customerStatements.companyId))
    .where(scoped(ctx, customerStatements, eq(customerStatements.id, statementId)))
    .limit(1)

  if (!row) throw new SendStatementError('That statement is not on these books.')
  return row
}

/** The projection the page and the email both read from. */
function viewOf(row: Awaited<ReturnType<typeof loadStatement>>): CustomerFacingStatement {
  const figures = (row.statement.figures ?? {}) as FrozenFigures
  const head = letterheadFor({ companyName: row.company.name, profile: row.profile })

  return customerFacingStatement({
    statement: {
      kind: row.statement.kind,
      periodStart: row.statement.periodStart,
      asOfDate: row.statement.asOfDate,
      openingBalanceCents: row.statement.openingBalanceCents,
      closingBalanceCents: row.statement.closingBalanceCents,
      heldCreditCents: figures.heldCreditCents,
      dueCents: figures.dueCents,
      positionNote: figures.positionNote,
      positions: figures.positions,
      sentAt: row.statement.sentAt,
      sendCount: row.statement.sendCount,
    },
    lines: figures.lines ?? [],
    customer: { name: row.customer.name, email: row.customer.email },
    company: {
      ...head,
    },
    currency: row.company.currency,
  })
}

/**
 * Sends a statement, or says why it cannot.
 *
 * Gated on `accounting:view` rather than `accounting:journal`, unlike sending
 * an invoice. Sending an invoice asks somebody for money and can only follow
 * raising one; a statement asserts nothing new — every figure on it was frozen
 * when it was saved, and saving already required this permission. Requiring
 * more to post a letter than to compose it would put the gate in the wrong
 * place.
 */
export async function sendStatement(
  ctx: ActorContext,
  statementId: string,
  opts: { to?: string | null } = {},
): Promise<StatementSendResult> {
  requirePermission(ctx, 'accounting:view')

  const row = await loadStatement(ctx, statementId)
  const figures = (row.statement.figures ?? {}) as FrozenFigures

  const verdict = sendability({
    statement: {
      sentAt: row.statement.sentAt,
      sendCount: row.statement.sendCount,
      closingBalanceCents: row.statement.closingBalanceCents,
      heldCreditCents: figures.heldCreditCents,
    },
    customer: { name: row.customer.name, email: row.customer.email },
    override: opts.to,
  })

  if (!verdict.ok) throw new SendStatementError(verdict.reason)

  const token = row.statement.shareToken ?? mintShareToken()
  const view = viewOf(row)

  // Recorded first — see the module note on why this order and not the other.
  await db
    .update(customerStatements)
    .set({
      shareToken: token,
      sentAt: new Date(),
      sentTo: verdict.to,
      sendCount: sql`${customerStatements.sendCount} + 1`,
    })
    .where(scoped(ctx, customerStatements, eq(customerStatements.id, statementId)))

  const outcome = await sendStatementEmail({
    to: verdict.to,
    toName: row.customer.name,
    companyId: ctx.companyId,
    companyName: row.company.name,
    asOfDate: row.statement.asOfDate,
    summary: statementSummaryLine({ statement: view, companyName: row.company.name }),
    token,
    isResend: verdict.isResend,
    reference: `statement:${statementId}`,
  })

  // Filed on the customer's timeline when they are linked to a CRM record.
  // Many are not, and the transactional message row is the record in that case
  // — which is where Phase 24 already looks for failures.
  if (row.customer.organizationId) {
    await logCommunication(ctx, {
      organizationId: row.customer.organizationId,
      channel: 'email',
      direction: 'outbound',
      summary:
        `${verdict.isResend ? 'Resent' : 'Sent'} statement to ${row.statement.asOfDate} — ` +
        `${formatCents(view.dueCents, view.currency)} due`,
      body: `To ${verdict.to}.`,
      transactionalMessageId: outcome.ok ? outcome.messageId : null,
    }).catch(() => {
      // A timeline entry is a nicety; the statement has gone either way, and
      // failing the whole call over it would be the wrong trade.
    })
  }

  await recordAudit(ctx, {
    action: 'statement.send',
    entityType: 'customer_statement',
    entityId: statementId,
    after: {
      to: verdict.to,
      asOfDate: row.statement.asOfDate,
      isResend: verdict.isResend,
      delivered: outcome.ok,
    },
  })

  return {
    to: verdict.to,
    isResend: verdict.isResend,
    url: `${appBaseUrl()}/s/${token}`,
    delivered: outcome.ok,
    error: outcome.ok ? null : outcome.error,
  }
}

/**
 * Mints the link without sending anything.
 *
 * For the business that would rather paste it into their own email, and for the
 * customer with no address on file — which is what `sendability` tells them to
 * do. Same token the email would have used, so the two do not diverge.
 *
 * Deliberately does **not** touch `sentAt` or `sendCount`. Handing somebody a
 * link is not the same event as posting the letter, and recording it as one
 * would put back the lie this phase removed.
 */
export async function statementLinkFor(
  ctx: ActorContext,
  statementId: string,
): Promise<string> {
  requirePermission(ctx, 'accounting:view')

  const [statement] = await db
    .select({ id: customerStatements.id, shareToken: customerStatements.shareToken })
    .from(customerStatements)
    .where(scoped(ctx, customerStatements, eq(customerStatements.id, statementId)))
    .limit(1)

  if (!statement) throw new SendStatementError('That statement is not on these books.')
  if (statement.shareToken) return `${appBaseUrl()}/s/${statement.shareToken}`

  const token = mintShareToken()
  await db
    .update(customerStatements)
    .set({ shareToken: token })
    .where(scoped(ctx, customerStatements, eq(customerStatements.id, statementId)))

  return `${appBaseUrl()}/s/${token}`
}

/**
 * What the public page renders, looked up by token alone.
 *
 * No `ActorContext`: whoever holds the link is looking at it, and there is no
 * session. The token is the whole of the authorisation, which is why it is 32
 * bytes and why this returns the allowlisted projection rather than the row.
 */
export async function statementByToken(token: string): Promise<CustomerFacingStatement | null> {
  const trimmed = token.trim()
  if (!trimmed) return null

  const [row] = await db
    .select({
      statement: customerStatements,
      customer: customers,
      company: companies,
      profile: companyProfiles,
    })
    .from(customerStatements)
    .innerJoin(customers, eq(customers.id, customerStatements.customerId))
    .innerJoin(companies, eq(companies.id, customerStatements.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, customerStatements.companyId))
    .where(eq(customerStatements.shareToken, trimmed))
    .limit(1)

  return row ? viewOf(row) : null
}
