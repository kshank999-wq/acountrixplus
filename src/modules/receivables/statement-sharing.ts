/**
 * What a customer holding a statement link may see (spec §13, §19).
 *
 * ## The defect this closes
 *
 * `customer_statements` has carried a `sent_at` column since Phase 11 and
 * **nothing has ever written to it**. `sent_to` was worse than absent: it was
 * filled in at *save* time with the customer's address, so the screen showed a
 * statement, a date, and an email address it had never been sent to. A business
 * reading that column would believe the customer had been told.
 *
 * The module header on `statements.ts` has said since Phase 11 that "what did
 * we send them, and when" is the first question in any collections
 * conversation. It was the one question the data could not answer.
 *
 * Phase 54 then froze the held credit and the net position onto the row — a
 * sentence written for a customer who had no way of ever reading it.
 *
 * ## Frozen, deliberately unlike the invoice page
 *
 * Phase 42's `/i/[token]` renders the **live** invoice, and `sharing.ts` argues
 * that case well: a customer chasing their own payables wants to know what is
 * outstanding *now*, so a part payment does not require a reissue.
 *
 * A statement is the opposite kind of document, and copying Phase 42 here would
 * have quietly destroyed it. A statement is a claim about a **moment** — "this
 * is where we stood at 30 June" — and it exists so that two parties can
 * reconcile against a fixed thing. A page that silently restated itself every
 * time it was opened would mean the customer and the business could never be
 * looking at the same document, which is the only job a statement has.
 *
 * So this reads the figures frozen at save time, and says the date they were
 * frozen at. The live view already exists for anybody who wants it: it is the
 * invoice link.
 *
 * ## A projection, not a row
 *
 * The page at `/s/[token]` is **unauthenticated**, so the question is not "how
 * do we display a statement" but "which fields may leave the building".
 * `customerFacingStatement` is therefore an allowlist built field by field, for
 * the reason `sharing.ts` gave: a subtraction leaks by default, because the
 * next phase adds an internal note to the frozen figures and it appears on a
 * stranger's screen. An allowlist stays silent instead.
 *
 * Nothing here touches the database or the clock.
 */

import { formatCents } from '@/lib/money'

/** A statement row, as much of it as this module is willing to look at. */
export type StatementFacts = {
  kind: 'open_item' | 'balance_forward'
  periodStart: string | null
  asOfDate: string
  openingBalanceCents: number
  closingBalanceCents: number
  /** Phase 54's netting, frozen at save time. Absent on older rows. */
  heldCreditCents?: number
  dueCents?: number
  positionNote?: string | null
  sentAt: Date | null
  sendCount: number
}

export type StatementLineFacts = {
  date: string
  kind: string
  reference: string
  description: string
  amountCents: number
  runningBalanceCents: number
  dueDate?: string
  balanceCents?: number
}

export type PartyFacts = {
  name: string
  email: string | null
}

export type CompanyFacts = {
  name: string
  email: string | null
  phone: string | null
  addressLine: string | null
}

/** Exactly what the page and the email are allowed to say. */
export type CustomerFacingStatement = {
  kind: 'open_item' | 'balance_forward'
  periodStart: string | null
  asOfDate: string
  currency: string
  openingBalanceCents: number
  /** What was billed and still open at `asOfDate`, before credit is netted. */
  closingBalanceCents: number
  /** What the business was holding for them at `asOfDate` (Phase 54). */
  heldCreditCents: number
  /** What was actually due once that credit is netted off. Never below zero. */
  dueCents: number
  /** The sentence Phase 54 wrote, if this statement is new enough to have one. */
  positionNote: string | null
  customerName: string
  company: CompanyFacts
  lines: StatementLineFacts[]
  /**
   * Said out loud on the page, because the whole point of this document is
   * that it does *not* move. Somebody opening it in October needs to know they
   * are looking at June.
   */
  isFrozen: true
}

/**
 * The customer's view of their statement, built from the frozen figures.
 *
 * `heldCreditCents` and `dueCents` fall back to the gross when the row predates
 * Phase 54, which is what those statements meant when they were written.
 */
