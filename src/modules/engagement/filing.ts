import type { TransactionalKind } from '@/modules/notify/transactional'

/**
 * Whose record a letter belongs on (Phase 93).
 *
 * ## The letter filed against nobody
 *
 * `recordOutboundMail` files a sent letter on a timeline by looking its address
 * up in **`contacts`** — the CRM's people. That was right for Phase 22, whose
 * letters were invitations and password resets, which go to people somebody in
 * the CRM had already met.
 *
 * It is wrong for the letters this application mostly sends. An invoice goes to
 * whatever address is on the `customers` row, and a business that bills people
 * it never courted has no CRM contact for any of them. On this repository's own
 * seed data, **none of the five customers with an email address matches a
 * contact** — so every invoice, every statement and every reminder is recorded
 * in `transactional_messages` and appears on nobody's timeline at all.
 *
 * Phase 91 kept the words and Phase 92 taught the timeline to read them. Neither
 * helps a letter that never gets an entry.
 *
 * ## The judgement: an address is not an identity
 *
 * One inbox can be three parties at once. `accounts@harborview.test` is
 * plausibly a contact somebody met at a trade show, a customer who owes money,
 * *and* a supplier who invoices for plant hire — a firm that both buys from you
 * and sells to you, with one shared address for all of it.
 *
 * So resolving an address gives a set of candidates, not an answer, and picking
 * by a fixed precedence would file a **remittance advice on a customer's
 * record**: evidence about a payables relationship stored against a receivables
 * one, where the next person to open that customer reads it as something we sent
 * them about their own debt.
 *
 * **What the letter is says which party it is about.** A remittance is a
 * payables document and belongs to the supplier; an invoice or a statement to
 * the customer; an invitation or a reset to the person. `KIND_CONCERNS` writes
 * that down exhaustively, so the next `TransactionalKind` has to choose rather
 * than inherit.
 *
 * ## The fallback never crosses the divide
 *
 * When the party a letter concerns is not among the matches, it falls back to a
 * **contact** and to nothing else. A contact is a person rather than a side of
 * the books, so filing there cannot put a payables letter on a receivables
 * record. Falling back from vendor to customer would do exactly the harm this
 * module exists to prevent, and is refused.
 *
 * Nothing here touches the database or the clock.
 */

/** The kinds of party this application can file a letter against. */
export type PartyKind = 'contact' | 'customer' | 'vendor'

export type Party = {
  kind: PartyKind
  id: string
  /** The CRM record this party is linked to, when it is linked to one. */
  organizationId: string | null
}

/**
 * Which party each letter is about.
 *
 * Listed exhaustively rather than defaulted: the choice is not obvious for every
 * kind, and a default would make the next one silently inherit somebody else's
 * answer.
 */
export const KIND_CONCERNS: Record<TransactionalKind, PartyKind> = {
  /** Money owed to us. The customer's record. */
  invoice: 'customer',
  statement: 'customer',
  /**
   * Money we have paid out. The supplier's record — and the whole reason this
   * module cannot simply prefer customers: an address that is both would file
   * our own payment advice against somebody's debt to us.
   */
  remittance: 'vendor',
  /**
   * About a person rather than a trading relationship. Somebody's password,
   * somebody's invitation, somebody's sign-in.
   */
  password_reset: 'contact',
  company_invitation: 'contact',
  practice_invitation: 'contact',
  security_alert: 'contact',
  /**
   * A letter to a person about their own account, not to a side of the books
   * (Phase 98). The same answer `password_reset` gives, for the same reason.
   */
  email_change: 'contact',
  /**
   * A firm's own morning post. It has no company behind it at all, so it never
   * reaches this module — `recordOutboundMail` runs only when there is a
   * company. Listed so the record stays exhaustive.
   */
  practice_brief: 'contact',
}

/**
 * The one party a letter belongs to, or null when there is no honest answer.
 *
 * Null in three situations, all of which mean "file nothing" rather than "file
 * somewhere":
 *
 * - nothing matched the address, which is the ordinary case for a letter to a
 *   stranger and not a failure;
 * - the kind's party is absent and there is no contact to fall back to;
 * - **the answer is ambiguous** — two customers share an address, so filing on
 *   one of them is a coin flip. An entry on the wrong customer is evidence about
 *   the wrong party, and a timeline that is quietly wrong is worse than one that
 *   is quietly short. The duplicate is a data problem to fix, not a tie to break
 *   here.
 */
export function filingFor(kind: TransactionalKind, matches: Party[]): Party | null {
  const concerns = KIND_CONCERNS[kind]

  const preferred = only(matches, concerns)
  if (preferred !== undefined) return preferred

  // The party this letter is about is not here. A contact is a person rather
  // than a side of the books, so this is the one fallback that cannot file a
  // payables letter against a receivables record.
  if (concerns === 'contact') return null

  return only(matches, 'contact') ?? null
}

/**
 * The single match of one kind.
 *
 * `undefined` when there is none, `null` when there are several — the caller
 * distinguishes them because "look elsewhere" and "refuse to guess" are
 * different answers.
 */
function only(matches: Party[], kind: PartyKind): Party | null | undefined {
  const of = matches.filter((party) => party.kind === kind)
  if (of.length === 0) return undefined
  if (of.length > 1) return null
  return of[0]
}

/**
 * The columns a communications row carries for one party.
 *
 * The organization comes along whenever the party has one, so a letter filed
 * against a customer who *is* a CRM client still appears on that client's
 * timeline — which is where somebody who has both will look first.
 */
export function columnsFor(party: Party | null): {
  organizationId: string | null
  contactId: string | null
  customerId: string | null
  vendorId: string | null
} {
  return {
    organizationId: party?.organizationId ?? null,
    contactId: party?.kind === 'contact' ? party.id : null,
    customerId: party?.kind === 'customer' ? party.id : null,
    vendorId: party?.kind === 'vendor' ? party.id : null,
  }
}
