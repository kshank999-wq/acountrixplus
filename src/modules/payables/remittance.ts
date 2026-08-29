/**
 * Telling a supplier what a payment was for (spec §13, §19).
 *
 * ## The gap this closes
 *
 * Phase 49 built pay runs: a business can select seven bills, deduct a vendor
 * credit, and send one payment. What the **supplier** then receives is a single
 * credit on their bank statement, for an amount that matches none of their
 * invoices, with no indication of which ones it covers.
 *
 * The consequences are all borne by the payer:
 *
 * - The supplier cannot apply the payment, so **their** aging report still
 *   shows the invoices as open — and their chase run emails a demand for money
 *   that was paid a fortnight ago.
 * - Somebody at the supplier rings up and asks what the payment was for, and
 *   somebody at the business has to go and work it out from the pay run.
 * - When a vendor credit was deducted, the figure matches nothing at all, and
 *   the supplier's first assumption is a short payment rather than a credit
 *   they issued.
 *
 * A remittance advice is the oldest courtesy in accounts payable and every
 * package sends one. This one had a pay run, a transactional email channel
 * (Phase 19), a share-token pattern (Phase 42) and a public document page
 * (Phase 55) — and no remittance.
 *
 * ## Why this needs no freezing, unlike a statement
 *
 * Phase 55 froze a statement's figures because a statement is a claim about a
 * **moment**, and the books move underneath it. A remittance is a claim about a
 * **payment**, and a posted payment does not change: its applications are
 * written once and the amount is what left the bank.
 *
 * So the page renders live and is stable anyway — no snapshot, no second copy
 * of figures to keep in step.
 *
 * **With one exception, and it is the important one.** Phase 52 made a payment
 * voidable. A supplier holding a remittance for a payment that was later voided
 * is holding a document about money they did not receive, and the page has to
 * say so rather than keep describing a payment that has been unwound. That is
 * the case a stored snapshot would have got wrong.
 *
 * Nothing here touches the database or the clock.
 */

import { formatCents } from '@/lib/money'

/** A payment row, as much of it as this module is willing to look at. */
export type PaymentFacts = {
  kind: 'receipt' | 'disbursement'
  status: string
  paymentDate: string
  amountCents: number
  currency: string
  reference: string | null
  /** Phase 52. A voided payment is money the supplier did not receive. */
  voidedAt: Date | null
  voidReason: string | null
}

