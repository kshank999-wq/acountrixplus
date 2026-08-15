'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  applyCredit,
  createCreditNote,
  recoverWriteOff,
  writeOffInvoice,
} from '@/modules/receivables/credits'
import { saveStatement } from '@/modules/receivables/statements'
import {
  createRecurringEntry,
  runDueRecurringEntries,
  setRecurringActive,
} from '@/modules/ledger/recurring'
import { CloseBlockedError, closeFiscalYear, reopenFiscalYear } from '@/modules/ledger/closing'
import {
  createDeposit,
  voidDeposit,
  type DepositItemInput,
} from '@/modules/banking/deposits'
import { applyVendorCredit, createVendorCredit } from '@/modules/receivables/vendor-credits'
import { formatCents } from '@/lib/money'

/**
 * Server actions for the accounting core (Phase 11).
 *
 * Shape as everywhere else: resolve the actor, call one service, let the
 * service decide whether it is allowed.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATHS = [
  '/accounting',
  '/accounting/reports',
  '/accounting/receivables',
  '/accounting/journal',
  '/accounting/deposits',
]

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const path of PATHS) revalidatePath(path)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

const uuid = z.string().uuid()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-03-31.')

// --- Credits and write-offs ------------------------------------------------

const creditSchema = z.object({
  customerId: uuid,
  invoiceId: uuid.optional(),
  issueDate: isoDate,
  reason: z.string().trim().optional(),
  applyImmediately: z.boolean().optional(),
})

export async function createCreditNoteAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = creditSchema.parse(input)

    const note = await createCreditNote(actor, {
      customerId: parsed.customerId,
      invoiceId: parsed.invoiceId,
      issueDate: parsed.issueDate,
      reason: parsed.reason || undefined,
      applyImmediately: parsed.applyImmediately ?? false,
    })

    return `${note.number} issued. The revenue is reversed on the accounts it was booked to.`
  })
}

const applySchema = z.object({
  creditNoteId: uuid,
  invoiceId: uuid,
  amountCents: z.number().int().positive(),
  appliedOn: isoDate,
})

export async function applyCreditAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = applySchema.parse(input)

    const result = await applyCredit(actor, parsed)
    return `Applied. ${result.creditRemainingCents === 0 ? 'The credit is used up.' : 'Some credit is still available.'}`
  })
}

const writeOffSchema = z.object({
  invoiceId: uuid,
  writtenOffOn: isoDate,
  reason: z.string().trim().min(1, 'Say why it is being written off.'),
  amountCents: z.number().int().positive().optional(),
})

export async function writeOffInvoiceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = writeOffSchema.parse(input)

    await writeOffInvoice(actor, parsed.invoiceId, {
      writtenOffOn: parsed.writtenOffOn,
      reason: parsed.reason,
      amountCents: parsed.amountCents,
    })

    return 'Written off to Bad Debt. The revenue stays — it was earned, and then lost.'
  })
}

const recoverySchema = z.object({
  writeOffId: uuid,
  recoveredOn: isoDate,
  amountCents: z.number().int().positive(),
  financialAccountId: uuid,
})

export async function recoverWriteOffAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = recoverySchema.parse(input)

    await recoverWriteOff(actor, parsed.writeOffId, {
      recoveredOn: parsed.recoveredOn,
      amountCents: parsed.amountCents,
      financialAccountId: parsed.financialAccountId,
    })

    return 'Recovery recorded. The bad-debt expense is reversed, not counted as new revenue.'
  })
}

// --- Statements ------------------------------------------------------------

const statementSchema = z.object({
  customerId: uuid,
  asOfDate: isoDate,
  kind: z.enum(['open_item', 'balance_forward']).optional(),
  periodStart: isoDate.optional(),
})

export async function saveStatementAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = statementSchema.parse(input)

    const saved = await saveStatement(actor, parsed)
    return `Statement saved with its figures frozen as at ${saved.asOfDate}.`
  })
}

// --- Recurring entries -----------------------------------------------------

const recurringSchema = z.object({
  name: z.string().trim().min(1, 'A recurring entry needs a name.'),
  memo: z.string().trim().optional(),
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually']),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  autoPost: z.boolean().optional(),
  startsOn: isoDate,
  endsOn: isoDate.optional().or(z.literal('')),
  lines: z
    .array(
      z.object({
        chartAccountId: uuid,
        debitCents: z.number().int().min(0).optional(),
        creditCents: z.number().int().min(0).optional(),
        memo: z.string().trim().optional(),
      }),
    )
    .min(2, 'A journal entry needs at least two lines.'),
})

export async function createRecurringEntryAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = recurringSchema.parse(input)

    const template = await createRecurringEntry(actor, {
      ...parsed,
      endsOn: parsed.endsOn || undefined,
    })

    return `${template.name} saved. First occurrence ${template.nextRunOn}, ${
      template.autoPost ? 'posted automatically' : 'proposed as a draft for review'
    }.`
  })
}

export async function setRecurringActiveAction(
  templateId: string,
  isActive: boolean,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await setRecurringActive(actor, uuid.parse(templateId), isActive)
    return isActive ? 'Resumed.' : 'Paused. It will not fire until resumed.'
  })
}

export async function runRecurringNowAction(asOfDate: string): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const results = await runDueRecurringEntries(actor, isoDate.parse(asOfDate))

    if (results.length === 0) return 'Nothing is due.'

    const posted = results.filter((row) => row.posted).length
    const drafted = results.filter((row) => row.journalEntryId && !row.posted).length

    return `${results.length} due — ${posted} posted, ${drafted} proposed as drafts.`
  })
}

// --- The year-end close ----------------------------------------------------

export async function closeFiscalYearAction(closingDate: string): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const closed = await closeFiscalYear(actor, { closingDate: isoDate.parse(closingDate) })

    for (const path of PATHS) revalidatePath(path)

    return {
      ok: true,
      message: `${closed.fiscalYear} closed. Entry ${closed.entryNumber} moved the year's result to Retained Earnings.`,
    }
  } catch (error) {
    // A blocked close names exactly what is wrong. There is deliberately no
    // override — closing twice has one outcome and it is wrong.
    if (error instanceof CloseBlockedError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Could not close the year.' }
  }
}

export async function reopenFiscalYearAction(
  closeId: string,
  reason: string,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await reopenFiscalYear(actor, uuid.parse(closeId), reason)
    return 'Reopened. The closing entry is reversed, not deleted — the reopen is part of the record.'
  })
}

// --- Deposits and vendor credits (Phase 12) --------------------------------

const depositSchema = z.object({
  financialAccountId: uuid,
  depositDate: isoDate,
  paymentIds: z.array(uuid),
  // A fee is stored as the negative number it is. One place to get the sign
  // wrong is better than a positive amount plus a flag saying to subtract it.
  feeAccountId: uuid.optional(),
  feeCents: z.number().int().positive().optional(),
  memo: z.string().trim().optional(),
})

export async function createDepositAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = depositSchema.parse(input)

    const items: DepositItemInput[] = parsed.paymentIds.map((paymentId) => ({ paymentId }))
    if (parsed.feeAccountId && parsed.feeCents) {
      items.push({
        chartAccountId: parsed.feeAccountId,
        amountCents: -parsed.feeCents,
        memo: 'Processing fee',
      })
    }

    const deposit = await createDeposit(actor, {
      financialAccountId: parsed.financialAccountId,
      depositDate: parsed.depositDate,
      items,
      memo: parsed.memo || undefined,
    })

    return `${deposit.number} recorded. The bank will show one line for ${formatCents(deposit.totalCents)}.`
  })
}

export async function voidDepositAction(
  depositId: string,
  reversalDate: string,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const deposit = await voidDeposit(actor, uuid.parse(depositId), isoDate.parse(reversalDate))
    return `${deposit.number} reversed. Its receipts are waiting to be deposited again.`
  })
}

const vendorCreditSchema = z.object({
  vendorId: uuid,
  billId: uuid.optional(),
  issueDate: isoDate,
  reason: z.string().trim().optional(),
  applyImmediately: z.boolean().optional(),
})

export async function createVendorCreditAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = vendorCreditSchema.parse(input)

    const credit = await createVendorCredit(actor, {
      vendorId: parsed.vendorId,
      billId: parsed.billId,
      issueDate: parsed.issueDate,
      reason: parsed.reason || undefined,
      applyImmediately: parsed.applyImmediately ?? false,
    })

    return `${credit.number} issued. The cost is reversed on the accounts the bill was booked to.`
  })
}

const applyVendorCreditSchema = z.object({
  creditNoteId: uuid,
  billId: uuid,
  amountCents: z.number().int().positive(),
  appliedOn: isoDate,
})

export async function applyVendorCreditAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = applyVendorCreditSchema.parse(input)

    const result = await applyVendorCredit(actor, parsed)
    return `Applied. ${result.creditRemainingCents === 0 ? 'The credit is used up.' : 'Some credit is still available.'}`
  })
}
