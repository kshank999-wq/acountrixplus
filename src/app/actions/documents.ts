'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
  voidDocument,
  DocumentError,
} from '@/modules/receivables/service'
import { openDocumentsFor, type PaymentSide } from '@/modules/receivables/open-documents'
import { revokeShareLink, sendInvoice, shareLinkFor } from '@/modules/receivables/send'
import { allocate } from '@/modules/receivables/allocation'
import { DomainError, messageFor } from '@/modules/errors'
import { formatCents, parseAmountToCents } from '@/lib/money'

/**
 * Raising the documents a business actually raises (spec §3, §13).
 *
 * ## Why this file exists
 *
 * `createInvoice`, `createBill`, `recordPayment`, `createCustomer` and
 * `createVendor` have been written, posted and tested since Phase 2 — and
 * until now **not one of them was reachable from a screen**. Every invoice in
 * the system arrived as a by-product of something else: a won opportunity, a
 * completed appointment, a repair order, a rent schedule, a progress claim.
 *
 * So the application could age a receivable, chase it, credit it, write it
 * off, recover the write-off, print it and put it on a statement — for
 * invoices a business had no way to create. Nothing here is new accounting.
 * It is a door onto rooms that were already built.
 */

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  /**
   * `overridable` is set when the refusal was a *resemblance* rather than a
   * certainty (Phase 47) — a bill that looks like one already entered, which
   * only the person holding the invoice can settle. Absent everywhere else,
   * including on a repeated supplier reference, which is not overridable.
   */
  | { ok: false; error: string; overridable?: true }

const PATHS = [
  '/accounting',
  '/accounting/receivables',
  '/accounting/reports',
  '/accounting/journal',
  '/accounting/deposits',
  '/crm',
]

async function run<T>(fn: () => Promise<{ message?: string; data?: T }>): Promise<ActionResult<T>> {
  try {
    const { message, data } = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message, data }
  } catch (error) {
    const message = messageFor(error, 'Something went wrong.')

    // A resemblance is a question for a person; everything else is an answer
    // (Phase 47). The flag comes off the error rather than out of the sentence,
    // so a screen offering "do it anyway" and the rule deciding what may be
    // done anyway cannot drift apart.
    if (error instanceof DocumentError && error.overridable) {
      return { ok: false, error: message, overridable: true }
    }

    return { ok: false, error: message }
  }
}

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31.')

/**
 * An amount as somebody types it.
 *
 * Parsed here rather than in the browser so "1,234.50", "1234.5" and "£1234.50"
 * all mean the same thing and the number that reaches the ledger is an integer
 * of cents — never a float that has been through a text field.
 */
const money = z
  .string()
  .trim()
  .min(1, 'Enter an amount.')
  .transform((raw, ctx) => {
    const cents = parseAmountToCents(raw)
    if (cents === null) {
      ctx.addIssue({ code: 'custom', message: `“${raw}” is not an amount.` })
      return z.NEVER
    }
    return cents
  })

/** Thousandths, so 1.5 hours is 1500. Blank means one unit. */
const quantity = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx) => {
    if (!raw) return 1000
    const parsed = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.addIssue({ code: 'custom', message: `“${raw}” is not a quantity.` })
      return z.NEVER
    }
    return Math.round(parsed * 1000)
  })

const lineSchema = z.object({
  chartAccountId: uuid,
  description: z.string().trim().min(1, 'Every line needs a description.'),
  quantity,
  unitPrice: money,
})

// --- Parties ---------------------------------------------------------------

const partySchema = z.object({
  name: z.string().trim().min(1, 'Give them a name.'),
  email: z.string().trim().email('That is not an email address.').optional().or(z.literal('')),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  /**
   * Add them under a name already on the books (Phase 47).
   *
   * There is more than one "Smith & Sons", so this is a question rather than a
   * rule — but a second record for one supplier splits their balance and their
   * aging in two, and blinds the duplicate-bill check, which is keyed on the
   * vendor. Browser verification found the demo offering one supplier twice.
   */
  allowNamesake: z.boolean().optional(),
})

export async function createCustomerAction(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = partySchema.parse(input)

    const customer = await createCustomer(actor, {
      name: parsed.name,
      email: parsed.email || undefined,
      paymentTermsDays: parsed.paymentTermsDays,
      allowNamesake: parsed.allowNamesake,
    })

    return {
      message:
        `${customer.name} added, on ${customer.paymentTermsDays}-day terms. ` +
        'Add their address under Customers & suppliers — it prints on the invoice.',
      data: { id: customer.id, name: customer.name },
    }
  })
}

