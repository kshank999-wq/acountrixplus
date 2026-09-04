import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'
import { bills, customers, invoices, vendors } from './receivables'
import { journalEntries } from './ledger'

/**
 * Credit notes and write-offs (spec §13: "customers, invoices, **credits**,
 * payments, aging, statements, **write-offs**").
 *
 * ## Two things that look alike and are not
 *
 * Both reduce what a customer owes without money arriving, which is why
 * software conflates them constantly. They mean opposite things:
 *
 * | | Credit note | Write-off |
 * | --- | --- | --- |
 * | What happened | The company agreed they owe less | They owe it and will not pay |
 * | Revenue | Reversed — it was never earned | Kept — it was earned and lost |
 * | The other side | Revenue (or contra-revenue) | Bad Debt expense |
 * | On a P&L | Revenue goes down | Expense goes up |
 *
 * A company that writes off bad debt as a credit note shows lower revenue and
 * no bad debt, so its margins look fine and its collections problem is
 * invisible. That is the failure this separation exists to prevent, and it is
 * why a write-off is an operation on an invoice rather than a kind of credit
 * note.
 */

/**
 * Which direction a credit runs (Phase 12, spec §13's AP list: "vendors,
 * bills, **credits**, payments, aging").
 *
 * One table for both, the same way `payments` holds receipts and
 * disbursements. A vendor credit is the exact mirror of a customer one — the
 * supplier agreed we owe less — and giving it a separate table would mean two
 * copies of the application logic, the aging treatment, and the cash-basis
 * story, which would then drift apart the first time one was fixed.
 */
export const creditPartyEnum = pgEnum('credit_party', ['customer', 'vendor'])

export const creditNoteStatusEnum = pgEnum('credit_note_status', [
  'draft',
  /** Issued, with some or all of it not yet applied to an invoice. */
  'open',
  'applied',
  'void',
])

/**
 * A credit issued to a customer.
 *
 * Mirrors an invoice deliberately — lines against revenue accounts, a journal
 * entry, a number from the same sequence machinery. A credit note *is* a
 * source document, and giving it a lesser shape than the invoice it reverses
 * would make it the odd one out in every report that walks documents.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    party: creditPartyEnum('party').notNull().default('customer'),
    /** Exactly one of these is set, matching `party`. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),

    number: text('number').notNull(),
    issueDate: date('issue_date').notNull(),

    /**
     * The invoice this was raised against, when there is one.
     *
     * Optional because a credit can be issued standalone — a goodwill gesture
     * before the next invoice exists. When set, the lines default to that
     * invoice's accounts so the reversal lands where the revenue did.
     */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    /** The vendor-side equivalent: the bill this credit was raised against. */
    billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),

    status: creditNoteStatusEnum('status').notNull().default('open'),

    /**
     * What this credit is denominated in (Phase 63).
     *
     * Inherited from the document it credits, never chosen: a credit note
     * reverses part of a document that already exists, and a €4,000 invoice is
     * reduced by €500 rather than by "$540 worth of euro". The company's own
     * currency for a standalone credit, which is what every credit note raised
     * before this phase was — `refuseForeign` saw to that.
     */
    currency: text('currency').notNull().default('USD'),
    /** Millionths, foreign → functional. Fixed at issue, never recomputed. */
    exchangeRateMillionths: bigint('exchange_rate_millionths', { mode: 'number' })
      .notNull()
      .default(1_000_000),
    /** `totalCents` converted line by line. What the ledger posted. */
    functionalTotalCents: bigint('functional_total_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** `remainingCents` at this note's own rate. */
    functionalRemainingCents: bigint('functional_remaining_cents', { mode: 'number' })
      .notNull()
      .default(0),

    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull().default(0),
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    /** How much of it is still available to apply. */
    remainingCents: bigint('remaining_cents', { mode: 'number' }).notNull().default(0),

    reason: text('reason'),
    memo: text('memo'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('credit_notes_number_unique').on(t.companyId, t.number),
    customerIdx: index('credit_notes_customer_idx').on(t.companyId, t.customerId),
    vendorIdx: index('credit_notes_vendor_idx').on(t.companyId, t.vendorId),
    openIdx: index('credit_notes_open_idx').on(t.companyId, t.status),
    // The party column and the party column have to agree. Without this a
    // vendor credit could carry a customer, and every report that joins on one
    // of the two would quietly return a different set of rows.
    partyMatches: check(
      'credit_notes_party_matches',
      sql`(${t.party} = 'customer' AND ${t.customerId} IS NOT NULL AND ${t.vendorId} IS NULL)
          OR (${t.party} = 'vendor' AND ${t.vendorId} IS NOT NULL AND ${t.customerId} IS NULL)`,
    ),
    /**
     * The two sides reach zero together (Phase 116).
     *
     * A fully spent credit note is worth nothing to anybody, so a functional
     * remainder on one is a promise the business has already kept and is still
     * carrying on a control account.
     */
    functionalRemainingSane: check(
      'credit_notes_functional_remaining_sane',
      sql`(${t.remainingCents} = 0) = (${t.functionalRemainingCents} = 0) AND ${t.functionalRemainingCents} >= 0`,
    ),
    documentMatches: check(
      'credit_notes_document_matches',
      sql`(${t.party} = 'customer' AND ${t.billId} IS NULL)
          OR (${t.party} = 'vendor' AND ${t.invoiceId} IS NULL)`,
    ),
    totalPositive: check('credit_notes_total_positive', sql`${t.totalCents} > 0`),
    // A credit note's amounts are stored positive and its *direction* is what
    // makes it a credit. Storing a negative invoice instead would mean every
    // aggregate in the system needing to know the sign convention.
    remainingSane: check(
      'credit_notes_remaining_sane',
      sql`${t.remainingCents} >= 0 AND ${t.remainingCents} <= ${t.totalCents}`,
    ),
  }),
)

