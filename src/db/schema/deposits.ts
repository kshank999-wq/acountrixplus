import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  bigint,
  index,
  unique,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'
import { chartAccounts, financialAccounts } from './accounting'
import { journalEntries } from './ledger'
import { payments } from './receivables'

/**
 * Bank deposits and undeposited funds (spec §13: "cash/bank, credit cards,
 * transfers, **deposits**, **undeposited funds**, and reconciliation").
 *
 * ## The problem this exists to solve
 *
 * Three customers pay by cheque on Monday. On Thursday somebody walks all
 * three to the bank, and the statement shows **one** line for the total.
 *
 * Without this table the books hold three separate debits to Checking and the
 * bank holds one credit, so reconciliation has three items to match against
 * one and no way to say they are the same money. The usual workaround is to
 * record one lump receipt and lose which customer paid what — which breaks
 * the receivable, the statement, and the aging report all at once.
 *
 * Undeposited Funds is the account that holds the gap. A receipt debits it
 * instead of the bank; the deposit moves the batch across in one entry that
 * matches the statement line exactly. The customer detail survives on the
 * payments, and the bank sees the number it actually processed.
 *
 * ## Why the batch is a record and not a query
 *
 * "The receipts between these dates" would reproduce most deposits and be
 * wrong for the rest: a deposit is a decision about which cheques went in the
 * envelope, and two of Monday's three going on Thursday with the last held
 * back is ordinary. Reconciliation needs to match what happened, so what
 * happened has to be stored.
 */

/**
 * One trip to the bank.
 *
 * The journal entry is what the statement line matches, so the entry's total
 * is the deposit's total including any fee — never the sum of the receipts,
 * which is the gross figure the bank did not process.
 */
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Where the money landed. */
    financialAccountId: uuid('financial_account_id').notNull(),

    number: text('number').notNull(),
    depositDate: date('deposit_date').notNull(),
    reference: text('reference'),
    memo: text('memo'),

    /** Sum of the batched receipts, before other lines and fees. */
    receiptsCents: bigint('receipts_cents', { mode: 'number' }).notNull().default(0),
    /**
     * What actually hit the bank: receipts, plus any non-receipt lines, less
     * any fee. This is the figure reconciliation matches.
     */
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),

    /**
     * The receipts' currency (Phase 127).
     *
     * Phase 123 made a deposit single-currency by refusing to bank receipts
     * that disagree — a paying-in slip goes to one bank account and a bank
     * credits one currency. So the denomination has been well defined since
     * then and nothing wrote it down; ADR 0125 called that `unrecorded`.
     */
    currency: text('currency').notNull().default('USD'),
    /**
     * The same two figures in the company's own money, which is what posts.
     *
     * `createDeposit` credited Undeposited Funds the *face* `receiptsCents`
     * against a balance `recordPayment` had debited in functional money, so
     * banking a €500 receipt left $50 in a clearing account nothing could
     * clear. Each receipt is converted at its own recorded rate rather than one
     * rate for the batch: the receipts were taken on different days and the
     * ledger carries each at the rate of its own.
     */
    functionalReceiptsCents: bigint('functional_receipts_cents', { mode: 'number' })
      .notNull()
      .default(0),
    functionalTotalCents: bigint('functional_total_cents', { mode: 'number' })
      .notNull()
      .default(0),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    /**
     * Set when the deposit has been reversed. The row stays — a deposit that
     * was made and unwound is history, and deleting it would leave the
     * reversing entry pointing at nothing.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    numberUnique: unique('deposits_number_unique').on(t.companyId, t.number),
    companyDateIdx: index('deposits_company_date_idx').on(t.companyId, t.depositDate),
    // Named explicitly: the generated name would exceed Postgres's 63-byte
    // limit, and Postgres truncates silently rather than refusing.
    financialAccountFk: foreignKey({
      name: 'deposits_financial_account_fk',
      columns: [t.financialAccountId],
      foreignColumns: [financialAccounts.id],
    }).onDelete('restrict'),
    // A deposit of nothing is not a deposit. A negative one is a withdrawal
    // and belongs somewhere else.
    totalPositive: check('deposits_total_positive', sql`${t.totalCents} > 0`),
    // The functional twin is money, not an annotation (Phase 116, Phase 127).
    functionalTotalPositive: check(
      'deposits_functional_total_positive',
      sql`${t.functionalTotalCents} > 0`,
    ),
  }),
)

/**
 * One line of a deposit slip.
 *
 * Either a batched receipt (`paymentId`) or a direct line against an account
 * (`chartAccountId`) — a bank interest credit, or a processing fee deducted
 * before the money arrived. Exactly one of the two, because a line that is
 * both would post twice.
 */
export const depositItems = pgTable(
  'deposit_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id, { onDelete: 'cascade' }),

    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'restrict' }),
    chartAccountId: uuid('chart_account_id').references(() => chartAccounts.id, {
      onDelete: 'restrict',
    }),

    /**
     * Positive adds to the deposit, negative deducts from it.
     *
     * A processing fee is stored as the negative number it is, rather than as
     * a positive with a `kind` column saying to subtract it. The sign is the
     * whole of the distinction, and one place to get it wrong is better than
     * two.
     */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    memo: text('memo'),
  },
  (t) => ({
    depositIdx: index('deposit_items_deposit_idx').on(t.depositId),
    // A receipt belongs to one deposit. Depositing the same cheque twice is
    // the failure this prevents, and a unique index is the only place that can
    // be prevented without a race.
    paymentUnique: unique('deposit_items_payment_unique').on(t.paymentId),
    exactlyOneTarget: check(
      'deposit_items_one_target',
      sql`(${t.paymentId} IS NULL) <> (${t.chartAccountId} IS NULL)`,
    ),
    // A batched receipt carries its own amount, so a line pointing at one can
    // only be positive; only a direct line may be a deduction.
    receiptPositive: check(
      'deposit_items_receipt_positive',
      sql`${t.paymentId} IS NULL OR ${t.amountCents} > 0`,
    ),
    nonZero: check('deposit_items_non_zero', sql`${t.amountCents} <> 0`),
  }),
)