/** One bill the payment settled. */
export type SettledBillFacts = {
  /** The supplier's own reference, which is what they will look for (Phase 47). */
  vendorReference: string | null
  /** Our number for it, so a phone call has something in common. */
  number: string
  issueDate: string
  dueDate: string
  /** What this payment put against that bill. */
  amountCents: number
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
export type SupplierFacingRemittance = {
  paymentDate: string
  currency: string
  /** What actually left the bank. */
  amountCents: number
  /** What the listed bills come to. Equal to `amountCents` unless something is off. */
  appliedCents: number
  /**
   * Paid but not against any bill on this advice.
   *
   * Never negative. A positive figure here is worth showing rather than hiding:
   * it is usually a payment on account, and the supplier needs to know it is
   * theirs to allocate.
   */
  unappliedCents: number
  reference: string | null
  supplierName: string
  company: CompanyFacts
  bills: SettledBillFacts[]
  /**
   * True when the payment was voided after this advice was sent (Phase 52).
   *
   * The page leads with it. A supplier reading a remittance for money that came
   * back is the one case where a document about a payment can go stale.
   */
  isVoided: boolean
  voidReason: string | null
}

export function supplierFacingRemittance(input: {
  payment: PaymentFacts
  bills: SettledBillFacts[]
  supplier: PartyFacts
  company: CompanyFacts
}): SupplierFacingRemittance {
  const { payment } = input
  const appliedCents = input.bills.reduce((sum, bill) => sum + bill.amountCents, 0)

  return {
    paymentDate: payment.paymentDate,
    currency: payment.currency,
    amountCents: payment.amountCents,
    appliedCents,
    unappliedCents: Math.max(0, payment.amountCents - appliedCents),
    reference: payment.reference,
    supplierName: input.supplier.name,
    company: input.company,
    bills: input.bills.map((bill) => ({
      vendorReference: bill.vendorReference,
      number: bill.number,
      issueDate: bill.issueDate,
      dueDate: bill.dueDate,
      amountCents: bill.amountCents,
    })),
    isVoided: payment.status === 'void' || payment.voidedAt !== null,
    voidReason: payment.voidReason,
  }
}

export type Sendability =
  | { ok: true; to: string; isResend: boolean }
  | { ok: false; reason: string }

/**
 * Whether a remittance can be sent, and if not, the sentence to show.
 *
 * Refusals rather than silent no-ops, for the reason Phase 42 gave: a Send that
 * appears to work and does nothing leaves the business believing the supplier
 * was told.
 */
export function sendability(input: {
  payment: Pick<PaymentFacts, 'kind' | 'status' | 'amountCents' | 'voidedAt'>
  supplier: PartyFacts | null
  sendCount: number
  /** An address typed into the send form, which overrides the one on file. */
  override?: string | null
}): Sendability {
  const { payment } = input

  /**
   * A receipt is money coming *in*. The document that belongs to it is a
   * receipt to the customer, not a remittance — and sending a customer a
   * remittance would tell them the business had paid *them*.
   */
  if (payment.kind !== 'disbursement') {
    return {
      ok: false,
      reason:
        'A remittance advice is for money you paid out. This is money received — ' +
        'the customer’s copy is their invoice or their statement.',
    }
  }

  if (payment.status === 'void' || payment.voidedAt !== null) {
    return {
      ok: false,
      reason:
        'This payment has been voided, so there is nothing to advise. If the supplier ' +
        'already has an advice for it, tell them it was reversed — the link they hold says so.',
    }
  }

  if (payment.amountCents <= 0) {
    return { ok: false, reason: 'There is nothing on this payment to advise.' }
  }

  if (!input.supplier) {
    return {
      ok: false,
      reason:
        'This payment does not name a supplier, so there is nobody to send it to. ' +
        'Put it against a supplier first.',
    }
  }

  const address = (input.override ?? input.supplier.email ?? '').trim()
  if (!address) {
    return {
      ok: false,
      reason:
        `${input.supplier.name} has no email address on file. ` +
        'Add one against the supplier, then send it — or use Get link and send the link yourself.',
    }
  }

  // Deliberately permissive, as ADR 0038 decided: the provider is the authority
  // on deliverability, and a regular expression that thinks it knows better
  // refuses real addresses.
  if (!address.includes('@') || address.startsWith('@') || address.endsWith('@')) {
    return { ok: false, reason: `“${address}” is not an email address.` }
  }

  return { ok: true, to: address, isResend: input.sendCount > 0 }
}

/**
 * What to say in the subject line.
 *
 * Leads with the company's name and the amount, because this arrives in an
 * accounts-receivable inbox that receives hundreds of these and the person
 * filing it is matching it to a bank credit.
 */
export function remittanceSubject(input: {
  companyName: string
  amount: string
  isResend: boolean
}): string {
  return input.isResend
    ? `Remittance advice from ${input.companyName} — ${input.amount} (resent)`
    : `Remittance advice from ${input.companyName} — ${input.amount}`
}

/** The one line the email leads with. */
export function remittanceSummaryLine(input: {
  remittance: Pick<
    SupplierFacingRemittance,
    'amountCents' | 'currency' | 'bills' | 'paymentDate' | 'unappliedCents'
  >
  companyName: string
}): string {
  const { remittance } = input
  const amount = formatCents(remittance.amountCents, remittance.currency)
  const count = remittance.bills.length

  const against =
    count === 0
      ? 'on account'
      : `against ${count} ${count === 1 ? 'invoice' : 'invoices'}`

  const leftover =
    remittance.unappliedCents > 0 && count > 0
      ? ` ${formatCents(remittance.unappliedCents, remittance.currency)} of it is on account.`
      : ''

  return (
    `${input.companyName} has paid you ${amount} on ${remittance.paymentDate}, ${against}.` +
    leftover
  )
}
