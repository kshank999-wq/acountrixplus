import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
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
import { convert, ensureFxAccount, functionalCurrency, normalise, rateFor } from '@/modules/fx/service'
import { splitReceipt } from './overpayment'
import { settlementCurrency } from './settlement-currency'
import { relieveFunctional } from '@/modules/fx/documents'
import {
  CUSTOMER_FIELDS,
  VENDOR_FIELDS,
  diffParty,
  type FieldChange,
} from '@/modules/parties/changes'
import { isSecret, maskSecret } from '@/modules/audit/visibility'
import {
  describeDuplicate,
  duplicateVerdict,
  mayProceed,
  normaliseReference,
  type ComparableBill,
  type DuplicateVerdict,
} from '@/modules/payables/references'
import { describeNamesake, namesakeOf } from '@/modules/payables/namesakes'
import { DomainError } from '@/modules/errors'

/**
 * A refusal somebody can act on (Phase 47).
 *
 * Every refusal in this module threw plain `Error` until now, and `messageFor`
 * returns its caller's fallback for anything that is not a `DomainError` — so
 * all thirty-three sentences carefully written for a person ("Record one
 * payment per currency", "Accounts Payable account is missing from the chart",
 * "Retainage must be less than the bill total") reached them as *"Something
 * went wrong."* The messages were always here; nothing could read them.
 *
 * Covers invoices, bills and payments, because they are one domain and a
 * caller catching a refusal from this module should not have to know which of
 * the three it came from.
 */
export class DocumentError extends DomainError {
  readonly status = 400

  /**
   * Whether a person may go ahead having read this.
   *
   * True only for a *resemblance* — a bill that looks like one already
   * entered, a supplier whose name is already on the books. False for
   * everything else, including a repeated supplier reference, which is not a
   * question: the supplier's own numbering has already answered it.
   *
   * Carried on the error rather than worked out from the sentence, so the
   * screen and the rule cannot drift apart.
   */
  readonly overridable: boolean

  /** Present when the refusal was about a resemblance, so a screen can list it. */
  readonly duplicate?: DuplicateVerdict

  constructor(
    message: string,
    options: { overridable?: boolean; duplicate?: DuplicateVerdict } = {},
  ) {
    super(message)
    this.name = 'DocumentError'
    this.overridable = options.overridable ?? false
    this.duplicate = options.duplicate
  }
}

/**
 * This supplier's bills, as the duplicate check needs to compare them.
 *
 * Voided ones are excluded: a bill that was voided is a bill that should never
 * have existed, so re-entering it correctly is the fix rather than the error.
 */
async function comparableBillsFor(
  ctx: ActorContext,
  vendorId: string,
): Promise<ComparableBill[]> {
  const rows = await db
    .select({
      id: bills.id,
      number: bills.number,
      vendorId: bills.vendorId,
      referenceKey: bills.referenceKey,
      issueDate: bills.issueDate,
      totalCents: bills.totalCents,
    })
    .from(bills)
    .where(
      scoped(ctx, bills, and(eq(bills.vendorId, vendorId), ne(bills.status, 'void'))),
    )

  return rows
}

/**
 * Refuses a second record for a party already on the books (Phase 47).
 *
 * Overridable, because two businesses can genuinely share a name — but not
 * silent, because two records for one supplier split their balance and their
 * aging in two *and* blind the duplicate-bill rule, which is keyed on the
 * vendor. Browser verification found the demo offering Delta Electrical twice.
 *
 * Only active parties are compared. An archived one is deliberately hidden,
 * and refusing a new record because of it would be refusing on grounds nobody
 * can see.
 */
