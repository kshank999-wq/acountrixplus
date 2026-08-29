import { pgTable, uuid, text, date, timestamp, bigint, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { financialAccounts } from './accounting'
import { journalEntries } from './ledger'

/**
 * Money handed back, whichever way it went (spec §13, §16, Phase 68).
 *
 * ## Why this has a file of its own
 *
 * Phase 67 wrote `retainer_refunds` in the time-billing schema, which was the
 * only refund that had a record. By the end of that phase the system had three
 * refunds and three answers to "where is it written down": a table, a bare
 * journal entry, and nothing at all because the operation did not exist.
 *
 * A refund is not a fact about retainers, or about payables. It is one thing
 * that happens to three kinds of balance, so it lives with none of them.
 *
 * ## The three amounts, and why the direction is one of the columns
 *
 * A foreign refund is three different facts:
 *
 * - **amount** — what changed hands, in the other party's currency. They are
 *   owed, or they owe, in their money.
 * - **carried** — what left the balance being cleared, in the company's own
 *   money, at the rate that balance has been carried at since it was recorded.
 * - **cash** — what actually moved through the bank, at the rate on the day.
 *   The number the statement will show and the reconciliation needs.
 *
 * The gap between the last two is realised. Which way that gap signs depends
 * entirely on **which side the balance sits**: giving back money you were
 * holding debits a liability, while getting back money you were owed debits the
 * bank. Nothing in the amounts themselves says which, and a swapped sign still
 * balances — so the direction is stored, and `refunds_balances` makes the
 * database refuse a row whose amounts do not add up the way it claims.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /**
     * Polymorphic, the way `journal_entries` has been since Phase 2.
     *
     * A retainer, a customer's overpayment and a vendor credit are different
     * records; a nullable column each would put "exactly one of these is set"
     * into every query that reads this table.
     */
    subjectType: text('subject_type', {
      enum: ['retainer', 'payment', 'credit_note'],
    }).notNull(),
    subjectId: uuid('subject_id').notNull(),

    /** 'out' — the business handed money back. 'in' — the business got it back. */
    direction: text('direction', { enum: ['out', 'in'] }).notNull(),

    /** In the other party's currency. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /**
     * What money `amountCents` is (Phase 69).
     *
     * Phase 68 wrote "in the other party's currency" and did not keep it, so
     * every reader had to join back to the subject to find out — Phase 65's
     * defect a fifth time, noticed the moment a reversal had to print the
     * figure back to somebody.
     */
    currency: text('currency').notNull().default('USD'),
    /** Functional, off the balance being cleared, at its carried rate. */
    carriedCents: bigint('carried_cents', { mode: 'number' }).notNull(),
    /** Functional, through the bank, at the rate on the day. */
    cashCents: bigint('cash_cents', { mode: 'number' }).notNull(),
    /** Positive is a gain. Kept rather than re-derived — the sign is the risk. */
    realisedCents: bigint('realised_cents', { mode: 'number' }).notNull().default(0),
    exchangeRateMillionths: bigint('exchange_rate_millionths', { mode: 'number' })
      .notNull()
      .default(1_000_000),

    refundedOn: date('refunded_on').notNull(),
    reference: text('reference'),
    financialAccountId: uuid('financial_account_id').references(() => financialAccounts.id, {
      onDelete: 'set null',
    }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Taken back (Phase 69).
     *
     * Marked rather than deleted, for the reason Phase 52 gave when it voided
     * payments: the row is the record of what somebody did, and readers exclude
     * it instead of losing the history.
     *
     * No reversing-entry column: `voidJournalEntry` marks the original entry
     * void and balance queries filter on posted, which is the ledger's way
     * since Phase 2. `journalEntryId` above already names it.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    subjectIdx: index('refunds_subject_idx').on(t.subjectType, t.subjectId),
    companyDateIdx: index('refunds_company_date_idx').on(t.companyId, t.refundedOn),
    openIdx: index('refunds_open_idx').on(t.companyId, t.voidedAt),
    amountPositive: check('refunds_amount_positive', sql`${t.amountCents} > 0`),
    subjectKnown: check(
      'refunds_subject_known',
      sql`${t.subjectType} IN ('retainer', 'payment', 'credit_note')`,
    ),
    directionKnown: check('refunds_direction_known', sql`${t.direction} IN ('out', 'in')`),
    // Going out the balance is debited and covers the cash plus the gap; coming
    // in the cash is debited and covers the balance plus the gap.
    balances: check(
      'refunds_balances',
      sql`(${t.direction} = 'out' AND ${t.carriedCents} = ${t.cashCents} + ${t.realisedCents})
          OR
          (${t.direction} = 'in' AND ${t.cashCents} = ${t.carriedCents} + ${t.realisedCents})`,
    ),
  }),
)