export const creditNoteLines = pgTable(
  'credit_note_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),

    chartAccountId: uuid('chart_account_id')
      .notNull()
      .references(() => chartAccounts.id, { onDelete: 'restrict' }),

    description: text('description').notNull(),
    quantityMilli: integer('quantity_milli').notNull().default(1000),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    noteIdx: index('credit_note_lines_note_idx').on(t.creditNoteId),
  }),
)

/**
 * Applying part of a credit note to an invoice.
 *
 * The same shape as `payment_applications`, and for the same reason: one
 * credit can settle several invoices and one invoice can be settled by several
 * credits. It also means the cash-basis transformation has a single
 * consistent way to ask "what reduced this invoice, and against what".
 */
export const creditApplications = pgTable(
  'credit_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),
    /** Exactly one of these, matching the credit note's party. */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id').references(() => bills.id, { onDelete: 'cascade' }),

    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedOn: date('applied_on').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    noteIdx: index('credit_applications_note_idx').on(t.creditNoteId),
    invoiceIdx: index('credit_applications_invoice_idx').on(t.invoiceId),
    billIdx: index('credit_applications_bill_idx').on(t.billId),
    amountPositive: check('credit_applications_amount_positive', sql`${t.amountCents} > 0`),
    exactlyOneDocument: check(
      'credit_applications_one_document',
      sql`(${t.invoiceId} IS NULL) <> (${t.billId} IS NULL)`,
    ),
  }),
)

/**
 * A receivable given up on.
 *
 * Its own table rather than a nullable column on `invoices`, because a
 * write-off has things to say that an invoice has nowhere to put: why, who
 * decided, and what happens if the money later turns up. A recovery is
 * recorded here too, so "we wrote this off in March and they paid in
 * September" is one row's history rather than two unrelated events.
 */