async function refuseNamesake(
  ctx: ActorContext,
  name: string,
  kind: 'customer' | 'supplier',
  allowNamesake: boolean | undefined,
): Promise<void> {
  if (allowNamesake) return

  const table = kind === 'customer' ? customers : vendors
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(scoped(ctx, table, eq(table.isActive, true)))

  const match = namesakeOf(name, rows)
  if (match) throw new DocumentError(describeNamesake(match, kind), { overridable: true })
}

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
  input: {
    name: string
    email?: string
    phone?: string
    paymentTermsDays?: number
    /**
     * The address (Phase 45).
     *
     * `modules/pdf/invoice.ts` has read `customer.addressLine1` since Phase 21
     * and nothing has ever written it, so every invoice PDF this application
     * has produced carried a blank billing address. Accepted here and on the
     * edit form; the PDF needed no change at all.
     */
    addressLine1?: string
    addressLine2?: string
    city?: string
    region?: string
    postalCode?: string
    notes?: string
    /**
     * Enter a second record under a name already on the books (Phase 47).
     *
     * Two businesses can genuinely share a name. The seed and any bulk import
     * pass it because they are not a person typing into a form and have their
     * own reasons for what they create.
     */
    allowNamesake?: boolean
  },
) {
  requirePermission(ctx, 'crm:manage')

  await refuseNamesake(ctx, input.name, 'customer', input.allowNamesake)

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({
        companyId: ctx.companyId,
        ...normaliseParty(input),
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
    phone?: string
    paymentTermsDays?: number
    taxId?: string
    is1099Vendor?: boolean
    addressLine1?: string
    addressLine2?: string
    city?: string
    region?: string
    postalCode?: string
    notes?: string
    /** As on the customer side. See `createCustomer` (Phase 47). */
    allowNamesake?: boolean
  },
) {
  requirePermission(ctx, 'accounting:view')

  await refuseNamesake(ctx, input.name, 'supplier', input.allowNamesake)

  return db.transaction(async (tx) => {
    const [vendor] = await tx
      .insert(vendors)
      .values({
        companyId: ctx.companyId,
        ...normaliseParty(input),
        paymentTermsDays: input.paymentTermsDays ?? 30,
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

/**
 * Corrects a customer (Phase 45).
 *
 * ## Why this did not exist until now
 *
 * It should have from Phase 2, and its absence was quietly severe: a typo in
 * an email meant that customer could never be sent an invoice or a reminder,
 * for ever, and the only escape was a second customer record — which splits
 * their history, their aging and their statement in two.
 *
 * ## A correction is not a rewrite of history
 *
 * The name and address are **descriptions**: correcting one corrects it
 * everywhere it appears, including on an invoice already sent, which is right.
 * A document showing a stale spelling of somebody's name is showing something
 * that was never true, and it is the same live-record argument ADR 0042 made
 * about the balance.
 *
 * Payment terms are a **default**: they decide the next invoice's due date and
 * do not touch one already raised, whose due date is a fact somebody was told.
 * Nothing here reaches into `invoices`, deliberately.
 *
 * Every change carries before and after into the audit log. That is not
 * decoration on a party record — see `modules/parties/changes.ts`.
 */
export async function updateCustomer(
  ctx: ActorContext,
  customerId: string,
  input: Partial<{
    name: string
    email: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    paymentTermsDays: number
    notes: string | null
    isActive: boolean
  }>,
) {
  requirePermission(ctx, 'crm:manage')

  const [before] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, customerId)))
    .limit(1)

  if (!before) throw new DomainError('That customer is not on these books.')

  if (input.name !== undefined && !input.name.trim()) {
    throw new DomainError('A customer needs a name.')
  }
  if (input.paymentTermsDays !== undefined && input.paymentTermsDays < 0) {
    throw new DomainError('Payment terms cannot be negative.')
  }

  const changes = diffParty({ fields: CUSTOMER_FIELDS, before, after: input })

  // An untouched form saved is not a change. Writing one anyway fills the
  // audit log with noise and buries the one edit that mattered.
  if (changes.length === 0 && input.isActive === undefined) return before

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(customers)
      .set({ ...normaliseParty(input) })
      .where(scoped(ctx, customers, eq(customers.id, customerId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'customer.update',
        entityType: 'customer',
        entityId: customerId,
        before: auditable(changes, 'from'),
        after: auditable(changes, 'to'),
      },
      tx,
    )

    return updated
  })
}

/** Corrects a vendor. See `updateCustomer` — the reasoning is the same. */
export async function updateVendor(
  ctx: ActorContext,
  vendorId: string,
  input: Partial<{
    name: string
    email: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    region: string | null
    postalCode: string | null
    paymentTermsDays: number
    taxId: string | null
    is1099Vendor: boolean
    notes: string | null
    isActive: boolean
  }>,
) {
  // Editing a vendor changes where money goes. `accounting:journal` rather
  // than the `accounting:view` that creating one needs, because reading a
  // supplier list and redirecting a payment run are different powers.
  requirePermission(ctx, 'accounting:journal')

  const [before] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, vendorId)))
    .limit(1)

  if (!before) throw new DomainError('That vendor is not on these books.')

  if (input.name !== undefined && !input.name.trim()) {
    throw new DomainError('A vendor needs a name.')
  }
  if (input.paymentTermsDays !== undefined && input.paymentTermsDays < 0) {
    throw new DomainError('Payment terms cannot be negative.')
  }

  const changes = diffParty({ fields: VENDOR_FIELDS, before, after: input })
  if (changes.length === 0 && input.isActive === undefined) return before

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(vendors)
      .set({ ...normaliseParty(input) })
      .where(scoped(ctx, vendors, eq(vendors.id, vendorId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'vendor.update',
        entityType: 'vendor',
        entityId: vendorId,
        before: auditable(changes, 'from'),
        after: auditable(changes, 'to'),
      },
      tx,
    )

    return updated
  })
}

