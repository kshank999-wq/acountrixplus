import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  date,
  boolean,
  index,
  unique,
  pgEnum,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies } from './tenancy'
import { chartAccounts, financialAccounts } from './accounting'
import { journalEntries } from './ledger'

/**
 * Accounts receivable and accounts payable (spec §13).
 *
 * Invoices and bills are source documents; the ledger effect of each is a
 * journal entry derived from it. Balances are maintained on the document so
 * aging does not require summing the whole payment history on every read.
 */

export const documentStatusEnum = pgEnum('document_status', [
  'draft',
  'open',
  'partial',
  'paid',
  'void',
])

/** A customer the company invoices. */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    /** Default net terms in days, used to derive an invoice due date. */
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNameIdx: index('customers_company_name_idx').on(t.companyId, t.name),
  }),
)

/** A vendor the company receives bills from. */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    /**
     * 1099 tracking fields (spec §13). Collected here so the data exists when
     * 1099 reporting is built; nothing reads them yet.
     */
    taxId: text('tax_id'),
    is1099Vendor: boolean('is_1099_vendor').notNull().default(false),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNameIdx: index('vendors_company_name_idx').on(t.companyId, t.name),
  }),
)

/** A customer invoice. Posts Dr Accounts Receivable / Cr revenue accounts. */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** Human-facing document number, unique per company. */
    number: text('number').notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    status: documentStatusEnum('status').notNull().default('draft'),

    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    /** Remaining unpaid amount. Reaches zero when fully paid. */
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),

    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('invoices_company_number_unique').on(t.companyId, t.number),
    agingIdx: index('invoices_aging_idx').on(t.companyId, t.status, t.dueDate),
    customerIdx: index('invoices_customer_idx').on(t.companyId, t.customerId),
  }),
)

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    /** The revenue account this line credits. */
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    /** Thousandths, so fractional hours like 1.5 stay exact. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull().default(1000),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull().default(0),
    /** Extended amount, stored rather than recomputed so totals never drift. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    invoiceIdx: index('invoice_lines_invoice_idx').on(t.invoiceId),
  }),
)

/** A vendor bill. Posts Dr expense accounts / Cr Accounts Payable. */
export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    status: documentStatusEnum('status').notNull().default('draft'),

    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),

    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('bills_company_number_unique').on(t.companyId, t.number),
    agingIdx: index('bills_aging_idx').on(t.companyId, t.status, t.dueDate),
    vendorIdx: index('bills_vendor_idx').on(t.companyId, t.vendorId),
  }),
)

export const billLines = pgTable(
  'bill_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    /** The expense or COGS account this line debits. */
    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull().default(1000),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull().default(0),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    billIdx: index('bill_lines_bill_idx').on(t.billId),
  }),
)

/** Money in from a customer, or money out to a vendor. */
export const paymentKindEnum = pgEnum('payment_kind', ['receipt', 'disbursement'])

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: paymentKindEnum('kind').notNull(),
    /** Exactly one of these is set, matching `kind`. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),

    paymentDate: date('payment_date').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** The bank account the money moved through. */
    financialAccountId: uuid('financial_account_id').notNull(),
    reference: text('reference'),
    memo: text('memo'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyDateIdx: index('payments_company_date_idx').on(t.companyId, t.paymentDate),
    // Named explicitly: the generated name would exceed Postgres's 63-byte limit.
    financialAccountFk: foreignKey({
      name: 'payments_financial_account_fk',
      columns: [t.financialAccountId],
      foreignColumns: [financialAccounts.id],
    }).onDelete('restrict'),
    amountPositive: check('payments_amount_positive', sql`${t.amountCents} > 0`),
  }),
)

/**
 * Applies part of a payment to a specific invoice or bill.
 *
 * Splitting this out lets one payment settle several documents, and one
 * document be settled by several payments — both of which happen constantly in
 * practice. It is also what makes cash-basis reporting possible: the
 * application links a cash movement back to the revenue or expense accounts on
 * the document it paid.
 */
export const paymentApplications = pgTable(
  'payment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    /** Exactly one of these is set, matching the payment's kind. */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id').references(() => bills.id, { onDelete: 'cascade' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  },
  (t) => ({
    paymentIdx: index('payment_applications_payment_idx').on(t.paymentId),
    invoiceIdx: index('payment_applications_invoice_idx').on(t.invoiceId),
    billIdx: index('payment_applications_bill_idx').on(t.billId),
    // Applies to exactly one document.
    oneTargetCheck: check(
      'payment_applications_one_target',
      sql`(${t.invoiceId} IS NULL) <> (${t.billId} IS NULL)`,
    ),
    amountPositive: check('payment_applications_amount_positive', sql`${t.amountCents} > 0`),
  }),
)
