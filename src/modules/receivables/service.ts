import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  billLines,
  bills,
  customers,
  financialAccounts,
  invoiceLines,
  invoices,
  paymentApplications,
  payments,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry, voidJournalEntry, type JournalLineInput } from '@/modules/ledger/journal'

/**
 * Accounts receivable and payable (spec §13, §20 "AR/AP basics").
 *
 * Invoices and bills are source documents. Each posts one journal entry when
 * it is issued, and each payment posts another that moves the balance between
 * the control account and cash. Balances are maintained on the document so
 * aging does not have to replay payment history on every read — and every
 * balance change happens in the same transaction as the payment that caused
 * it, so the two cannot diverge.
 */

export type DocumentLineInput = {
  chartAccountId: string
  description: string
  /** Thousandths, so 1.5 hours is 1500. Defaults to one unit. */
  quantityMilli?: number
  unitPriceCents: number
}

/** Extended amount for a line, rounded half-up to the nearest cent. */
export function lineAmountCents(quantityMilli: number, unitPriceCents: number): number {
  return Math.round((quantityMilli * unitPriceCents) / 1000)
}

// --- Parties ---------------------------------------------------------------

export async function createCustomer(
  ctx: ActorContext,
  input: { name: string; email?: string; phone?: string; paymentTermsDays?: number },
) {
  requirePermission(ctx, 'crm:manage')

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 30,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'customer.create',
        entityType: 'customer',
        entityId: customer.id,
        after: { name: customer.name },
      },
      tx,
    )

    return customer
  })
}

export async function createVendor(
  ctx: ActorContext,
  input: {
    name: string
    email?: string
    paymentTermsDays?: number
    taxId?: string
    is1099Vendor?: boolean
  },
) {
  requirePermission(ctx, 'accounting:view')

  return db.transaction(async (tx) => {
    const [vendor] = await tx
      .insert(vendors)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        email: input.email ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 30,
        taxId: input.taxId ?? null,
        is1099Vendor: input.is1099Vendor ?? false,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'vendor.create',
        entityType: 'vendor',
        entityId: vendor.id,
        after: { name: vendor.name },
      },
      tx,
    )

    return vendor
  })
}

export async function listCustomers(ctx: ActorContext) {
  requirePermission(ctx, 'crm:view')
  return db
    .select()
    .from(customers)
    .where(scoped(ctx, customers))
    .orderBy(asc(customers.name))
}

export async function listVendors(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')
  return db.select().from(vendors).where(scoped(ctx, vendors)).orderBy(asc(vendors.name))
}

// --- Invoices --------------------------------------------------------------

/**
 * Issues a customer invoice.
 *
 * Posts Dr Accounts Receivable / Cr each revenue account. That is the accrual
 * recognition point: revenue is earned when the invoice is issued, regardless
 * of when the customer pays.
 */