export async function createVendorAction(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = partySchema.parse(input)

    const vendor = await createVendor(actor, {
      name: parsed.name,
      email: parsed.email || undefined,
      paymentTermsDays: parsed.paymentTermsDays,
      allowNamesake: parsed.allowNamesake,
    })

    return {
      message:
        `${vendor.name} added, on ${vendor.paymentTermsDays}-day terms. ` +
        'Their address and tax details are under Customers & suppliers.',
      data: { id: vendor.id, name: vendor.name },
    }
  })
}

// --- Documents -------------------------------------------------------------

const documentSchema = z.object({
  partyId: uuid,
  issueDate: isoDate,
  dueDate: isoDate.optional().or(z.literal('')),
  number: z.string().trim().optional(),
  memo: z.string().trim().optional(),
  tax: money.optional().or(z.literal('').transform(() => 0)),
  lines: z.array(lineSchema).min(1, 'An invoice needs at least one line.'),
})

const billSchema = documentSchema.extend({
  /**
   * The number printed on the supplier's invoice (Phase 47).
   *
   * A separate field from `number`, which is ours. They were the same field
   * until this phase: the composer wrote the supplier's reference into a column
   * unique per *company*, so two suppliers both using INV-4471 could not both
   * be entered — and the same supplier's invoice keyed twice was only caught
   * when somebody happened to type the reference both times.
   */
  vendorReference: z.string().trim().optional(),
  /** Enter it anyway, having read what it resembles. Never overrides a refusal. */
  acknowledgeDuplicate: z.boolean().optional(),
})

export async function createInvoiceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = documentSchema.parse(input)

    const invoice = await createInvoice(actor, {
      customerId: parsed.partyId,
      number: parsed.number || undefined,
      issueDate: parsed.issueDate,
      dueDate: parsed.dueDate || undefined,
      memo: parsed.memo || undefined,
      taxCents: parsed.tax || 0,
      lines: parsed.lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        description: line.description,
        quantityMilli: line.quantity,
        unitPriceCents: line.unitPrice,
      })),
    })

    return {
      message:
        `Invoice ${invoice.number} raised for ${formatCents(invoice.totalCents)}, ` +
        `due ${invoice.dueDate}. It is on the ledger and on the aging report.`,
    }
  })
}

export async function createBillAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = billSchema.parse(input)

    const bill = await createBill(actor, {
      vendorId: parsed.partyId,
      // Deliberately not `parsed.number`. Our number is ours and is always
      // generated; what the composer collects is the supplier's.
      vendorReference: parsed.vendorReference || undefined,
      acknowledgeDuplicate: parsed.acknowledgeDuplicate,
      issueDate: parsed.issueDate,
      dueDate: parsed.dueDate || undefined,
      memo: parsed.memo || undefined,
      taxCents: parsed.tax || 0,
      lines: parsed.lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        description: line.description,
        quantityMilli: line.quantity,
        unitPriceCents: line.unitPrice,
      })),
    })

    const theirs = bill.vendorReference ? ` (their ${bill.vendorReference})` : ''

    return {
      message:
        `Bill ${bill.number}${theirs} entered for ${formatCents(bill.totalCents)}, ` +
        `due ${bill.dueDate}.`,
    }
  })
}

export async function voidDocumentAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = z.object({ kind: z.enum(['invoice', 'bill']), id: uuid }).parse(input)

    await voidDocument(actor, parsed.kind, parsed.id)

    return {
      message:
        'Voided. The entry it posted was reversed rather than deleted — the number stays, ' +
        'so an auditor is never looking at a gap.',
    }
  })
}

// --- Payments --------------------------------------------------------------

const paymentSchema = z.object({
  kind: z.enum(['receipt', 'disbursement']),
  partyId: uuid,
  paymentDate: isoDate,
  amount: money,
  /** Omitted on a receipt, the money waits in Undeposited Funds. */
  financialAccountId: uuid.optional().or(z.literal('')),
  /** Named explicitly when somebody knows which document the money is for. */
  documentIds: z.array(uuid).optional(),
  reference: z.string().trim().optional(),
})

/**
 * Records a payment and works out what it settles.
 *
 * The allocation is decided here rather than asked for, because most of the
 * time nobody has said: a customer sends a round figure against three open
 * invoices. `recordPayment` requires applications summing exactly to the
 * amount, so an overpayment cannot be quietly recorded — it is refused with
 * the reason, which is the honest answer to "this is more than they owe".
 */
