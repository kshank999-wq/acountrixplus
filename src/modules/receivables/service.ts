import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
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
  serviceItems,
  vendors,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS, SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { createJournalEntry, voidJournalEntry, type JournalLineInput } from '@/modules/ledger/journal'
import type { DimensionAssignment } from '@/modules/dimensions/service'
import {
  priceDocumentTax,
  recordDocumentTax,
  type DocumentTaxLineInput,
} from '@/modules/payroll/sales-tax'
import { recordEvent } from '@/modules/worker/outbox'
import { formatCents } from '@/lib/money'

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
  /**
   * Job costing dimensions (spec §5, Phase 7). Optional everywhere: a company
   * without job costing never sets them and nothing about invoicing changes.
   */
  projectId?: string | null
  costCodeId?: string | null
  /**
   * The catalogue item this line sells (Phase 14, spec §5).
   *
   * When it is a stocked item, issuing the invoice also relieves inventory and
   * posts the cost — in this invoice's own transaction, so a sale cannot exist
   * with its cost of sales missing. Optional and ignored for services, which
   * is every line that existed before this phase.
   */
  itemId?: string | null
  /**
   * User-defined dimensions (Phase 16): `{ [dimensionId]: dimensionValueId }`.
   *
   * Phase 16 built the model and wired it to manual entries only, so a
   * company slicing its books by Location could tag a journal entry and not
   * an invoice — which meant the dimensional profit and loss saw costs and
   * missed revenue. Phase 23 needs both halves for property-level reporting,
   * and the fix is this one field: the journal line already accepts it.
   */
  dimensions?: DimensionAssignment
}

/**
 * Retainage: the slice of a billed total the customer holds back until the job
 * is accepted (spec §5).
 *
 * Handled here, in the one service that issues invoices, rather than as a
 * reclassifying journal entry posted afterwards. A reclass would move the
 * money on the ledger and leave the invoice subledger disagreeing with the AR
 * control account — the exact divergence that makes a month-end close painful.
 *
 * So: the retained portion is part of the invoice total (it *is* billed work,
 * and the customer's copy shows it) but is excluded from the invoice balance
 * and debited to Retainage Receivable instead of AR. Sum of open invoice
 * balances still equals the AR control account, and Retainage Receivable
 * carries what is being held.
 */