export async function createInvoice(
  ctx: ActorContext,
  input: {
    customerId: string
    number?: string
    issueDate: string
    dueDate?: string
    lines: DocumentLineInput[]
    taxCents?: number
    memo?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')

  if (input.lines.length === 0) {
    throw new Error('An invoice needs at least one line.')
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
    .limit(1)

  if (!customer) throw new Error('Customer not found')

  const arAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsReceivable)
  if (!arAccount) throw new Error('Accounts Receivable account is missing from the chart.')

  const lines = input.lines.map((line, index) => {
    const quantityMilli = line.quantityMilli ?? 1000
    return {
      ...line,
      quantityMilli,
      amountCents: lineAmountCents(quantityMilli, line.unitPriceCents),
      sortOrder: index,
    }
  })

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxCents = input.taxCents ?? 0
  const totalCents = subtotalCents + taxCents

  if (totalCents <= 0) {
    throw new Error('An invoice total must be greater than zero.')
  }

  const dueDate = input.dueDate ?? addDays(input.issueDate, customer.paymentTermsDays)

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextDocumentNumber(ctx, 'invoice', tx))

    const [invoice] = await tx
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId: input.customerId,
        number,
        issueDate: input.issueDate,
        dueDate,
        status: 'open',
        subtotalCents,
        taxCents,
        totalCents,
        balanceCents: totalCents,
        memo: input.memo ?? null,
      })
      .returning()

    await tx.insert(invoiceLines).values(
      lines.map((line) => ({
        companyId: ctx.companyId,
        invoiceId: invoice.id,
        chartAccountId: line.chartAccountId,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        amountCents: line.amountCents,
        sortOrder: line.sortOrder,
      })),
    )

    const journalLineInputs: JournalLineInput[] = [
      { chartAccountId: arAccount.id, debitCents: totalCents, memo: `Invoice ${number}` },
      ...lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        creditCents: line.amountCents,
        memo: line.description,
      })),
    ]

    if (taxCents > 0) {
      const taxAccount = await accountByNumber(ctx.companyId, '2200', tx)
      if (!taxAccount) throw new Error('Sales Tax Payable account is missing from the chart.')
      journalLineInputs.push({ chartAccountId: taxAccount.id, creditCents: taxCents })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.issueDate,
        memo: `Invoice ${number} — ${customer.name}`,
        source: 'invoice',
        sourceType: 'invoice',
        sourceId: invoice.id,
        lines: journalLineInputs,
      },
      tx,
    )

    await tx
      .update(invoices)
      .set({ journalEntryId: entry.id })
      .where(eq(invoices.id, invoice.id))

    await recordAudit(
      ctx,
      {
        action: 'invoice.create',
        entityType: 'invoice',
        entityId: invoice.id,
        after: { number, customer: customer.name, totalCents, dueDate },
      },
      tx,
    )

    return { ...invoice, journalEntryId: entry.id }
  })
}

/**
 * Records a vendor bill.
 *
 * Posts Dr each expense account / Cr Accounts Payable — the mirror of an
 * invoice.
 */
export async function createBill(
  ctx: ActorContext,
  input: {
    vendorId: string
    number?: string
    issueDate: string
    dueDate?: string
    lines: DocumentLineInput[]
    taxCents?: number
    memo?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')

  if (input.lines.length === 0) {
    throw new Error('A bill needs at least one line.')
  }

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, input.vendorId)))
    .limit(1)

  if (!vendor) throw new Error('Vendor not found')

  const apAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsPayable)
  if (!apAccount) throw new Error('Accounts Payable account is missing from the chart.')

  const lines = input.lines.map((line, index) => {
    const quantityMilli = line.quantityMilli ?? 1000
    return {
      ...line,
      quantityMilli,
      amountCents: lineAmountCents(quantityMilli, line.unitPriceCents),
      sortOrder: index,
    }
  })

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxCents = input.taxCents ?? 0
  const totalCents = subtotalCents + taxCents

  if (totalCents <= 0) {
    throw new Error('A bill total must be greater than zero.')
  }

  const dueDate = input.dueDate ?? addDays(input.issueDate, vendor.paymentTermsDays)

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextDocumentNumber(ctx, 'bill', tx))

    const [bill] = await tx
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId: input.vendorId,
        number,
        issueDate: input.issueDate,
        dueDate,
        status: 'open',
        subtotalCents,
        taxCents,
        totalCents,
        balanceCents: totalCents,
        memo: input.memo ?? null,
      })
      .returning()

    await tx.insert(billLines).values(
      lines.map((line) => ({
        companyId: ctx.companyId,
        billId: bill.id,
        chartAccountId: line.chartAccountId,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        amountCents: line.amountCents,
        sortOrder: line.sortOrder,
      })),
    )

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.issueDate,
        memo: `Bill ${number} — ${vendor.name}`,
        source: 'bill',
        sourceType: 'bill',
        sourceId: bill.id,
        lines: [
          ...lines.map((line) => ({
            chartAccountId: line.chartAccountId,
            debitCents: line.amountCents,
            memo: line.description,
          })),
          { chartAccountId: apAccount.id, creditCents: totalCents, memo: `Bill ${number}` },
        ],
      },
      tx,
    )

    await tx.update(bills).set({ journalEntryId: entry.id }).where(eq(bills.id, bill.id))

    await recordAudit(
      ctx,
      {
        action: 'bill.create',
        entityType: 'bill',
        entityId: bill.id,
        after: { number, vendor: vendor.name, totalCents, dueDate },
      },
      tx,
    )

    return { ...bill, journalEntryId: entry.id }
  })
}