/**
 * Trims text and turns an emptied field into a null.
 *
 * A form that submits `""` for a cleared address must store nothing rather
 * than an empty string, or every `is not null` check downstream — the invoice
 * PDF's address block, the chase decision's "has an email" — reads a blank as
 * a value and behaves as though it were filled in.
 */
/**
 * A party's changes as an audit payload, minus the values that do not belong
 * in one (Phase 72).
 *
 * `payroll/vendor-reporting` decided this in Phase 68 and said why: recording
 * what a tax identifier *was* "would put a tax number in a table read by
 * everyone with `audit:view`". This module never heard, and wrote it verbatim
 * on every edit that touched the field — one question with two answers, and
 * Phase 71 gave the careless one a screen.
 *
 * The auditable fact is that the identifier changed, and by whom. Somebody
 * investigating a 1099 needs to know it was replaced on the 3rd; they do not
 * need the number, and putting it in the log is how it ends up somewhere it
 * should never have been. `isSecret` is the same list the reader redacts
 * against, so the rows written before this agree with the ones written after.
 */
function auditable(changes: FieldChange[], side: 'from' | 'to'): Record<string, unknown> {
  return Object.fromEntries(
    changes.map((change) => [
      change.key,
      isSecret(change.key) ? maskSecret(change[side]) : change[side],
    ]),
  )
}

