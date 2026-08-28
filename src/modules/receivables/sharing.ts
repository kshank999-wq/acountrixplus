/**
 * What a customer holding a link may see (spec §13, §19).
 *
 * ## Why a projection rather than "render the invoice"
 *
 * The page at `/i/[token]` is **unauthenticated**. Whoever has the link is
 * looking at it, and the link travels by email, gets forwarded, and sits in
 * inboxes for years. So the question is not "how do we display an invoice" but
 * "which fields may leave the building", and the two are different questions
 * that produce different code.
 *
 * `customerFacingInvoice` is therefore an **allowlist**, built field by field
 * from named inputs rather than by spreading a row and deleting the awkward
 * parts. A subtraction leaks by default: the next phase adds `internalNotes`
 * or `costCodeId` or `marginBp` to the invoice and it appears on a stranger's
 * screen because nobody remembered to remove it. An allowlist stays silent
 * instead, which is the failure that costs nothing.
 *
 * Nothing here touches the database or the clock.
 */

/** An invoice row, as much of it as this module is willing to look at. */
export type InvoiceFacts = {
  number: string
  issueDate: string
  dueDate: string
  status: string
  currency: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  balanceCents: number
  /** The note written *for the customer*. Not an internal memo. */
  memo: string | null
}

export type LineFacts = {
  description: string
  quantityMilli: number
  unitPriceCents: number
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
export type CustomerFacingInvoice = {
  number: string
  issueDate: string
  dueDate: string
  currency: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  /** What is still owed *now*. Moves as payments land — see the module note. */
  balanceCents: number
  paidCents: number
  isSettled: boolean
  isOverdue: boolean
  memo: string | null
  customerName: string
  company: CompanyFacts
  lines: LineFacts[]
}

/**
 * The customer's view of their invoice.
 *
 * Built from the live record on every request rather than from a stored copy.
 * `modules/pdf/invoice.ts` argued that case when invoice PDFs were built and
 * it still holds: a snapshot would be a second answer to *how much does this
 * customer owe*, and there is one ledger. The number they see moves as they
 * pay, which is the behaviour somebody chasing a balance actually wants.
 *
 * `asOf` decides only whether the thing reads as overdue, and is passed in so
 * this stays a function of its arguments.
 */
export function customerFacingInvoice(input: {
  invoice: InvoiceFacts
  lines: LineFacts[]
  customer: PartyFacts
  company: CompanyFacts
  asOf: string
}): CustomerFacingInvoice {
  const { invoice } = input
  const balanceCents = Math.max(0, invoice.balanceCents)

  return {
    number: invoice.number,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    balanceCents,
    paidCents: Math.max(0, invoice.totalCents - balanceCents),
    isSettled: balanceCents === 0,
    // Settled is never overdue, whatever the date says.
    isOverdue: balanceCents > 0 && invoice.dueDate < input.asOf,
    memo: invoice.memo,
    customerName: input.customer.name,
    company: input.company,
    lines: input.lines.map((line) => ({
      description: line.description,
      quantityMilli: line.quantityMilli,
      unitPriceCents: line.unitPriceCents,
      amountCents: line.amountCents,
    })),
  }
}

export type Sendability =
  | { ok: true; to: string }
  | { ok: false; reason: string }

/**
 * Whether an invoice can be sent, and if not, the sentence to show.
 *
 * Refusals rather than silent no-ops, because "Send" that appears to work and
 * does nothing is the worst outcome here: the business believes the customer
 * has been asked for the money.
 */
export function sendability(input: {
  invoice: Pick<InvoiceFacts, 'status' | 'totalCents' | 'balanceCents'>
  customer: PartyFacts
  /** An address typed into the send form, which overrides the one on file. */
  override?: string | null
}): Sendability {
  const { invoice } = input

  if (invoice.status === 'void') {
    return { ok: false, reason: 'This invoice has been voided. Raise a new one instead.' }
  }

  if (invoice.status === 'draft') {
    return { ok: false, reason: 'This invoice has not been raised yet.' }
  }

  if (invoice.totalCents <= 0) {
    return { ok: false, reason: 'There is nothing on this invoice to ask for.' }
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

  // Deliberately permissive. The provider is the authority on whether an
  // address is deliverable, and a regular expression that thinks it knows
  // better refuses real addresses — see ADR 0038 on where rejection belongs.
  if (!address.includes('@') || address.startsWith('@') || address.endsWith('@')) {
    return { ok: false, reason: `“${address}” is not an email address.` }
  }

  return { ok: true, to: address }
}

/**
 * What to say in the subject line.
 *
 * Kept here because it is the one string both the email and its record show,
 * and two copies of it drift.
 */
export function invoiceSubject(input: {
  companyName: string
  number: string
  isReminder: boolean
}): string {
  return input.isReminder
    ? `Reminder: invoice ${input.number} from ${input.companyName}`
    : `Invoice ${input.number} from ${input.companyName}`
}