// --- Payments --------------------------------------------------------------

export type PaymentApplicationInput = {
  /** Exactly one of these, matching the payment kind. */
  invoiceId?: string
  billId?: string
  amountCents: number
}

/**
 * Records a payment and applies it to documents.
 *
 * A receipt posts Dr bank / Cr Accounts Receivable; a disbursement posts
 * Dr Accounts Payable / Cr bank. Neither touches revenue or expense — those
 * were already recognized when the invoice or bill was issued, and hitting
 * them again would double-count.
 */
export async function recordPayment(
  ctx: ActorContext,
  input: {
    kind: 'receipt' | 'disbursement'
    customerId?: string
    vendorId?: string
    paymentDate: string
    amountCents: number
    financialAccountId: string
    applications: PaymentApplicationInput[]
    reference?: string
    memo?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')

  if (input.amountCents <= 0) {
    throw new Error('A payment amount must be greater than zero.')
  }

  const applied = input.applications.reduce((sum, a) => sum + a.amountCents, 0)
  if (applied !== input.amountCents) {
    throw new Error(
      `Applications total ${applied} but the payment is ${input.amountCents}. They must match exactly.`,
    )
  }

  const [account] = await db
    .select()
    .from(financialAccounts)
    .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
    .limit(1)

  if (!account) throw new Error('Financial account not found')

  const controlNumber =
    input.kind === 'receipt'
      ? SYSTEM_ACCOUNTS.accountsReceivable
      : SYSTEM_ACCOUNTS.accountsPayable
  const controlAccount = await accountByNumber(ctx.companyId, controlNumber)
  if (!controlAccount) throw new Error('The AR/AP control account is missing from the chart.')

  return db.transaction(async (tx) => {
    const [payment] = await tx
      .insert(payments)
      .values({
        companyId: ctx.companyId,
        kind: input.kind,
        customerId: input.customerId ?? null,
        vendorId: input.vendorId ?? null,
        paymentDate: input.paymentDate,
        amountCents: input.amountCents,
        financialAccountId: input.financialAccountId,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
      })
      .returning()

    for (const application of input.applications) {
      await applyToDocument(ctx, payment.id, application, input.kind, tx)
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.paymentDate,
        memo: input.memo ?? (input.kind === 'receipt' ? 'Customer payment' : 'Vendor payment'),
        source: 'payment',
        sourceType: 'payment',
        sourceId: payment.id,
        lines:
          input.kind === 'receipt'
            ? [
                { chartAccountId: account.chartAccountId, debitCents: input.amountCents },
                { chartAccountId: controlAccount.id, creditCents: input.amountCents },
              ]
            : [
                { chartAccountId: controlAccount.id, debitCents: input.amountCents },
                { chartAccountId: account.chartAccountId, creditCents: input.amountCents },
              ],
      },
      tx,
    )

    await tx
      .update(payments)
      .set({ journalEntryId: entry.id })
      .where(eq(payments.id, payment.id))

    await recordAudit(
      ctx,
      {
        action: 'payment.record',
        entityType: 'payment',
        entityId: payment.id,
        after: {
          kind: input.kind,
          amountCents: input.amountCents,
          applications: input.applications.length,
        },
      },
      tx,
    )

    return { ...payment, journalEntryId: entry.id }
  })
}

/**
 * Applies one slice of a payment to an invoice or bill and updates its
 * balance.
 *
 * Rejects overpayment: a document cannot go below a zero balance. Credits and
 * refunds are their own workflow (spec §13), not a negative balance here.
 */