function normaliseParty<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      out[key] = key === 'name' ? trimmed : trimmed === '' ? null : trimmed
    } else {
      out[key] = value
    }
  }

  return out as T
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
    /**
     * What the customer is billed in (Phase 35).
     *
     * Defaults to the company's own currency. When it differs, every amount on
     * this input is in *that* currency — it is what the customer owes — and the
     * ledger is posted at the rate on file for `issueDate`.
     */
    currency?: string
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
    throw new DocumentError('An invoice needs at least one line.')
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

  if (!customer) throw new DocumentError('Customer not found')

  const arAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsReceivable)
  if (!arAccount) throw new DocumentError('Accounts Receivable account is missing from the chart.')

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
    throw new DocumentError('An invoice total must be greater than zero.')
  }

  const retainageCents = input.retainageCents ?? 0
  if (retainageCents < 0) {
    throw new DocumentError('Retainage cannot be negative.')
  }
  if (retainageCents >= totalCents) {
    throw new DocumentError('Retainage must be less than the invoice total.')
  }

  // Resolved before the transaction opens so a company without the
  // construction pack gets a message about its chart of accounts rather than a
  // half-written invoice.
  const retainageAccount =
    retainageCents > 0
      ? await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.retainageReceivable)
      : null

  if (retainageCents > 0 && !retainageAccount) {
    throw new DocumentError(
      'Retainage needs a Retainage Receivable account (1170), which this chart of accounts does not have.',
    )
  }

  const dueDate = input.dueDate ?? addDays(input.issueDate, customer.paymentTermsDays)

  // Resolved before the transaction opens, for the same reason the retainage
  // account is: a company with no rate on file should get a message about the
  // rate rather than a half-written invoice.
  const home = await functionalCurrency(ctx.companyId)
  const currency = input.currency ? normalise(input.currency) : home
  const { rateMillionths } = await rateFor(ctx, currency, input.issueDate)

  // Each credit converts on its own and the receivable is their sum, so the
  // entry balances by construction. Converting the total and letting the lines
  // fall where they may would need a plug account for a rounding cent, and a
  // plug account is a place for real differences to hide.
  const fx = (cents: number) => convert(cents, rateMillionths)
  const functionalRetainageCents = fx(retainageCents)

  // Converted once, up here, because the header has to store *what was
  // posted* rather than its own conversion of the total. Converting the total
  // separately would leave `functionalBalanceCents` a cent away from the
  // receivable it is supposed to equal — the precise drift Phase 31's control
  // account check exists to find, manufactured by the code that should prevent it.
  const functionalLineCents = lines.map((line) => fx(line.amountCents))
  const functionalTaxCents = fx(taxCents)
  const functionalTotalCents =
    functionalLineCents.reduce((sum, cents) => sum + cents, 0) + functionalTaxCents

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
        currency,
        exchangeRateMillionths: rateMillionths,
        functionalTotalCents,
        functionalBalanceCents: functionalTotalCents - functionalRetainageCents,
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
        debitCents: functionalTotalCents - functionalRetainageCents,
        memo: `Invoice ${number}`,
      },
      ...lines.map((line, index) => ({
        chartAccountId: line.chartAccountId,
        creditCents: functionalLineCents[index],
        memo: line.description,
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        dimensions: line.dimensions,
      })),
    ]

    if (retainageAccount) {
      journalLineInputs.splice(1, 0, {
        chartAccountId: retainageAccount.id,
        debitCents: functionalRetainageCents,
        memo: `Retainage withheld on invoice ${number}`,
        projectId: input.projectId ?? null,
      })
    }

    if (taxCents > 0) {
      const taxAccount = await accountByNumber(ctx.companyId, '2200', tx)
      if (!taxAccount) throw new DocumentError('Sales Tax Payable account is missing from the chart.')
      journalLineInputs.push({ chartAccountId: taxAccount.id, creditCents: functionalTaxCents })
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
    /**
     * **Ours.** Almost always omitted; the import wizard supplies one so a
     * migrated bill keeps the number it had in the old system.
     */
    number?: string
    /**
     * **Theirs** — the number printed on the supplier's invoice (Phase 47).
     *
     * The thing a person quotes on the phone, and the thing that says whether
     * this bill is already in the books. Unique per vendor, not per company.
     */
    vendorReference?: string | null
    /**
     * Enter it anyway, having seen what it resembles (Phase 47).
     *
     * Only ever overrides a *warning*. A shared reference from the same
     * supplier is the same document and is not overridable, because there is
     * nothing for a person to know that the supplier's own numbering does not
     * already say.
     */
    acknowledgeDuplicate?: boolean
    issueDate: string
    dueDate?: string
    lines: DocumentLineInput[]
    taxCents?: number
    memo?: string
    /** Default job for every line that does not name one of its own. */
    projectId?: string | null
    /** Portion withheld from a subcontractor under a retainage clause. */
    retainageCents?: number
    /** What the vendor billed in (Phase 35). Defaults to the company's own. */
    currency?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')

  if (input.lines.length === 0) {
    throw new DocumentError('A bill needs at least one line.')
  }

  const [vendor] = await db
    .select()
    .from(vendors)
    .where(scoped(ctx, vendors, eq(vendors.id, input.vendorId)))
    .limit(1)

  if (!vendor) throw new DocumentError('Vendor not found')

  const apAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.accountsPayable)
  if (!apAccount) throw new DocumentError('Accounts Payable account is missing from the chart.')

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
    throw new DocumentError('A bill total must be greater than zero.')
  }

  const retainageCents = input.retainageCents ?? 0
  if (retainageCents < 0) {
    throw new DocumentError('Retainage cannot be negative.')
  }
  if (retainageCents >= totalCents) {
    throw new DocumentError('Retainage must be less than the bill total.')
  }

  // Is this already in the books (Phase 47)? Asked before anything is written,
  // and answered against this supplier's bills only — a different supplier
  // using the same number is how invoice numbering works, not a collision.
  const referenceKey = normaliseReference(input.vendorReference)

  const verdict = duplicateVerdict({
    candidate: {
      vendorId: input.vendorId,
      referenceKey,
      issueDate: input.issueDate,
      totalCents,
    },
    existing: await comparableBillsFor(ctx, input.vendorId),
  })

  if (!mayProceed(verdict, input.acknowledgeDuplicate ?? false)) {
    throw new DocumentError(
      describeDuplicate(verdict) ?? 'This bill looks like one already entered.',
      // A resemblance is a question; a repeated reference is not.
      { overridable: verdict.action === 'warn', duplicate: verdict },
    )
  }

  const retainageAccount =
    retainageCents > 0
      ? await accountByNumber(ctx.companyId, INDUSTRY_ACCOUNTS.retainagePayable)
      : null

  if (retainageCents > 0 && !retainageAccount) {
    throw new DocumentError(
      'Retainage needs a Retainage Payable account (2570), which this chart of accounts does not have.',
    )
  }

  const dueDate = input.dueDate ?? addDays(input.issueDate, vendor.paymentTermsDays)

  // The same treatment as an invoice, and for the same reasons — see
  // `createInvoice`. A bill from a supplier in Milan is for €4,000 whatever
  // the rate did afterwards.
  const billHome = await functionalCurrency(ctx.companyId)
  const billCurrency = input.currency ? normalise(input.currency) : billHome
  const billRate = (await rateFor(ctx, billCurrency, input.issueDate)).rateMillionths
  const bfx = (cents: number) => convert(cents, billRate)

  const functionalBillLineCents = lines.map((line) => bfx(line.amountCents))
  const functionalBillTaxCents = bfx(taxCents)
  const functionalBillTotalCents =
    functionalBillLineCents.reduce((sum, cents) => sum + cents, 0) + functionalBillTaxCents
  const functionalBillRetainageCents = bfx(retainageCents)

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextDocumentNumber(ctx, 'bill', tx))

    const [bill] = await tx
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId: input.vendorId,
        number,
        // Verbatim, punctuation and all, because it is a quotation from
        // somebody else's paperwork. The key beside it is what gets compared.
        vendorReference: input.vendorReference?.trim() || null,
        referenceKey,
        // Who entered it (Phase 50). The two-person rule compares against this,
        // and until this phase nothing recorded it at all — so one person could
        // create a supplier, bill it and pay it with nobody able to tell.
        enteredBy: ctx.userId,
        issueDate: input.issueDate,
        dueDate,
        status: 'open',
        subtotalCents,
        taxCents,
        totalCents,
        retainageCents,
        // Retainage is owed, but not yet payable, so it is not in AP.
        balanceCents: totalCents - retainageCents,
        currency: billCurrency,
        exchangeRateMillionths: billRate,
        functionalTotalCents: functionalBillTotalCents,
        functionalBalanceCents: functionalBillTotalCents - functionalBillRetainageCents,
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
      ...lines.map((line, index) => ({
        chartAccountId: line.chartAccountId,
        debitCents: functionalBillLineCents[index],
        memo: line.description,
        projectId: line.projectId,
        costCodeId: line.costCodeId,
        dimensions: line.dimensions,
      })),
      {
        chartAccountId: apAccount.id,
        creditCents: functionalBillTotalCents - functionalBillRetainageCents,
        memo: `Bill ${number}`,
      },
    ]

    if (retainageAccount) {
      billJournalLines.push({
        chartAccountId: retainageAccount.id,
        creditCents: functionalBillRetainageCents,
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
    /**
     * The money is at a card processor, not at a bank (Phase 44).
     *
     * Debits `1250 Payments in Transit` rather than a bank account or
     * Undeposited Funds. Deliberately its own case rather than reusing
     * Undeposited Funds: that is cash in hand waiting to be walked to the
     * bank, and the deposit screen offers to bank it. Money at a processor is
     * neither in hand nor bankable — it arrives on its own, net of a fee, in
     * a batch — and summing the two would offer to deposit money that is
     * already on its way.
     *
     * Ignored alongside an explicit `financialAccountId`, which is somebody
     * saying they already know where the money went.
     */
    viaPaymentsInTransit?: boolean
    applications: PaymentApplicationInput[]
    reference?: string
    memo?: string
    /**
     * The pay run this disbursement is part of (Phase 59).
     *
     * Set only by `payRunAction`'s loop, so a batch can be reopened and its
     * suppliers advised together. A payment made one at a time carries none,
     * and none is invented for one.
     */
    payRunId?: string
  },
) {
  requirePermission(ctx, 'accounting:journal')

  if (input.amountCents <= 0) {
    throw new DocumentError('A payment amount must be greater than zero.')
  }

  /**
   * What the applications do not cover is **held**, not refused (Phase 53).
   *
   * This used to insist the two matched exactly, and the screen above it told
   * anybody who sent more than was owed to *"reduce it"* — putting a figure in
   * the books the bank statement disagrees with, and leaving the
   * reconciliation out for ever because the difference was never recorded as
   * anything.
   *
   * `splitReceipt` decides whether the leftover may be held at all: a
   * disbursement cannot (that leaves the supplier owing us, which is an asset
   * and what vendor credits are for), and neither can a receipt with nobody
   * named to hold it for.
   */
  const applied = input.applications.reduce((sum, a) => sum + a.amountCents, 0)

  const split = splitReceipt({
    kind: input.kind,
    amountCents: input.amountCents,
    appliedCents: applied,
    hasParty: Boolean(input.kind === 'receipt' ? input.customerId : input.vendorId),
  })

  if (!split.ok) throw new DocumentError(split.why)

  const heldCents = split.split.heldCents

  if (!input.financialAccountId && input.kind !== 'receipt') {
    throw new DocumentError('A disbursement has to say which account the money left.')
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

    if (!account) throw new DocumentError('Financial account not found')
    debitAccountId = account.chartAccountId
  } else if (input.viaPaymentsInTransit) {
    const inTransit = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.paymentsInTransit)
    if (!inTransit) {
      throw new DocumentError('The Payments in Transit account is missing from the chart.')
    }
    debitAccountId = inTransit.id
  } else if (input.drawerShiftId) {
    // Resolved by account number rather than by importing the drawer module,
    // which would make receivables depend on a module that depends on it.
    const drawerCash = await accountByNumber(ctx.companyId, '1060')
    if (!drawerCash) {
      throw new DocumentError('The Cash Drawers account is missing from the chart.')
    }
    debitAccountId = drawerCash.id
  } else {
    const undeposited = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.undepositedFunds)
    if (!undeposited) {
      throw new DocumentError('The Undeposited Funds account is missing from the chart.')
    }
    debitAccountId = undeposited.id
  }

  const controlNumber =
    input.kind === 'receipt'
      ? SYSTEM_ACCOUNTS.accountsReceivable
      : SYSTEM_ACCOUNTS.accountsPayable
  const controlAccount = await accountByNumber(ctx.companyId, controlNumber)
  if (!controlAccount) throw new DocumentError('The AR/AP control account is missing from the chart.')

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

  // The rate on the day the money moved. Read from the documents being settled
  // rather than passed in: a receipt against a euro invoice is a euro receipt,
  // and asking the caller to say so again is asking them to get it wrong.
  const paymentCurrency = await documentCurrency(ctx, input.kind, input.applications)
  const paymentRateMillionths = (
    await rateFor(ctx, paymentCurrency, input.paymentDate)
  ).rateMillionths

  /**
   * What arrived and what it settled, in the company's own money (Phase 65).
   *
   * Hoisted above the transaction because the row needs the held remainder at
   * insert time. It was computed further down and thrown away — the fourth
   * fact this block has worked out and discarded, after `paymentCurrency` on
   * the line above, which Phase 62 kept.
   *
   * The remainder is `received - applied` rather than a conversion of the
   * difference. The receipt's ledger entry splits the money that arrived into
   * what it settled and what is left, so the two halves have to add back to the
   * amount that actually hit the bank; converting the difference separately
   * would leave the entry a cent out.
   */
  const receivedCents = convert(input.amountCents, paymentRateMillionths)
  const appliedFunctionalCents = convert(applied, paymentRateMillionths)
  const heldFunctionalCents = receivedCents - appliedFunctionalCents

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
        unappliedCents: heldCents,
        financialAccountId: input.financialAccountId ?? null,
        drawerShiftId: input.financialAccountId ? null : (input.drawerShiftId ?? null),
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        payRunId: input.payRunId ?? null,
        /**
         * Kept, at last (Phase 62).
         *
         * This has been computed on every payment since Phase 35 to fetch the
         * rate, and thrown away. Five queries then summed `unappliedCents`
         * across a party's receipts as though every one of them were in the
         * company's own money.
         */
        currency: paymentCurrency,
        /**
         * Kept too (Phase 65). Phase 62 stored the currency and left the rate
         * behind, so three queries still netted a face-amount holding against
         * a converted invoice balance.
         */
        exchangeRateMillionths: paymentRateMillionths,
        functionalUnappliedCents: heldFunctionalCents,
      })
      .returning()

    const settlements: Array<{ documentId: string; number: string }> = []

    // What the documents were carried at, so the entry can credit receivables
    // by exactly what it took out of them.
    let carriedCents = 0

    for (const application of input.applications) {
      const applied = await applyToDocument(ctx, payment.id, application, input.kind, tx)
      if (applied.settled) settlements.push(applied)
      carriedCents += applied.functionalCents
    }

    /**
     * `receivedCents`, `appliedFunctionalCents` and `heldFunctionalCents` are
     * worked out above the transaction now (Phase 65), because the row stores
     * the held remainder. They mean here what they always did:
     *
     * - `receivedCents` is what the money is worth today, against what the
     *   documents were carried at. Between raising an invoice and being paid
     *   the rate moves, and the difference is a realised exchange gain or loss
     *   — a profit and loss event, not a rounding artefact, and not revenue,
     *   because nothing more was sold.
     * - The difference is on what was **applied**, not on the whole receipt
     *   (Phase 53). Comparing the full amount against what the documents were
     *   relieved by would read a $600 overpayment on a domestic receipt as a
     *   $600 exchange gain — inventing profit out of a customer rounding up.
     *   What is held was never carried at any document's rate, so there is no
     *   rate difference on it to realise.
     */
    const fxCents =
      input.kind === 'receipt'
        ? appliedFunctionalCents - carriedCents
        : carriedCents - appliedFunctionalCents

    const paymentLines: JournalLineInput[] =
      input.kind === 'receipt'
        ? [
            { chartAccountId: debitAccountId, debitCents: receivedCents },
            // Only what the documents were carried at comes out of the control
            // account. What was sent beyond that never entered receivables and
            // must not be relieved from it.
            ...(carriedCents > 0
              ? [{ chartAccountId: controlAccount.id, creditCents: carriedCents }]
              : []),
          ]
        : [
            { chartAccountId: controlAccount.id, debitCents: carriedCents },
            { chartAccountId: debitAccountId, creditCents: receivedCents },
          ]

    /**
     * The leftover is a liability to the customer (Phase 53).
     *
     * Credited to `2520 Customer Overpayments` rather than left in receivables
     * as a negative balance. Netting it against what other customers owe would
     * hide it inside the aging report and overstate collectable cash — and the
     * business genuinely owes this money, either against the next invoice or
     * back to the customer.
     */
    if (heldCents > 0) {
      const held = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.customerOverpayments)
      if (!held) {
        throw new DocumentError('The Customer Overpayments account is missing from the chart.')
      }
      paymentLines.push({
        chartAccountId: held.id,
        creditCents: heldFunctionalCents,
        memo: 'More than was owed, held as credit',
      })
    }

    if (fxCents !== 0) {
      const fxAccountId = await ensureFxAccount(ctx, tx)
      paymentLines.push(
        fxCents > 0
          ? { chartAccountId: fxAccountId, creditCents: fxCents, memo: 'Exchange gain' }
          : { chartAccountId: fxAccountId, debitCents: -fxCents, memo: 'Exchange loss' },
      )
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.paymentDate,
        memo: input.memo ?? (input.kind === 'receipt' ? 'Customer payment' : 'Vendor payment'),
        source: 'payment',
        sourceType: 'payment',
        sourceId: payment.id,
        lines: paymentLines,
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
/**
 * The currency the documents being settled are denominated in.
 *
 * Refuses a payment that spans two currencies. One receipt settling a euro
 * invoice and a dollar one is two receipts wearing a coat: there is no single
 * amount of money that arrived, and the FX difference on each would have to be
 * worked out separately anyway.
 */
async function documentCurrency(
  ctx: ActorContext,
  kind: 'receipt' | 'disbursement',
  applications: PaymentApplicationInput[],
): Promise<string> {
  const table = kind === 'receipt' ? invoices : bills
  const ids = applications
    .map((application) => (kind === 'receipt' ? application.invoiceId : application.billId))
    .filter((id): id is string => Boolean(id))

  if (ids.length === 0) return functionalCurrency(ctx.companyId)

  const rows = await db
    .selectDistinct({ currency: table.currency })
    .from(table)
    .where(and(eq(table.companyId, ctx.companyId), inArray(table.id, ids)))

  // One rule, shared with `remittance-send.ts`, which decided this again as
  // `bills[0]?.currency ?? company.currency` (Phase 62).
  const verdict = settlementCurrency({
    documentCurrencies: rows.map((row) => row.currency),
    homeCurrency: await functionalCurrency(ctx.companyId),
  })

  if (!verdict.ok) throw new DocumentError(verdict.reason)

  return verdict.currency
}

async function applyToDocument(
  ctx: ActorContext,
  paymentId: string,
  application: PaymentApplicationInput,
  kind: 'receipt' | 'disbursement',
  tx: Executor,
): Promise<{
  settled: boolean
  documentId: string
  number: string
  /**
   * What this application took out of the control account, at the rate the
   * *document* was raised at (Phase 35).
   *
   * Relieving a foreign receivable at today's rate would leave the remaining
   * balance carried at a rate no part of it was ever booked at, and the control
   * account permanently out of step with the invoices behind it.
   */
  functionalCents: number
}> {
  if (application.amountCents <= 0) {
    throw new DocumentError('Each application amount must be greater than zero.')
  }

  const isInvoice = kind === 'receipt'
  const documentId = isInvoice ? application.invoiceId : application.billId
  if (!documentId) {
    throw new DocumentError(
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

  if (!document) throw new DocumentError(isInvoice ? 'Invoice not found' : 'Bill not found')

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

  return {
    settled: reduced.settled,
    documentId,
    number: document.number,
    functionalCents: reduced.functionalCents,
  }
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
  document: {
    id: string
    status: string
    balanceCents: number
    exchangeRateMillionths: number
    functionalBalanceCents: number
  },
  amountCents: number,
  tx: Executor,
): Promise<{ settled: boolean; balanceCents: number; functionalCents: number }> {
  if (document.status === 'void') {
    throw new DocumentError('That document is voided.')
  }

  if (amountCents > document.balanceCents) {
    throw new DocumentError(
      `Cannot apply ${amountCents} to a document with a balance of ${document.balanceCents}.`,
    )
  }

  const newBalance = document.balanceCents - amountCents
  const relief = relieveFunctional(document, amountCents)

  await tx
    .update(table)
    .set({
      balanceCents: newBalance,
      functionalBalanceCents: relief.functionalBalanceCents,
      status: newBalance === 0 ? 'paid' : 'partial',
      updatedAt: new Date(),
    })
    .where(and(eq(table.id, document.id), eq(table.companyId, ctx.companyId)))

  return { settled: newBalance === 0, balanceCents: newBalance, functionalCents: relief.functionalCents }
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
    throw new DocumentError('A settlement amount must be greater than zero.')
  }

  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)))
    .limit(1)

  if (!invoice) throw new DocumentError('Invoice not found')

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
  /**
   * Why (Phase 70). Required by `corrections/vocabulary`, because cancelling a
   * document is a correction that **reached somebody outside the business** —
   * they have been sent it, and may be looking at it while you cancel.
   */
  reason?: string | null,
) {
  requirePermission(ctx, 'accounting:journal')

  const table = kind === 'invoice' ? invoices : bills

  return db.transaction(async (tx) => {
    const [document] = await tx
      .select()
      .from(table)
      .where(and(eq(table.id, documentId), eq(table.companyId, ctx.companyId)))
      .limit(1)

    if (!document) throw new DocumentError('Document not found')
    if (document.status === 'void') return

    // Retainage is billed but not in the balance, so "untouched" means the
    // balance still equals total minus retainage, not total.
    if (document.balanceCents !== document.totalCents - document.retainageCents) {
      throw new DocumentError(
        'This document has payments applied. Reverse the payments before voiding it.',
      )
    }

    if (document.journalEntryId) {
      await voidJournalEntry(ctx, document.journalEntryId, tx)
    }

    await tx
      .update(table)
      // Both balances, not just the face one. Voiding removes the journal
      // entry entirely, so the document is gone from the books — and a row
      // carrying a home-currency balance it no longer owes is a trap for the
      // next query that forgets to exclude `void` (Phase 35).
      .set({
        status: 'void',
        balanceCents: 0,
        functionalBalanceCents: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(table.id, documentId), eq(table.companyId, ctx.companyId)))

    await recordAudit(
      ctx,
      {
        action: kind === 'invoice' ? 'invoice.void' : 'bill.void',
        entityType: kind,
        entityId: documentId,
        before: { status: document.status, balanceCents: document.balanceCents },
        after: { status: 'void', balanceCents: 0, reason: reason ?? null },
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
      // Phase 63: a picker that says "$4,000.00" beside a euro invoice invites
      // somebody to credit it for the wrong money. The amounts here are the
      // document's own, so the currency has to travel with them.
      currency: invoices.currency,
      totalCents: invoices.totalCents,
      balanceCents: invoices.balanceCents,
      // Phase 42: whether the customer has been asked, and whether they looked.
      sentAt: invoices.sentAt,
      sentTo: invoices.sentTo,
      viewCount: invoices.viewCount,
      shareToken: invoices.shareToken,
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
      // Theirs, so the list can be searched by the number on the paperwork —
      // which is the number anybody actually has to hand (Phase 47).
      vendorReference: bills.vendorReference,
      issueDate: bills.issueDate,
      dueDate: bills.dueDate,
      status: bills.status,
      currency: bills.currency,
      totalCents: bills.totalCents,
      balanceCents: bills.balanceCents,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(scoped(ctx, bills))
    .orderBy(desc(bills.issueDate))
    .limit(opts.limit ?? 100)
}

/**
 * Next sequential document number, e.g. INV-1004 or BILL-1002.
 *
 * ## Why the highest number rather than the count (Phase 47)
 *
 * It counted rows until this phase, which is the same answer only while every
 * document was generated by this function. It never was: the composer let
 * somebody type a number, so a company with four typed documents got its next
 * generated one at 1005 — and if any of those four had been typed as
 * `BILL-1005`, the insert failed on a unique violation reported as *"Something
 * went wrong."*
 *
 * Reading the highest number we have actually issued is right whatever else is
 * in the table. Two concurrent inserts still read the same maximum; the unique
 * constraint arbitrates and the loser is told to try again, which is the rule
 * everywhere in this system that two people can act at once.
 */
async function nextDocumentNumber(
  ctx: ActorContext,
  kind: 'invoice' | 'bill',
  tx: Executor,
): Promise<string> {
  const table = kind === 'invoice' ? invoices : bills
  const prefix = kind === 'invoice' ? 'INV-' : 'BILL-'

  // The prefix is one of two constants in this function, never anything a
  // caller supplies, so it is written into the statement rather than bound.
  // Bound, Postgres cannot resolve the types of `~` and `substring(… from …)`
  // against an unknown parameter and the whole expression quietly returns
  // null — which is how this first went out returning BILL-1001 every time.
  const pattern = `^${prefix}[0-9]+$`
  const from = prefix.length + 1

  const [row] = await tx
    .select({
      highest: sql<string | null>`max(
        case when ${table.number} ~ ${sql.raw(`'${pattern}'`)}
        then substring(${table.number} from ${sql.raw(String(from))})::bigint
        end
      )`,
    })
    .from(table)
    .where(eq(table.companyId, ctx.companyId))

  const highest = row?.highest ? Number(row.highest) : 1000
  return `${prefix}${highest + 1}`
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