export function customerFacingStatement(input: {
  statement: StatementFacts
  lines: StatementLineFacts[]
  customer: PartyFacts
  company: CompanyFacts
  currency: string
}): CustomerFacingStatement {
  const { statement } = input
  const heldCreditCents = Math.max(0, statement.heldCreditCents ?? 0)

  return {
    kind: statement.kind,
    periodStart: statement.periodStart,
    asOfDate: statement.asOfDate,
    currency: input.currency,
    openingBalanceCents: statement.openingBalanceCents,
    closingBalanceCents: statement.closingBalanceCents,
    heldCreditCents,
    dueCents: statement.dueCents ?? Math.max(0, statement.closingBalanceCents),
    positionNote: statement.positionNote ?? null,
    customerName: input.customer.name,
    company: input.company,
    lines: input.lines.map((line) => ({
      date: line.date,
      kind: line.kind,
      reference: line.reference,
      description: line.description,
      amountCents: line.amountCents,
      runningBalanceCents: line.runningBalanceCents,
      dueDate: line.dueDate,
      balanceCents: line.balanceCents,
    })),
    isFrozen: true,
  }
}

export type Sendability =
  | { ok: true; to: string; isResend: boolean }
  | { ok: false; reason: string }

/**
 * Whether a statement can be sent, and if not, the sentence to show.
 *
 * Refusals rather than silent no-ops, for the reason Phase 42 gave: a "Send"
 * that appears to work and does nothing is the worst outcome, because the
 * business then believes the customer has been told.
 */
export function sendability(input: {
  statement: Pick<StatementFacts, 'sentAt' | 'sendCount' | 'closingBalanceCents' | 'heldCreditCents'>
  customer: PartyFacts
  /** An address typed into the send form, which overrides the one on file. */
  override?: string | null
}): Sendability {
  const { statement } = input

  /**
   * A statement of nothing is not sent.
   *
   * Deliberately checked against the whole position rather than the balance
   * alone: a customer who owes nothing but whose money the business is holding
   * has something to be told, and it is the more important half (Phase 54).
   */
  if (statement.closingBalanceCents === 0 && (statement.heldCreditCents ?? 0) === 0) {
    return {
      ok: false,
      reason:
        'There is nothing on this statement — no open invoices and no credit held. ' +
        'Save one for a date where something was outstanding.',
    }
  }

  const address = (input.override ?? input.customer.email ?? '').trim()
  if (!address) {
    return {
      ok: false,
      reason:
        `${input.customer.name} has no email address on file. ` +
        'Add one against the customer, then send it — or use Get link and send the link yourself.',
    }
  }

  // Deliberately permissive, as ADR 0038 decided: the provider is the authority
  // on whether an address is deliverable, and a regular expression that thinks
  // it knows better refuses real addresses.
  if (!address.includes('@') || address.startsWith('@') || address.endsWith('@')) {
    return { ok: false, reason: `“${address}” is not an email address.` }
  }

  return { ok: true, to: address, isResend: statement.sendCount > 0 || statement.sentAt !== null }
}

/**
 * What to say in the subject line.
 *
 * Kept here because it is the one string both the email and its record show,
 * and two copies of it drift.
 */
export function statementSubject(input: {
  companyName: string
  asOfDate: string
  isResend: boolean
}): string {
  return input.isResend
    ? `Statement to ${input.asOfDate} from ${input.companyName} (resent)`
    : `Statement to ${input.asOfDate} from ${input.companyName}`
}

/**
 * The one line the email leads with.
 *
 * Reads off the same netted position the statement itself shows, so the email
 * and the page cannot disagree — a customer who is told one figure in the
 * covering note and another on the page rings up, which is the outcome the
 * whole phase is trying to avoid.
 */
export function statementSummaryLine(input: {
  statement: Pick<CustomerFacingStatement, 'asOfDate' | 'dueCents' | 'heldCreditCents' | 'currency'>
  companyName: string
}): string {
  const { statement } = input
  const due = formatCents(statement.dueCents, statement.currency)

  if (statement.dueCents === 0) {
    return statement.heldCreditCents > 0
      ? `Your statement from ${input.companyName} to ${statement.asOfDate}. Nothing is due — ` +
          `we are holding ${formatCents(statement.heldCreditCents, statement.currency)} for you.`
      : `Your statement from ${input.companyName} to ${statement.asOfDate}. Nothing is due.`
  }

  return statement.heldCreditCents > 0
    ? `Your statement from ${input.companyName} to ${statement.asOfDate}: ${due} due, after the ` +
        `${formatCents(statement.heldCreditCents, statement.currency)} we are holding for you.`
    : `Your statement from ${input.companyName} to ${statement.asOfDate}: ${due} due.`
}