async function applyToDocument(
  ctx: ActorContext,
  paymentId: string,
  application: PaymentApplicationInput,
  kind: 'receipt' | 'disbursement',
  tx: Executor,
) {
  if (application.amountCents <= 0) {
    throw new Error('Each application amount must be greater than zero.')
  }

  const isInvoice = kind === 'receipt'
  const documentId = isInvoice ? application.invoiceId : application.billId
  if (!documentId) {
    throw new Error(
      isInvoice
        ? 'A receipt must be applied to an invoice.'
        : 'A disbursement must be applied to a bill.',
    )
  }

  const table = isInvoice ? invoices : bills
  const [document] = await tx
    .select()
    .from(table)
    .where(and(eq(table.id, documentId), eq(table.companyId, ctx.companyId)))
    .limit(1)

  if (!document) throw new Error(isInvoice ? 'Invoice not found' : 'Bill not found')
  if (document.status === 'void') {
    throw new Error('That document is voided.')
  }

  if (application.amountCents > document.balanceCents) {
    throw new Error(
      `Cannot apply ${application.amountCents} to a document with a balance of ${document.balanceCents}.`,
    )
  }

  const newBalance = document.balanceCents - application.amountCents

  await tx.insert(paymentApplications).values({
    companyId: ctx.companyId,
    paymentId,
    invoiceId: isInvoice ? documentId : null,
    billId: isInvoice ? null : documentId,
    amountCents: application.amountCents,
  })

  await tx
    .update(table)
    .set({
      balanceCents: newBalance,
      status: newBalance === 0 ? 'paid' : 'partial',
      updatedAt: new Date(),
    })
    .where(and(eq(table.id, documentId), eq(table.companyId, ctx.companyId)))
}

/**
 * Voids an invoice or bill and reverses its ledger entry.
 *
 * Refuses once any payment has been applied — unwinding cash that has already
 * moved needs a credit note, not a void.
 */
export async function voidDocument(
  ctx: ActorContext,
  kind: 'invoice' | 'bill',
  documentId: string,
) {
  requirePermission(ctx, 'accounting:journal')

  const table = kind === 'invoice' ? invoices : bills

  return db.transaction(async (tx) => {
    const [document] = await tx
      .select()
      .from(table)
      .where(and(eq(table.id, documentId), eq(table.companyId, ctx.companyId)))
      .limit(1)

    if (!document) throw new Error('Document not found')
    if (document.status === 'void') return

    if (document.balanceCents !== document.totalCents) {
      throw new Error(
        'This document has payments applied. Reverse the payments before voiding it.',
      )
    }

    if (document.journalEntryId) {
      await voidJournalEntry(ctx, document.journalEntryId, tx)
    }

    await tx
      .update(table)
      .set({ status: 'void', balanceCents: 0, updatedAt: new Date() })
      .where(and(eq(table.id, documentId), eq(table.companyId, ctx.companyId)))

    await recordAudit(
      ctx,
      {
        action: kind === 'invoice' ? 'invoice.void' : 'bill.void',
        entityType: kind,
        entityId: documentId,
        before: { status: document.status, balanceCents: document.balanceCents },
        after: { status: 'void', balanceCents: 0 },
      },
      tx,
    )
  })
}

// --- Queries ---------------------------------------------------------------

export async function listInvoices(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: invoices.id,
      number: invoices.number,
      customerName: customers.name,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      status: invoices.status,
      totalCents: invoices.totalCents,
      balanceCents: invoices.balanceCents,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(scoped(ctx, invoices))
    .orderBy(desc(invoices.issueDate))
    .limit(opts.limit ?? 100)
}

export async function listBills(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: bills.id,
      number: bills.number,
      vendorName: vendors.name,
      issueDate: bills.issueDate,
      dueDate: bills.dueDate,
      status: bills.status,
      totalCents: bills.totalCents,
      balanceCents: bills.balanceCents,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(scoped(ctx, bills))
    .orderBy(desc(bills.issueDate))
    .limit(opts.limit ?? 100)
}

/** Next sequential document number, e.g. INV-1004 or BILL-1002. */
async function nextDocumentNumber(
  ctx: ActorContext,
  kind: 'invoice' | 'bill',
  tx: Executor,
): Promise<string> {
  const table = kind === 'invoice' ? invoices : bills
  const prefix = kind === 'invoice' ? 'INV-' : 'BILL-'

  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(table)
    .where(eq(table.companyId, ctx.companyId))

  return `${prefix}${1001 + Number(row?.count ?? 0)}`
}

/** ISO date `days` after `isoDate`. */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