export const invoiceWriteOffs = pgTable(
  'invoice_write_offs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),

    writtenOffOn: date('written_off_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),

    /**
     * The invoice's own currency (Phase 127).
     *
     * `amount_cents` is the invoice's face amount — `writeOffInvoice` converts
     * on its way to the ledger and stores the unconverted figure here. ADR 0125
     * traced that and classified the column `unrecorded`; this writes the answer
     * down instead of leaving it to be re-derived by reading the write path.
     */
    currency: text('currency').notNull().default('USD'),
    /**
     * The loss the books actually carry, at the invoice's own rate.
     *
     * `writeOffInvoice` has always computed this — `relieveFunctional(invoice,
     * amountCents).functionalCents` — posted it to bad debt, and thrown it away.
     * Phase 65 and Phase 112 both found the same shape: a conversion done, used
     * once, and discarded.
     *
     * Keeping it is what lets a recovery reverse the figure that was posted.
     * Without it `recoverWriteOff` had nothing to reverse but the face amount,
     * so a fully recovered €2,500 write-off left $250 of expense on the books.
     */
    functionalAmountCents: bigint('functional_amount_cents', { mode: 'number' }).notNull(),

    /** Required. A write-off without a stated reason is an unexplained loss. */
    reason: text('reason').notNull(),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    /** Set if the money later arrived after all. */
    recoveredOn: date('recovered_on'),
    recoveredCents: bigint('recovered_cents', { mode: 'number' }),
    /**
     * What the recovery took off bad debt, in the company's own money.
     *
     * Moves with `recoveredCents` and is never derived from it afterwards —
     * Phase 116's rule, for the same reason: the difference between converting
     * the remainder and remaining what was converted is a cent, every time.
     */
    functionalRecoveredCents: bigint('functional_recovered_cents', { mode: 'number' })
      .notNull()
      .default(0),
    recoveryJournalEntryId: uuid('recovery_journal_entry_id'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One write-off per invoice. Writing the same debt off twice would double
    // the bad-debt expense, and the constraint is a better guard than a check
    // two concurrent requests could both pass.
    // Named explicitly: the generated name is 66 bytes, and Postgres truncates
    // silently at 63 rather than refusing — which makes the constraint's real
    // name unpredictable and, with a near-identical sibling, collidable.
    recoveryEntryFk: foreignKey({
      name: 'invoice_write_offs_recovery_entry_fk',
      columns: [t.recoveryJournalEntryId],
      foreignColumns: [journalEntries.id],
    }).onDelete('set null'),
    invoiceUnique: unique('invoice_write_offs_invoice_unique').on(t.invoiceId),
    companyIdx: index('invoice_write_offs_company_idx').on(t.companyId, t.writtenOffOn),
    amountPositive: check('invoice_write_offs_amount_positive', sql`${t.amountCents} > 0`),
    // Phase 116's shape: the functional twin is real money, not an optional
    // annotation, so the database refuses a row that leaves it unset or negative
    // rather than a check noticing later (Phase 116 — a constraint beats a check).
    functionalSane: check(
      'invoice_write_offs_functional_sane',
      sql`${t.functionalAmountCents} > 0 AND ${t.functionalRecoveredCents} >= 0`,
    ),
    reasonNotBlank: check('invoice_write_offs_reason_not_blank', sql`length(trim(${t.reason})) > 0`),
  }),
)

/**
 * A statement sent to a customer (spec §13 "statements").
 *
 * Recorded rather than only rendered, because "what did we send them and when"
 * is the first question in any collections conversation, and a statement
 * regenerated from today's data is not the document the customer is looking at.
 * The figures are frozen onto the row.
 */
export const customerStatements = pgTable(
  'customer_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),

    /** Open-item lists what is unpaid; balance-forward carries a total in. */
    kind: text('kind', { enum: ['open_item', 'balance_forward'] })
      .notNull()
      .default('open_item'),

    periodStart: date('period_start'),
    asOfDate: date('as_of_date').notNull(),

    openingBalanceCents: bigint('opening_balance_cents', { mode: 'number' }).notNull().default(0),
    closingBalanceCents: bigint('closing_balance_cents', { mode: 'number' }).notNull().default(0),

    /** The lines as sent, frozen. */
    figures: jsonb('figures').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * When it actually went (Phase 55).
     *
     * Null until a send happens. Between Phase 11 and Phase 55 nothing ever
     * wrote this, while `sentTo` was filled in at *save* time — so the screen
     * showed an address the document had never been sent to.
     */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Where it went. Written by the send, never by the save. */
    sentTo: text('sent_to'),
    /**
     * The customer's door onto this one statement (Phase 55).
     *
     * Minted on the first send, never rotated, so a link filed in an inbox two
     * years ago still opens. Per statement rather than per customer: a link
     * that opened "this customer's statements" would let whoever holds June's
     * letter read December's.
     */
    shareToken: text('share_token'),
    /** How many times it went. "We have sent this three times" is the fact. */
    sendCount: integer('send_count').notNull().default(0),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    customerIdx: index('customer_statements_customer_idx').on(t.companyId, t.customerId, t.asOfDate),
    shareTokenIdx: uniqueIndex('customer_statements_share_token_idx').on(t.shareToken),
  }),
)