export type RetainageInput = {
  /** Withheld amount in cents. Must be less than the document total. */
  retainageCents: number
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
    /**
     * Sales tax broken down by code (spec §13).
     *
     * Given these, the tax total is priced from them rather than passed in,
     * and the breakdown is written inside this invoice's transaction — so a
     * jurisdiction's return and the invoice it came from cannot disagree. A
     * lump `taxCents` still works for a company that has not set codes up.
     */
    taxLines?: DocumentTaxLineInput[]
    memo?: string
    /** Default job for every line that does not name one of its own. */
    projectId?: string | null
    /** Portion of the total withheld under a retainage clause. */
    retainageCents?: number
  },
  /**
   * Runs inside an existing transaction when one is supplied.
   *
   * Progress billing needs the application and the invoice it becomes to
   * commit together, and the codebase's convention for that is to pass the
   * caller's executor down rather than to duplicate the logic.
   */
  exec?: Executor,
) {
  requirePermission(ctx, 'accounting:journal')

  if (input.lines.length === 0) {
    throw new Error('An invoice needs at least one line.')
  }

  // Read through the caller's executor, not through `db`.
  //
  // A function that accepts an executor has to use it for its *reads* as well
  // as its writes, or it cannot see rows the caller created in the same
  // transaction — which is exactly what happens when a walk-in visit creates
  // its house account and raises the invoice in one go. It read cleanly before
  // Phase 31 only because every caller happened to pass a customer that was
  // already committed.
  const reader = exec ?? db

  const [customer] = await reader
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
      projectId: line.projectId ?? input.projectId ?? null,
      costCodeId: line.costCodeId ?? null,
      sortOrder: index,
    }
  })

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)

  // Priced before the transaction opens, because the total belongs on the
  // invoice header this is about to write while the breakdown needs the id it
  // does not have yet. One read of the codes feeds both.
  const pricedTax = input.taxLines?.length
    ? await priceDocumentTax(ctx, input.taxLines)
    : null
  const taxCents = input.taxCents ?? pricedTax?.totalCents ?? 0
  const totalCents = subtotalCents + taxCents

  if (totalCents <= 0) {
    throw new Error('An invoice total must be greater than zero.')
  }

  const retainageCents = input.retainageCents ?? 0
  if (retainageCents < 0) {
    throw new Error('Retainage cannot be negative.')
  }
  if (retainageCents >= totalCents) {
    throw new Error('Retainage must be less than the invoice total.')
  }

  // Resolved before the transaction opens so a company without the
  // construction pack gets a message about its chart of accounts rather than a
  // half-written invoice.
  const retainageAccount =
    retainageCents > 0
      ? await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.retainageReceivable)
      : null

  if (retainageCents > 0 && !retainageAccount) {
    throw new Error(
      'Retainage needs a Retainage Receivable account (1170), which this chart of accounts does not have.',
    )
  }

  const dueDate = input.dueDate ?? addDays(input.issueDate, customer.paymentTermsDays)

  const write = async (tx: Executor) => {
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
        retainageCents,
        // What the customer owes now. Retainage is billed but not yet due.
        balanceCents: totalCents - retainageCents,
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
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        itemId: line.itemId ?? null,
        sortOrder: line.sortOrder,
      })),
    )

    const journalLineInputs: JournalLineInput[] = [
      {
        chartAccountId: arAccount.id,
        debitCents: totalCents - retainageCents,
        memo: `Invoice ${number}`,
      },
      ...lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        creditCents: line.amountCents,
        memo: line.description,
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        dimensions: line.dimensions,
      })),
    ]

    if (retainageAccount) {
      journalLineInputs.splice(1, 0, {
        chartAccountId: retainageAccount.id,
        debitCents: retainageCents,
        memo: `Retainage withheld on invoice ${number}`,
        projectId: input.projectId ?? null,
      })
    }

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

    if (pricedTax) {
      await recordDocumentTax(
        ctx,
        {
          documentType: 'invoice',
          documentId: invoice.id,
          documentDate: input.issueDate,
          // The priced amounts, not the codes' current rates: re-reading them
          // here could produce a breakdown that does not foot to the header.
          lines: pricedTax.lines,
        },
        tx,
      )
    }

    await tx
      .update(invoices)
      .set({ journalEntryId: entry.id })
      .where(eq(invoices.id, invoice.id))

    // Relieve stock and post the cost, in this same transaction (Phase 14).
    //
    // Inside, not after: a sale whose cost of sales is missing overstates the
    // margin on every report until somebody notices, and "after" is where a
    // crash between the two writes leaves it. Lines with no item, or with an
    // item that carries no stock, cost nothing extra — the query below finds
    // nothing and the whole block is skipped.
    const stockShortfalls = await relieveStockForInvoice(
      ctx,
      { invoiceId: invoice.id, issueDate: input.issueDate, lines, number },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'invoice.create',
        entityType: 'invoice',
        entityId: invoice.id,
        after: { number, customer: customer.name, totalCents, retainageCents, dueDate },
      },
      tx,
    )

    return { ...invoice, journalEntryId: entry.id, stockShortfalls }
  }

  return exec ? write(exec) : db.transaction(write)
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
    /** Default job for every line that does not name one of its own. */
    projectId?: string | null
    /** Portion withheld from a subcontractor under a retainage clause. */
    retainageCents?: number
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
      projectId: line.projectId ?? input.projectId ?? null,
      costCodeId: line.costCodeId ?? null,
      sortOrder: index,
    }
  })

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const taxCents = input.taxCents ?? 0
  const totalCents = subtotalCents + taxCents

  if (totalCents <= 0) {
    throw new Error('A bill total must be greater than zero.')
  }

  const retainageCents = input.retainageCents ?? 0
  if (retainageCents < 0) {
    throw new Error('Retainage cannot be negative.')
  }
  if (retainageCents >= totalCents) {
    throw new Error('Retainage must be less than the bill total.')
  }

  const retainageAccount =
    retainageCents > 0
      ? await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.retainagePayable)
      : null

  if (retainageCents > 0 && !retainageAccount) {
    throw new Error(
      'Retainage needs a Retainage Payable account (2570), which this chart of accounts does not have.',
    )
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
        retainageCents,
        // Retainage is owed, but not yet payable, so it is not in AP.
        balanceCents: totalCents - retainageCents,
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
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        sortOrder: line.sortOrder,
      })),
    )

    const billJournalLines: JournalLineInput[] = [
      ...lines.map((line) => ({
        chartAccountId: line.chartAccountId,
        debitCents: line.amountCents,
        memo: line.description,
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        dimensions: line.dimensions,
      })),
      {
        chartAccountId: apAccount.id,
        creditCents: totalCents - retainageCents,
        memo: `Bill ${number}`,
      },
    ]

    if (retainageAccount) {
      billJournalLines.push({
        chartAccountId: retainageAccount.id,
        creditCents: retainageCents,
        memo: `Retainage withheld on bill ${number}`,
        projectId: input.projectId ?? null,
      })
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.issueDate,
        memo: `Bill ${number} — ${vendor.name}`,
        source: 'bill',
        sourceType: 'bill',
        sourceId: bill.id,
        lines: billJournalLines,
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
        after: { number, vendor: vendor.name, totalCents, retainageCents, dueDate },
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
 *
 * Since Phase 12 a receipt may omit `financialAccountId`, which means the
 * money arrived but has not been banked: the debit goes to Undeposited Funds
 * and a deposit moves the batch across later. See `banking/deposits.ts` for
 * why that is worth a table.
 */
export async function recordPayment(
  ctx: ActorContext,
  input: {
    kind: 'receipt' | 'disbursement'
    customerId?: string
    vendorId?: string
    paymentDate: string
    amountCents: number
    /** Omit on a receipt to hold it in Undeposited Funds. */
    financialAccountId?: string
    /**
     * The open shift whose drawer this cash went into (Phase 34).
     *
     * Set, the receipt debits `1060 Cash Drawers` rather than Undeposited
     * Funds: a note handed across a counter is in a till somebody is
     * accountable for, and it does not become money on its way to a bank until
     * that person counts it and hands it over. Ignored alongside an explicit
     * `financialAccountId`, which is somebody saying they already know where
     * the money went.
     */
    drawerShiftId?: string
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

  if (!input.financialAccountId && input.kind !== 'receipt') {
    throw new Error('A disbursement has to say which account the money left.')
  }

  // Undeposited receipts debit Undeposited Funds instead of a bank account.
  // Resolved to a chart account here so the entry below does not care which
  // of the two cases it is posting.
  let debitAccountId: string
  if (input.financialAccountId) {
    const [account] = await db
      .select()
      .from(financialAccounts)
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
      .limit(1)

    if (!account) throw new Error('Financial account not found')
    debitAccountId = account.chartAccountId
  } else if (input.drawerShiftId) {
    // Resolved by account number rather than by importing the drawer module,
    // which would make receivables depend on a module that depends on it.
    const drawerCash = await accountByNumber(ctx.companyId, '1060')
    if (!drawerCash) {
      throw new Error('The Cash Drawers account is missing from the chart.')
    }
    debitAccountId = drawerCash.id
  } else {
    const undeposited = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.undepositedFunds)
    if (!undeposited) {
      throw new Error('The Undeposited Funds account is missing from the chart.')
    }
    debitAccountId = undeposited.id
  }

  const controlNumber =
    input.kind === 'receipt'
      ? SYSTEM_ACCOUNTS.accountsReceivable
      : SYSTEM_ACCOUNTS.accountsPayable
  const controlAccount = await accountByNumber(ctx.companyId, controlNumber)
  if (!controlAccount) throw new Error('The AR/AP control account is missing from the chart.')

  // Read before the transaction opens: the notification wants a name, and
  // fetching it inside would add a query to the hot path of every payment for
  // the sake of the ones that settle an invoice.
  let customerName: string | null = null
  if (input.kind === 'receipt' && input.customerId) {
    const [customer] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
      .limit(1)
    customerName = customer?.name ?? null
  }

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
        financialAccountId: input.financialAccountId ?? null,
        drawerShiftId: input.financialAccountId ? null : (input.drawerShiftId ?? null),
        reference: input.reference ?? null,
        memo: input.memo ?? null,
      })
      .returning()

    const settlements: Array<{ documentId: string; number: string }> = []

    for (const application of input.applications) {
      const applied = await applyToDocument(ctx, payment.id, application, input.kind, tx)
      if (applied.settled) settlements.push(applied)
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
                { chartAccountId: debitAccountId, debitCents: input.amountCents },
                { chartAccountId: controlAccount.id, creditCents: input.amountCents },
              ]
            : [
                { chartAccountId: controlAccount.id, debitCents: input.amountCents },
                { chartAccountId: debitAccountId, creditCents: input.amountCents },
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

    // An invoice going to zero is the event somebody wants to know about, and
    // it is recorded inside this transaction so it cannot exist for a payment
    // that rolled back (Phase 10, ADR 0010). A partial payment is not an
    // event — "they paid some of it" is a balance, not news.
    for (const settled of settlements) {
      if (input.kind !== 'receipt') continue

      await recordEvent(
        ctx,
        {
          type: 'invoice.paid',
          entityType: 'invoice',
          entityId: settled.documentId,
          payload: {
            invoiceNumber: settled.number,
            customerName: customerName ?? 'A customer',
            amount: formatCents(input.amountCents),
          },
        },
        tx,
      )
    }

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
): Promise<{ settled: boolean; documentId: string; number: string }> {
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

  const reduced = await reduceDocumentBalance(
    ctx,
    table,
    document,
    application.amountCents,
    tx,
  )

  await tx.insert(paymentApplications).values({
    companyId: ctx.companyId,
    paymentId,
    invoiceId: isInvoice ? documentId : null,
    billId: isInvoice ? null : documentId,
    amountCents: application.amountCents,
  })

  return { settled: reduced.settled, documentId, number: document.number }
}

