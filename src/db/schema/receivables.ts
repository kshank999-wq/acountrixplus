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
import { organizations, projects } from './crm'
import { drawerShifts } from './drawer'
import { costCodes } from './jobs'

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
  /**
   * Real, owed, and not going to be collected (Phase 11).
   *
   * Deliberately not `void`. Voiding says the document should never have
   * existed and takes the revenue back out; writing off says it was earned and
   * then lost, which is a cost of doing business and belongs on the P&L as
   * one. Collapsing the two would hide every bad debt a company ever had.
   */
  'written_off',
])

/**
 * A customer the company invoices.
 *
 * "Customer" is an accounting *role* an organization plays, not a separate
 * party record — `organizationId` links back to the unified CRM record
 * (spec §6). Nullable so a customer can be created directly from the
 * accounting side without first existing in the CRM.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
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

/** A vendor the company receives bills from — the other accounting role. */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
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
    /**
     * Portion of the total withheld under a retainage clause (spec §5).
     *
     * Included in `totalCents` — it is billed work — but excluded from
     * `balanceCents`, because the customer does not owe it yet. On the ledger
     * it sits in Retainage Receivable rather than in AR, which is what keeps
     * the AR control account equal to the sum of open invoice balances.
     */
    retainageCents: bigint('retainage_cents', { mode: 'number' }).notNull().default(0),
    /** Remaining unpaid amount. Reaches zero when fully paid. */
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),

    /**
     * What this document is denominated in (Phase 35).
     *
     * Defaults to the company's own currency, which is what every document
     * raised before this phase is — so `totalCents` keeps its meaning and no
     * existing row changes. When it differs, `totalCents` is what the other
     * party owes *in their money*, and `functionalTotalCents` is what the
     * ledger carries.
     */
    currency: text('currency').notNull().default('USD'),
    /**
     * Millionths, foreign → functional. `1_000_000` for a domestic document.
     *
     * Fixed at the moment the document was raised and never recomputed.
     * Restating it from a later rate would silently rewrite the revenue this
     * document booked, every time a currency moved.
     */
    exchangeRateMillionths: bigint('exchange_rate_millionths', { mode: 'number' })
      .notNull()
      .default(1_000_000),
    /** `totalCents` converted at the rate above. What the ledger posted. */
    functionalTotalCents: bigint('functional_total_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** `balanceCents` at the document's own rate. What the control account holds. */
    functionalBalanceCents: bigint('functional_balance_cents', { mode: 'number' })
      .notNull()
      .default(0),

    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    /**
     * Getting it to the customer (Phase 42).
     *
     * `shareToken` is minted the first time an invoice is sent and never
     * rotated, so the link in an email somebody filed two years ago still
     * opens. Random per invoice — possessing one link reveals nothing about
     * any other, which is the same reasoning `proposals.public_token` follows.
     *
     * Nullable because an invoice that has never been sent has no link, and a
     * token that exists before anybody asked for one is a door standing open
     * for no reason.
     */
    shareToken: text('share_token'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** The address it actually went to, which may not be the one on file. */
    sentTo: text('sent_to'),
    /** How many times it has been sent. A second send is a reminder. */
    sendCount: integer('send_count').notNull().default(0),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('invoices_company_number_unique').on(t.companyId, t.number),
    agingIdx: index('invoices_aging_idx').on(t.companyId, t.status, t.dueDate),
    customerIdx: index('invoices_customer_idx').on(t.companyId, t.customerId),
    // Unique across every company: the token is the only thing identifying the
    // invoice on the public route, so a collision would show one company's
    // invoice to another's customer.
    shareTokenUnique: unique('invoices_share_token_unique').on(t.shareToken),
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
    /** Job costing dimensions, copied onto the derived journal lines. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),
    /**
     * The catalogue item sold (Phase 14).
     *
     * Set on a stocked line, which is what tells the invoice to relieve
     * inventory. Null for a free-text line, which is every line raised before
     * this phase and most lines raised after it.
     */
    itemId: uuid('item_id'),
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
    /** Withheld from a subcontractor under a retainage clause (spec §5). */
    retainageCents: bigint('retainage_cents', { mode: 'number' }).notNull().default(0),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),

    /**
     * What this document is denominated in (Phase 35).
     *
     * Defaults to the company's own currency, which is what every document
     * raised before this phase is — so `totalCents` keeps its meaning and no
     * existing row changes. When it differs, `totalCents` is what the other
     * party owes *in their money*, and `functionalTotalCents` is what the
     * ledger carries.
     */
    currency: text('currency').notNull().default('USD'),
    /**
     * Millionths, foreign → functional. `1_000_000` for a domestic document.
     *
     * Fixed at the moment the document was raised and never recomputed.
     * Restating it from a later rate would silently rewrite the revenue this
     * document booked, every time a currency moved.
     */
    exchangeRateMillionths: bigint('exchange_rate_millionths', { mode: 'number' })
      .notNull()
      .default(1_000_000),
    /** `totalCents` converted at the rate above. What the ledger posted. */
    functionalTotalCents: bigint('functional_total_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** `balanceCents` at the document's own rate. What the control account holds. */
    functionalBalanceCents: bigint('functional_balance_cents', { mode: 'number' })
      .notNull()
      .default(0),

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
    /** Job costing dimensions, copied onto the derived journal lines. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    costCodeId: uuid('cost_code_id').references(() => costCodes.id, { onDelete: 'set null' }),
    /**
     * The catalogue item sold (Phase 14).
     *
     * Set on a stocked line, which is what tells the invoice to relieve
     * inventory. Null for a free-text line, which is every line raised before
     * this phase and most lines raised after it.
     */
    itemId: uuid('item_id'),
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
    /**
     * The bank account the money moved through.
     *
     * Null since Phase 12 means the receipt is **undeposited**: the money has
     * arrived but has not been taken to a bank, so it sits in Undeposited
     * Funds until a deposit batches it. Which bank it will land in is not
     * known yet and guessing would put a figure on a reconciliation that
     * nothing at the bank matches.
     */
    financialAccountId: uuid('financial_account_id'),
    reference: text('reference'),
    memo: text('memo'),

    /**
     * The shift whose drawer this cash went into (Phase 34).
     *
     * Null for everything that is not a note handed across a counter — a card,
     * a bank transfer, a cheque in the post. Set, it means the money is in a
     * physical drawer somebody is accountable for, and it is what makes the
     * shift's takings a sum over payments rather than a running total that can
     * drift from them.
     *
     * Cleared rather than blocking if a shift is ever deleted: the payment is
     * a real receipt whatever happened to the till it went through.
     */
    drawerShiftId: uuid('drawer_shift_id').references(() => drawerShifts.id, {
      onDelete: 'set null',
    }),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyDateIdx: index('payments_company_date_idx').on(t.companyId, t.paymentDate),
    // The index a shift's takings are summed on.
    drawerShiftIdx: index('payments_drawer_shift_idx').on(t.drawerShiftId),
    // Named explicitly: the generated name would exceed Postgres's 63-byte limit.
    financialAccountFk: foreignKey({
      name: 'payments_financial_account_fk',
      columns: [t.financialAccountId],
      foreignColumns: [financialAccounts.id],
    }).onDelete('restrict'),
    amountPositive: check('payments_amount_positive', sql`${t.amountCents} > 0`),
    // Only money coming in can be undeposited. There is no such thing as
    // paying a vendor out of funds you have not banked yet, and allowing it
    // would let a disbursement post against Undeposited Funds and drive that
    // account negative with nothing to reconcile it against.
    undepositedIsReceipt: check(
      'payments_undeposited_is_receipt',
      sql`${t.financialAccountId} IS NOT NULL OR ${t.kind} = 'receipt'`,
    ),
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

/**
 * How a company wants its overdue invoices chased (Phase 43).
 *
 * One row per company, and **absent means off**. This is the only table in the
 * schema whose default behaviour sends email to somebody who is not a user of
 * this system, over the company's own name, without anybody present. So the
 * state you get by doing nothing has to be silence, and turning it on has to
 * be a deliberate act somebody can point at later.
 *
 * The numbers are a policy rather than constants in code because the right
 * cadence is not a fact about accounting — a builder chasing a homeowner and a
 * wholesaler chasing a chain do not want the same letters, and neither of them
 * wants to change a deployment to say so.
 */
export const chaseSettings = pgTable('chase_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),

  enabled: boolean('enabled').notNull().default(false),

  /** Days after the due date before the first chase. Zero is the day it falls due. */
  firstAfterDays: integer('first_after_days').notNull().default(3),
  /** Days between chases after the first. */
  everyDays: integer('every_days').notNull().default(14),
  /**
   * Chases before this stops and the debt becomes somebody's job.
   *
   * An invoice chased for ever is a relationship being ended by automation.
   */
  maxChases: integer('max_chases').notNull().default(3),
  /** Nothing below this is chased. A rounding difference is not worth an email. */
  minimumBalanceCents: bigint('minimum_balance_cents', { mode: 'number' }).notNull().default(500),
  /** Days of quiet after money lands. Somebody who part-paid has engaged. */
  quietDaysAfterPayment: integer('quiet_days_after_payment').notNull().default(5),
  /**
   * A ceiling on one day's run.
   *
   * Not a rate limit — Phase 42 has one of those, per address. This is a guard
   * against the shape of accident that only happens once: a company switches
   * chasing on for the first time with four years of unpaid invoices behind
   * it, and every customer they have ever had is emailed within a minute.
   */
  maxPerRun: integer('max_per_run').notNull().default(50),

  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