export async function recordPaymentAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = paymentSchema.parse(input)

    const side: PaymentSide = parsed.kind === 'receipt' ? 'customer' : 'vendor'
    const open = await openDocumentsFor(actor, side, parsed.partyId)

    // A named document means somebody has said where the money goes, so the
    // order they gave is the order it is applied in.
    const chosen = parsed.documentIds?.length
      ? parsed.documentIds
          .map((id) => open.find((document) => document.id === id))
          .filter((document): document is (typeof open)[number] => document !== undefined)
      : open

    const allocation = allocate(parsed.amount, chosen, {
      respectOrder: Boolean(parsed.documentIds?.length),
    })

    /**
     * A receipt bigger than what is owed is **held**, not refused (Phase 53).
     *
     * This used to say *"reduce it to $7,400"* — asking somebody to record a
     * figure the bank statement disagrees with, and leaving the reconciliation
     * out for ever. `recordPayment` now decides through `splitReceipt` whether
     * the leftover may be held, so the only refusal left here is the one about
     * paying suppliers, which that function makes with a better sentence.
     *
     * A *disbursement* that applies to nothing is still refused, because
     * money leaving against no bill is a bank withdrawal, not a payment.
     */
    if (allocation.applications.length === 0 && parsed.kind === 'disbursement') {
      throw new DomainError(
        open.length === 0
          ? 'There is nothing outstanding to apply this to. Enter the bill first — a supplier payment cannot be recorded against nothing.'
          : 'That payment could not be applied to any of the open bills.',
      )
    }

    await recordPayment(actor, {
      kind: parsed.kind,
      customerId: parsed.kind === 'receipt' ? parsed.partyId : undefined,
      vendorId: parsed.kind === 'disbursement' ? parsed.partyId : undefined,
      paymentDate: parsed.paymentDate,
      amountCents: parsed.amount,
      financialAccountId: parsed.financialAccountId || undefined,
      reference: parsed.reference || undefined,
      applications: allocation.applications.map((application) => ({
        invoiceId: parsed.kind === 'receipt' ? application.documentId : undefined,
        billId: parsed.kind === 'disbursement' ? application.documentId : undefined,
        amountCents: application.amountCents,
      })),
    })

    const settled = allocation.applications
      .map((application) => `${application.number} ${formatCents(application.amountCents)}`)
      .join(', ')

    const held =
      parsed.kind === 'receipt' && !parsed.financialAccountId
        ? ' Held in Undeposited Funds until you bank it.'
        : ''

    // What was sent beyond what was owed, named on the way past rather than
    // left to be discovered on a balance sheet (Phase 53).
    const over =
      allocation.unappliedCents > 0
        ? ` ${formatCents(allocation.unappliedCents)} more than was owed is held as credit for them.`
        : ''

    return {
      message: settled
        ? `${formatCents(parsed.amount)} against ${settled}.${held}${over}`
        : `${formatCents(parsed.amount)} received.${held}${over}`,
    }
  })
}

// --- Getting it to the customer (Phase 42) ---------------------------------

const sendSchema = z.object({
  invoiceId: uuid,
  /** Overrides the address on file, for a one-off. */
  to: z.string().trim().optional(),
})

/**
 * Sends an invoice, and says plainly whether it left.
 *
 * A failed delivery is reported as a failure rather than swallowed: the whole
 * point of the action is that somebody now believes the customer has been
 * asked for the money, and they should only believe it if it is true.
 */
export async function sendInvoiceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = sendSchema.parse(input)

    const result = await sendInvoice(actor, parsed.invoiceId, { to: parsed.to || null })

    if (!result.delivered) {
      throw new DomainError(
        `The link is ready but the email did not go: ${result.error ?? 'the provider refused it'}. ` +
          'Copy the link and send it yourself, or check the address and try again.',
      )
    }

    return {
      message:
        `${result.isReminder ? 'Reminder sent' : 'Sent'} to ${result.to}. ` +
        'They see what is currently outstanding, so it stays right after a part payment.',
    }
  })
}

export async function shareInvoiceAction(input: unknown): Promise<ActionResult<{ url: string }>> {
  return run(async () => {
    const actor = await requireActor()
    const { invoiceId } = z.object({ invoiceId: uuid }).parse(input)

    const url = await shareLinkFor(actor, invoiceId)
    // The URL goes in the message as well as the data, because a "link ready"
    // notice with no link in it is the whole feature missing.
    return {
      message: `Anybody with this link can see the invoice:\n${url}`,
      data: { url },
    }
  })
}

export async function revokeInvoiceLinkAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const { invoiceId } = z.object({ invoiceId: uuid }).parse(input)

    await revokeShareLink(actor, invoiceId)
    return {
      message:
        'That link no longer works. The invoice is untouched — sending it again makes a new one.',
    }
  })
}