/**
 * Takes an amount off a document's balance and moves its status.
 *
 * Extracted so there is exactly one implementation of the rule. A settlement
 * that is not cash — a security deposit kept against unpaid rent (Phase 23) —
 * has to move a balance the same way a payment does, and a second copy of
 * "zero means paid, anything else means partial" is a second thing to get
 * wrong when the rule changes.
 */
async function reduceDocumentBalance(
  ctx: ActorContext,
  table: typeof invoices | typeof bills,
  document: { id: string; status: string; balanceCents: number },
  amountCents: number,
  tx: Executor,
): Promise<{ settled: boolean; balanceCents: number }> {
  if (document.status === 'void') {
    throw new Error('That document is voided.')
  }

  if (amountCents > document.balanceCents) {
    throw new Error(
      `Cannot apply ${amountCents} to a document with a balance of ${document.balanceCents}.`,
    )
  }

  const newBalance = document.balanceCents - amountCents

  await tx
    .update(table)
    .set({
      balanceCents: newBalance,
      status: newBalance === 0 ? 'paid' : 'partial',
      updatedAt: new Date(),
    })
    .where(and(eq(table.id, document.id), eq(table.companyId, ctx.companyId)))

  return { settled: newBalance === 0, balanceCents: newBalance }
}

/**
 * Settles part of an invoice with something that is not cash.
 *
 * Deliberately **not** a `payments` row. A receipt with no financial account
 * means "cash in hand, not yet banked" — it appears on the undeposited funds
 * list and the bank deposit screen offers to pay it in. A security deposit
 * being kept is not cash in hand; it is money already in the bank months ago,
 * moving out of a liability. Recording it as a payment would invent cash that
 * nobody can deposit, and the first person to notice would be whoever tried.
 *
 * The caller posts its own journal entry for the other side of the settlement,
 * because only the caller knows what that side is.
 */
export async function settleInvoiceWithoutCash(
  ctx: ActorContext,
  input: { invoiceId: string; amountCents: number },
  tx: Executor,
): Promise<{ settled: boolean; balanceCents: number; number: string }> {
  if (input.amountCents <= 0) {
    throw new Error('A settlement amount must be greater than zero.')
  }

  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)))
    .limit(1)

  if (!invoice) throw new Error('Invoice not found')

  const reduced = await reduceDocumentBalance(ctx, invoices, invoice, input.amountCents, tx)
  return { ...reduced, number: invoice.number }
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

    // Retainage is billed but not in the balance, so "untouched" means the
    // balance still equals total minus retainage, not total.
    if (document.balanceCents !== document.totalCents - document.retainageCents) {
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
      customerId: invoices.customerId,
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
      // Carried since Phase 12 so a vendor credit can be raised from the list
      // without a second lookup per bill.
      vendorId: bills.vendorId,
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

/**
 * Relieves stock and posts cost of sales for an invoice's stocked lines.
 *
 * ## Why this lives here rather than in the inventory module
 *
 * It is the seam between two modules, and it has to run inside the invoice's
 * transaction. Putting it in `inventory/` and calling it from here would be
 * the same code with a longer import; putting the *decision* here — which
 * lines carry stock — keeps invoicing in charge of what an invoice does.
 *
 * The inventory module still owns the costing and the posting. This function
 * only decides who to ask.
 *
 * Returns any shortfalls so the caller can tell somebody that they have just
 * sold stock the books say does not exist. The sale is not refused: it
 * happened, and a system that refuses to record it teaches people to record
 * something else instead.
 */
async function relieveStockForInvoice(
  ctx: ActorContext,
  input: {
    invoiceId: string
    issueDate: string
    number: string
    lines: Array<{ itemId?: string | null; quantityMilli: number; description: string }>
  },
  tx: Executor,
): Promise<Array<{ itemId: string; description: string; shortfallMilli: number }>> {
  const itemIds = input.lines
    .map((line) => line.itemId)
    .filter((id): id is string => typeof id === 'string')

  if (itemIds.length === 0) return []

  const stocked = await tx
    .select({ id: serviceItems.id })
    .from(serviceItems)
    .where(
      and(
        eq(serviceItems.companyId, ctx.companyId),
        inArray(serviceItems.id, itemIds),
        eq(serviceItems.isInventoried, true),
      ),
    )

  if (stocked.length === 0) return []

  const stockedIds = new Set(stocked.map((row) => row.id))
  const { consumeStockForSale } = await import('@/modules/inventory/service')
  const { invoiceCostings } = await import('@/db/schema')

  const shortfalls: Array<{ itemId: string; description: string; shortfallMilli: number }> = []

  for (const line of input.lines) {
    if (!line.itemId || !stockedIds.has(line.itemId)) continue

    const result = await consumeStockForSale(
      ctx,
      {
        itemId: line.itemId,
        quantityMilli: line.quantityMilli,
        soldOn: input.issueDate,
        sourceType: 'invoice',
        sourceId: input.invoiceId,
        memo: `Invoice ${input.number}`,
      },
      tx,
    )

    if (result.consumed.length > 0) {
      // Frozen, so a return can put the stock back at the cost it left at
      // rather than at whatever today's average happens to be.
      await tx.insert(invoiceCostings).values({
        companyId: ctx.companyId,
        invoiceId: input.invoiceId,
        itemId: line.itemId,
        quantityMilli: line.quantityMilli - result.shortfallMilli,
        costCents: result.costCents,
        lotBreakdown: JSON.stringify(result.consumed),
      })
    }

    if (result.shortfallMilli > 0) {
      shortfalls.push({
        itemId: line.itemId,
        description: line.description,
        shortfallMilli: result.shortfallMilli,
      })
    }
  }

  return shortfalls
}
